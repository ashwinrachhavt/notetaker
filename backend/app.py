import os
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from bson import ObjectId
from typing import List

try:
    # Load environment variables from backend/.env when running locally
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(Path(__file__).with_name(".env"), override=False)
except Exception:
    # If python-dotenv isn't installed yet, continue with system envs
    pass


def _get_mongo_client() -> MongoClient:
    uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    return MongoClient(uri)


def _get_database(client: MongoClient):
    db_name = os.getenv("MONGODB_DB", "notes_db")
    return client[db_name]


class NoteCreate(BaseModel):
    text: str
    source_url: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @validator("text")
    def text_must_have_content(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("text must not be empty")
        return trimmed


app = FastAPI(title="Note Taker API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
mongo_client = _get_mongo_client()
database = _get_database(mongo_client)


@app.get("/health")
def health_check() -> Dict[str, str]:
    try:
        mongo_client.admin.command("ping")
        return {"status": "ok"}
    except PyMongoError as error:
        raise HTTPException(status_code=500, detail=str(error))


import httpx
import time

@app.post("/scrape-website", status_code=201)
def scrape_website(url: Dict[str, str]):
    target = url.get("url")
    if not target:
        raise HTTPException(status_code=400, detail="url is required")
    # Prefer env override; default to localhost for non-container dev
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "http://localhost:8010").rstrip("/")
    try:
        # Firecrawl /scrape typically responds synchronously with { data: { markdown?, html? } }
        r = httpx.post(
            f"{firecrawl}/scrape",
            json={"url": target, "formats": ["markdown", "html"]},
            timeout=60,
        )
        r.raise_for_status()
        payload = r.json() or {}

        def _find_first(obj, keys):
            if isinstance(obj, dict):
                # direct hit
                for k in keys:
                    v = obj.get(k)
                    if isinstance(v, str) and v.strip():
                        return v
                # nested
                for v in obj.values():
                    res = _find_first(v, keys)
                    if res:
                        return res
            elif isinstance(obj, list):
                for it in obj:
                    res = _find_first(it, keys)
                    if res:
                        return res
            return None

        def _html_to_md_basic(html_str: str) -> str:
            import re
            text = html_str
            text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.I)
            for i in range(6, 0, -1):
                text = re.sub(rf"<\s*h{i}[^>]*>(.*?)<\s*/h{i}\s*>", lambda m: "#"*i + " " + re.sub(r"<[^>]+>", "", m.group(1)) + "\n\n", text, flags=re.I|re.S)
            text = re.sub(r"<\s*li[^>]*>(.*?)<\s*/li\s*>", lambda m: "- " + re.sub(r"<[^>]+>", "", m.group(1)) + "\n", text, flags=re.I|re.S)
            def _link(m):
                href = m.group(1) or ""
                label = re.sub(r"<[^>]+>", "", m.group(2) or "")
                return f"[{label}]({href})"
            text = re.sub(r"<a[^>]*href=\"([^\"]*)\"[^>]*>(.*?)<\s*/a\s*>", _link, text, flags=re.I|re.S)
            text = re.sub(r"<\s*(p|div|section|article|header|footer)[^>]*>", "\n\n", text, flags=re.I)
            text = re.sub(r"<\s*/\s*(p|div|section|article|header|footer)\s*>", "\n\n", text, flags=re.I)
            text = re.sub(r"<[^>]+>", "", text)
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            return text

        markdown = _find_first(payload, ["markdown", "content_markdown", "markdown_text"]) or ""
        if not markdown:
            html_val = _find_first(payload, ["html", "content_html", "contentHtml"]) or ""
            if html_val:
                markdown = _html_to_md_basic(html_val)
        if not markdown:
            # last resort plain text
            txt = _find_first(payload, ["text", "content", "plainText", "textContent"]) or ""
            markdown = txt.strip()
        doc = {
            "text": markdown,
            "source_url": target,
            "metadata": {"firecrawl": "scrape"},
            "created_at": datetime.utcnow(),
        }
        inserted = database.notes.insert_one(doc)
        return {"id": str(inserted.inserted_id), "markdown": markdown}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Firecrawl error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/crawl-website", status_code=201)
def crawl_website(payload: Dict[str, Any]) -> Dict[str, Any]:
    target = payload.get("url")
    if not target:
        raise HTTPException(status_code=400, detail="url is required")
    max_depth = int(payload.get("maxDepth", 1))
    limit = int(payload.get("limit", 10))
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "http://localhost:8010").rstrip("/")
    try:
        # Start crawl
        start = httpx.post(
            f"{firecrawl}/crawl",
            json={
                "url": target,
                "maxDepth": max_depth,
                "limit": limit,
                "scrapeOptions": {"formats": ["markdown", "html"]},
            },
            timeout=30,
        )
        start.raise_for_status()
        start_json: Dict[str, Any] = {}
        try:
            start_json = start.json() or {}
        except Exception:
            start_json = {}
        crawl_id = (
            start_json.get("id")
            or start_json.get("crawl_id")
            or start_json.get("crawlId")
            or start_json.get("jobId")
            or start_json.get("taskId")
            or (start_json.get("data") or {}).get("id")
        )
        if not crawl_id:
            loc = start.headers.get("Location") or start.headers.get("location") or ""
            if "/crawl/" in loc:
                crawl_id = loc.rstrip("/").split("/")[-1]
        if not crawl_id:
            # Surface minimal debug info to help diagnose mismatched server versions
            raise HTTPException(
                status_code=502,
                detail=f"Crawl did not return an id (keys: {list(start_json.keys())})",
            )

        # Poll for completion
        deadline = time.monotonic() + 180  # up to 3 minutes
        status: Dict[str, Any] = {}
        while True:
            resp = httpx.get(f"{firecrawl}/crawl/{crawl_id}", timeout=30)
            resp.raise_for_status()
            status = resp.json() or {}
            if status.get("status") in {"completed", "failed"}:
                break
            if time.monotonic() > deadline:
                raise HTTPException(status_code=504, detail="Crawl timed out")
            time.sleep(1.2)

        if status.get("status") != "completed":
            raise HTTPException(status_code=500, detail="Crawl failed")

        pages: List[Dict[str, Any]] = status.get("data") or []
        docs: List[Dict[str, Any]] = []
        for page in pages:
            content = page.get("markdown") or page.get("html") or ""
            url = page.get("url")
            if not content:
                continue
            docs.append(
                {
                    "text": content,
                    "source_url": url,
                    "metadata": {"firecrawl": "crawl", "crawl_id": crawl_id},
                    "created_at": datetime.utcnow(),
                }
            )

        if not docs:
            return {"inserted_count": 0, "ids": [], "crawl_id": crawl_id}

        result = database.notes.insert_many(docs)
        ids = [str(_id) for _id in result.inserted_ids]
        return {"inserted_count": len(ids), "ids": ids, "crawl_id": crawl_id}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Firecrawl error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/crawl-start")
def crawl_start(payload: Dict[str, Any]) -> Dict[str, Any]:
    target = payload.get("url")
    if not target:
        raise HTTPException(status_code=400, detail="url is required")
    max_depth = int(payload.get("maxDepth", 1))
    limit = int(payload.get("limit", 10))
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "http://localhost:8010").rstrip("/")
    try:
        start = httpx.post(
            f"{firecrawl}/crawl",
            json={
                "url": target,
                "maxDepth": max_depth,
                "limit": limit,
                "scrapeOptions": {"formats": ["markdown", "html"]},
            },
            timeout=30,
        )
        start.raise_for_status()
        data = start.json() if start.headers.get("content-type", "").startswith("application/json") else {}
        crawl_id = (
            (data or {}).get("id")
            or (data or {}).get("crawl_id")
            or (data or {}).get("crawlId")
            or (data or {}).get("jobId")
            or (data or {}).get("taskId")
            or ((data or {}).get("data") or {}).get("id")
        )
        if not crawl_id:
            loc = start.headers.get("Location") or start.headers.get("location") or ""
            if "/crawl/" in loc:
                crawl_id = loc.rstrip("/").split("/")[-1]
        if not crawl_id:
            raise HTTPException(status_code=502, detail="Crawl did not return an id")
        return {"crawl_id": crawl_id}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Firecrawl error: {e}")


@app.get("/crawl-status/{crawl_id}")
def crawl_status(crawl_id: str) -> Dict[str, Any]:
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "http://localhost:8010").rstrip("/")
    try:
        resp = httpx.get(f"{firecrawl}/crawl/{crawl_id}", timeout=30)
        resp.raise_for_status()
        return resp.json() or {}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Firecrawl error: {e}")


@app.post("/crawl-save/{crawl_id}")
def crawl_save(crawl_id: str) -> Dict[str, Any]:
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "http://localhost:8010").rstrip("/")
    try:
        resp = httpx.get(f"{firecrawl}/crawl/{crawl_id}", timeout=30)
        resp.raise_for_status()
        status: Dict[str, Any] = resp.json() or {}
        if status.get("status") != "completed":
            raise HTTPException(status_code=409, detail="Crawl not completed yet")
        pages: List[Dict[str, Any]] = status.get("data") or []
        docs: List[Dict[str, Any]] = []
        for page in pages:
            content = page.get("markdown") or page.get("html") or ""
            url = page.get("url")
            if not content:
                continue
            docs.append(
                {
                    "text": content,
                    "source_url": url,
                    "metadata": {"firecrawl": "crawl", "crawl_id": crawl_id},
                    "created_at": datetime.utcnow(),
                }
            )
        if not docs:
            return {"inserted_count": 0, "ids": []}
        result = database.notes.insert_many(docs)
        ids = [str(_id) for _id in result.inserted_ids]
        return {"inserted_count": len(ids), "ids": ids}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Firecrawl error: {e}")

def _serialize_note(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(doc.get("_id")),
        "text": doc.get("text", ""),
        "source_url": doc.get("source_url"),
        "metadata": doc.get("metadata", {}),
        "created_at": doc.get("created_at"),
    }

@app.post("/notes", status_code=201)
def create_note(payload: NoteCreate) -> Dict[str, str]:
    document = {
        "text": payload.text,
        "source_url": payload.source_url,
        "metadata": payload.metadata,
        "created_at": datetime.utcnow(),
    }

    try:
        inserted = database.notes.insert_one(document)
    except PyMongoError as error:
        raise HTTPException(status_code=500, detail=f"Failed to store note: {error}")

    return {"id": str(inserted.inserted_id)}


@app.get("/notes")
def list_notes(
    q: Optional[str] = Query(default=None, description="Full-text search in note text"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> Dict[str, Any]:
    try:
        filt: Dict[str, Any] = {}
        if q:
            filt = {"text": {"$regex": q, "$options": "i"}}
        cursor = (
            database.notes.find(filt)
            .sort("created_at", -1)
            .skip(int(skip))
            .limit(int(limit))
        )
        items = [_serialize_note(d) for d in cursor]
        total = database.notes.count_documents(filt)
        return {"items": items, "total": total, "skip": skip, "limit": limit}
    except PyMongoError as error:
        raise HTTPException(status_code=500, detail=f"Failed to list notes: {error}")


@app.get("/notes/{note_id}")
def get_note(note_id: str) -> Dict[str, Any]:
    try:
        if not ObjectId.is_valid(note_id):
            raise HTTPException(status_code=400, detail="Invalid note id")
        doc = database.notes.find_one({"_id": ObjectId(note_id)})
        if not doc:
            raise HTTPException(status_code=404, detail="Note not found")
        return _serialize_note(doc)
    except PyMongoError as error:
        raise HTTPException(status_code=500, detail=f"Failed to fetch note: {error}")


@app.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: str) -> None:
    try:
        if not ObjectId.is_valid(note_id):
            raise HTTPException(status_code=400, detail="Invalid note id")
        result = database.notes.delete_one({"_id": ObjectId(note_id)})
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Note not found")
        return None
    except PyMongoError as error:
        raise HTTPException(status_code=500, detail=f"Failed to delete note: {error}")


# Static UI at /ui (and redirect from /)
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/ui", StaticFiles(directory=str(frontend_dir), html=True), name="ui")


@app.get("/")
def root_redirect():
    return RedirectResponse(url="/ui/")
