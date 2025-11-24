import os
import hashlib
from urllib.parse import urlparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
from pymongo import MongoClient
from pymongo.errors import PyMongoError, DuplicateKeyError
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

# -----------------------------
# Indexes for new collections
# -----------------------------
def ensure_indexes(db):
    try:
        # documents
        db.documents.create_index([("hash", 1)], unique=True, name="uniq_hash")
        db.documents.create_index([("captured_at", -1)], name="captured_desc")
        db.documents.create_index([("day_bucket", -1)], name="day_bucket")
        db.documents.create_index([("captured_hour", 1)], name="captured_hour")
        db.documents.create_index([("topics.primary", 1), ("captured_at", -1)], name="topic_time")
        db.documents.create_index([("source_url", 1)], name="source_url")
        db.documents.create_index([("canonical_url", 1)], name="canonical_url")
        try:
            db.documents.create_index([( "cleaned_text", "text" ), ( "title", "text" )], name="text_index")
        except Exception:
            # text index can fail on some deployments; ignore
            pass

        # doc_chunks
        db.doc_chunks.create_index([("doc_id", 1), ("idx", 1)], name="doc_idx")
        db.doc_chunks.create_index([("captured_at", -1)], name="chunk_time")
        db.doc_chunks.create_index([("day_bucket", -1)], name="chunk_day")
        db.doc_chunks.create_index([("topics.primary", 1)], name="chunk_topic")

        # topics
        db.topics.create_index([("slug", 1)], unique=True, name="topic_slug")
        db.topics.create_index([("parent_id", 1)], name="topic_parent")

        # sessions, daily_rollups, agent_runs
        db.sessions.create_index([("start_at", 1), ("end_at", 1)], name="session_range")
        db.daily_rollups.create_index([("date", -1)], name="day_desc")
        db.agent_runs.create_index([("status", 1), ("started_at", -1)], name="run_status_time")
    except Exception:
        # Keep API boot resilient in dev
        pass


ensure_indexes(database)


@app.get("/health")
def health_check() -> Dict[str, str]:
    try:
        mongo_client.admin.command("ping")
        return {"status": "ok"}
    except PyMongoError as error:
        raise HTTPException(status_code=500, detail=str(error))


import httpx
import time

"""
AI-driven ingestion schema models and helpers
"""

class TopicLabel(BaseModel):
    label: str
    score: Optional[float] = None
    path: Optional[List[str]] = None
    topic_id: Optional[str] = None


class DocSummary(BaseModel):
    short: Optional[str] = None
    bullets: Optional[List[str]] = None
    key_points: Optional[List[str]] = None


class Entity(BaseModel):
    type: Optional[str] = None
    text: str
    salience: Optional[float] = None


class DocumentIngestChunk(BaseModel):
    idx: int
    text: str
    tokens: Optional[int] = None
    section: Optional[str] = None
    char_start: Optional[int] = None
    char_end: Optional[int] = None
    embedding: Optional[List[float]] = None

    @validator("idx")
    def idx_nonneg(cls, v):
        if v < 0:
            raise ValueError("idx must be >= 0")
        return v

    @validator("text")
    def chunk_text_not_empty(cls, v):
        if not (v or "").strip():
            raise ValueError("chunk text must not be empty")
        return v


class DocumentIngest(BaseModel):
    source_url: str
    canonical_url: Optional[str] = None
    title: Optional[str] = None
    content_type: Optional[str] = None
    lang: Optional[str] = None
    raw_html: Optional[str] = None
    raw_markdown: Optional[str] = None
    cleaned_text: str
    tokens: Optional[int] = None
    hash: Optional[str] = None
    summary: Optional[DocSummary] = None
    topics: Optional[Dict[str, Any]] = None
    entities: Optional[List[Entity]] = None
    tags: Optional[List[str]] = None
    embedding: Optional[List[float]] = None
    captured_at: Optional[datetime] = None
    published_at: Optional[datetime] = None
    processed_at: Optional[datetime] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    chunks: List[DocumentIngestChunk] = Field(default_factory=list)
    session_id: Optional[str] = None
    agent_run_id: Optional[str] = None

    @validator("cleaned_text")
    def cleaned_text_not_empty(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("cleaned_text must not be empty")
        return v.strip()

    @validator("source_url")
    def source_url_required(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("source_url required")
        return v


def _maybe_object_id(val: Optional[str]) -> Optional[ObjectId]:
    if not val:
        return None
    try:
        return ObjectId(val) if ObjectId.is_valid(val) else None
    except Exception:
        return None


def _token_count(text: str) -> int:
    try:
        return len((text or "").split())
    except Exception:
        return 0


def _sha256_hex(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _start_of_day_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)


def _domain_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    try:
        return urlparse(url).netloc or None
    except Exception:
        return None


def create_document_and_chunks(db, payload: DocumentIngest) -> Dict[str, Any]:
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    captured_at = payload.captured_at or now
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    day_bucket = _start_of_day_utc(captured_at)
    captured_hour = captured_at.hour

    cleaned_text = payload.cleaned_text
    content_hash = payload.hash or _sha256_hex(cleaned_text)
    tokens = payload.tokens if payload.tokens is not None else _token_count(cleaned_text)
    canonical = payload.canonical_url or payload.source_url
    domain = _domain_from_url(canonical)

    doc: Dict[str, Any] = {
        "source_url": payload.source_url,
        "canonical_url": canonical,
        "domain": domain,
        "title": payload.title,
        "content_type": payload.content_type or "web",
        "lang": payload.lang,
        "raw_html": payload.raw_html,
        "raw_markdown": payload.raw_markdown,
        "cleaned_text": cleaned_text,
        "tokens": tokens,
        "hash": content_hash,
        "summary": (payload.summary.dict() if payload.summary else None),
        "topics": payload.topics,
        "entities": [e.dict() for e in (payload.entities or [])],
        "tags": payload.tags or [],
        "embedding": payload.embedding,
        "captured_at": captured_at,
        "captured_hour": captured_hour,
        "day_bucket": day_bucket,
        "published_at": payload.published_at,
        "processed_at": payload.processed_at or now,
        "created_at": now,
        "updated_at": now,
        "session_id": _maybe_object_id(payload.session_id),
        "agent_run_id": _maybe_object_id(payload.agent_run_id),
        "metadata": payload.metadata or {},
    }

    duplicate = False
    try:
        res = db.documents.insert_one(doc)
        doc_id = res.inserted_id
    except DuplicateKeyError:
        duplicate = True
        existing = db.documents.find_one({"hash": content_hash}, {"_id": 1})
        if not existing:
            raise HTTPException(status_code=409, detail="Duplicate content but missing record")
        doc_id = existing["_id"]

    chunk_ids: List[str] = []
    inserted_chunks_for_qdrant: List[Dict[str, Any]] = []
    if payload.chunks:
        chunk_docs: List[Dict[str, Any]] = []
        for ch in payload.chunks:
            ctokens = ch.tokens if ch.tokens is not None else _token_count(ch.text)
            chunk_docs.append(
                {
                    "doc_id": doc_id,
                    "idx": ch.idx,
                    "text": ch.text,
                    "tokens": ctokens,
                    "section": ch.section,
                    "char_start": ch.char_start,
                    "char_end": ch.char_end,
                    "embedding": ch.embedding,
                    "topics": None,
                    "captured_at": captured_at,
                    "captured_hour": captured_hour,
                    "day_bucket": day_bucket,
                    "created_at": now,
                }
            )
        if chunk_docs:
            r = db.doc_chunks.insert_many(chunk_docs)
            chunk_ids = [str(i) for i in r.inserted_ids]
            # align inserted ids back to docs for qdrant payload
            for _id, chdoc in zip(r.inserted_ids, chunk_docs):
                tmp = dict(chdoc)
                tmp["_id"] = _id
                inserted_chunks_for_qdrant.append(tmp)

    # Qdrant upserts (best-effort)
    try:
        if qdrant_mgr and getattr(qdrant_mgr, 'enabled', False):
            # doc-level
            if payload.embedding:
                q_payload = {
                    "doc_id": str(doc_id),
                    "type": "doc",
                    "source_url": payload.source_url,
                    "canonical_url": canonical,
                    "domain": domain,
                    "title": payload.title,
                    "topics_primary": ((payload.topics or {}).get("primary") if payload.topics else None),
                    "captured_at": captured_at.isoformat(),
                    "day_bucket_str": day_bucket.date().isoformat(),
                    "captured_hour": captured_hour,
                }
                qdrant_mgr.upsert_doc(doc_id, payload.embedding, q_payload)
            # chunk-level
            if inserted_chunks_for_qdrant:
                qdrant_mgr.upsert_chunks(doc_id, inserted_chunks_for_qdrant)
    except Exception:
        pass

    return {
        "id": str(doc_id),
        "duplicate": duplicate,
        "chunk_count": len(chunk_ids),
        "chunk_ids": chunk_ids,
    }


# -----------------------------
# Summarization (naive fallback)
# -----------------------------
STOPWORDS = set(
    "a an the and or for of to in on with without from at by as is are was were be been being it this that these those into over under than then so such also just very you your we our not no can may might should would could will more most much few many any each other about using use used".split()
)


def _sentence_split(text: str) -> List[str]:
    import re
    s = re.split(r"(?<=[\.!?])\s+", (text or "").strip())
    return [t.strip() for t in s if t.strip()]


def _top_keywords(text: str, k: int = 8) -> List[str]:
    import re
    words = re.findall(r"[A-Za-z][A-Za-z\-']{2,}", text.lower())
    freq: Dict[str, int] = {}
    for w in words:
        if w in STOPWORDS:
            continue
        freq[w] = freq.get(w, 0) + 1
    return [w for w, _ in sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:k]]


def summarize_text_naive(text: str, sentences: int = 3, bullets: int = 5) -> Dict[str, Any]:
    sents = _sentence_split(text)
    short = " ".join(sents[:max(1, sentences)]) if sents else (text[:200] + ("…" if len(text) > 200 else ""))
    # bullets: try existing bullet lines
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    bullet_like = [ln for ln in lines if ln[:2] in {"- ", "* ", "• "} or ln[:1].isdigit()]
    if not bullet_like:
        bullet_like = sents[1:1 + bullets]
    bullets_out = [b[:220] for b in bullet_like[:bullets]]
    key_points = _top_keywords(text, k=5)
    return {"short": short, "bullets": bullets_out, "key_points": key_points}


class SummarizeTextIn(BaseModel):
    text: str
    sentences: Optional[int] = 3
    bullets: Optional[int] = 5


class SummarizeDocIn(BaseModel):
    sentences: Optional[int] = 3
    bullets: Optional[int] = 5
    save: Optional[bool] = True


@app.post("/summarize/text")
def summarize_text_endpoint(body: SummarizeTextIn) -> Dict[str, Any]:
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    out = summarize_text_naive(text, sentences=body.sentences or 3, bullets=body.bullets or 5)
    return out


@app.post("/summarize/doc/{doc_id}")
def summarize_doc_endpoint(doc_id: str, body: SummarizeDocIn) -> Dict[str, Any]:
    if not ObjectId.is_valid(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc id")
    doc = database.documents.find_one({"_id": ObjectId(doc_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    text = (doc.get("cleaned_text") or doc.get("raw_markdown") or doc.get("raw_html") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Document has no text to summarize")
    out = summarize_text_naive(text, sentences=body.sentences or 3, bullets=body.bullets or 5)
    if body.save:
        database.documents.update_one(
            {"_id": ObjectId(doc_id)},
            {"$set": {"summary": out, "updated_at": datetime.utcnow()}},
        )
    return out


# -----------------------------
# Qdrant integration (optional)
# -----------------------------
QDRANT_AVAILABLE = False
try:
    from qdrant_client import QdrantClient  # type: ignore
    from qdrant_client.http.models import Distance, VectorParams, PointStruct  # type: ignore
    from qdrant_client.http.models import Filter as QFilter, FieldCondition, MatchValue  # type: ignore
    QDRANT_AVAILABLE = True
except Exception:
    QDRANT_AVAILABLE = False


def _qdrant_point_id(id_str: str) -> int:
    """Stable 63-bit int from string id."""
    import hashlib as _hl
    h = int(_hl.sha1(id_str.encode("utf-8")).hexdigest(), 16)
    return h % (2**63 - 1)


class QdrantManager:
    def __init__(self):
        self.enabled = False
        if not QDRANT_AVAILABLE:
            return
        url = os.getenv("QDRANT_URL", "http://localhost:6333").strip()
        api_key = os.getenv("QDRANT_API_KEY")
        try:
            self.client = QdrantClient(url=url, api_key=api_key)  # type: ignore
        except Exception:
            return
        self.col_docs = os.getenv("QDRANT_COLLECTION_DOCS", "documents")
        self.col_chunks = os.getenv("QDRANT_COLLECTION_CHUNKS", "doc_chunks")
        self.vec_size = int(os.getenv("QDRANT_VECTOR_SIZE", "1536"))
        dist = (os.getenv("QDRANT_DISTANCE", "Cosine").upper())
        self.distance = Distance.COSINE if "COS" in dist else Distance.DOT if "DOT" in dist else Distance.EUCLID
        self.enabled = True
        self._ensure_collections()

    def _ensure_collections(self):
        try:
            for name in (self.col_docs, self.col_chunks):
                try:
                    self.client.get_collection(name)
                except Exception:
                    self.client.recreate_collection(
                        collection_name=name,
                        vectors_config=VectorParams(size=self.vec_size, distance=self.distance),
                    )
        except Exception:
            # If Qdrant isn't reachable, disable silently
            self.enabled = False

    def upsert_doc(self, doc_id: ObjectId, vector: Optional[List[float]], payload: Dict[str, Any]):
        if not self.enabled or not vector:
            return
        try:
            pid = _qdrant_point_id(str(doc_id))
            self.client.upsert(
                collection_name=self.col_docs,
                points=[PointStruct(id=pid, vector=vector, payload=payload)],
                wait=False,
            )
        except Exception:
            pass

    def upsert_chunks(self, doc_id: ObjectId, chunks: List[Dict[str, Any]]):
        if not self.enabled:
            return
        points = []
        for ch in chunks:
            vec = ch.get("embedding")
            if not vec:
                continue
            cid = ch.get("_id")
            if cid is None:
                # will be filled after insert; skip here
                continue
            pid = _qdrant_point_id(str(cid))
            payload = {k: v for k, v in ch.items() if k not in {"embedding"}}
            payload["type"] = "chunk"
            payload["doc_id"] = str(doc_id)
            # add string date filter helper
            db = payload.get("day_bucket")
            if isinstance(db, datetime):
                payload["day_bucket_str"] = db.date().isoformat()
            points.append(PointStruct(id=pid, vector=vec, payload=payload))
        if not points:
            return
        try:
            self.client.upsert(collection_name=self.col_chunks, points=points, wait=False)
        except Exception:
            pass


qdrant_mgr = QdrantManager()

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


# -----------------------------
# Ingest endpoint for AI agent
# -----------------------------
@app.post("/ingest", status_code=201)
def ingest_document(doc: DocumentIngest) -> Dict[str, Any]:
    try:
        out = create_document_and_chunks(database, doc)
        return out
    except HTTPException:
        raise
    except PyMongoError as e:
        raise HTTPException(status_code=500, detail=f"DB error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# -------------------------------------------------
# Smart Agent (LangGraph + LangChain) pipeline
# -------------------------------------------------
HAVE_LANGGRAPH = False
HAVE_LANGCHAIN = False
try:
    from langgraph.graph import StateGraph, START, END  # type: ignore
    HAVE_LANGGRAPH = True
except Exception:
    HAVE_LANGGRAPH = False
try:
    # Splitters + embeddings adapters (optional)
    from langchain_text_splitters import RecursiveCharacterTextSplitter  # type: ignore
    HAVE_LANGCHAIN = True
except Exception:
    HAVE_LANGCHAIN = False


class AgentIngestText(BaseModel):
    text: str
    source_url: Optional[str] = None
    title: Optional[str] = None
    content_type: Optional[str] = "web"
    lang: Optional[str] = None
    chunk_size: Optional[int] = 1000
    chunk_overlap: Optional[int] = 150


class AgentIngestUrl(BaseModel):
    url: str
    chunk_size: Optional[int] = 1000
    chunk_overlap: Optional[int] = 150


def _choose_embeddings():
    """Pick an embeddings function: returns callable(str)->List[float] or None."""
    provider = os.getenv("EMBEDDING_PROVIDER", "none").lower()
    if provider == "openai":
        try:
            from langchain_openai import OpenAIEmbeddings  # type: ignore

            model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
            emb = OpenAIEmbeddings(model=model)
            return lambda x: emb.embed_query(x)
        except Exception:
            return None
    elif provider == "huggingface":
        try:
            from langchain_huggingface import HuggingFaceEmbeddings  # type: ignore

            model = os.getenv("HF_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
            emb = HuggingFaceEmbeddings(model_name=model)
            return lambda x: emb.embed_query(x)
        except Exception:
            return None
    else:
        return None


def _chunk_text(text: str, size: int, overlap: int) -> List[str]:
    if HAVE_LANGCHAIN:
        splitter = RecursiveCharacterTextSplitter(chunk_size=size, chunk_overlap=overlap, add_start_index=True)
        docs = splitter.create_documents([text])
        return [d.page_content for d in docs]
    # fallback simple chunker
    out = []
    i = 0
    while i < len(text):
        out.append(text[i:i + size])
        i += max(1, size - overlap)
    return out


def _categorize_heuristic(text: str) -> Dict[str, Any]:
    # simple keyword-based topic guess
    labels = summarize_text_naive(text, sentences=1, bullets=0).get("key_points", [])
    primary = "/".join(labels[:2]) if labels else None
    out: Dict[str, Any] = {"primary": primary, "labels": [{"label": l, "score": 0.5} for l in labels]}
    return out


def _categorize_openai(text: str) -> Optional[Dict[str, Any]]:
    try:
        from openai import OpenAI  # type: ignore
    except Exception:
        return None
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None
    model = os.getenv("OPENAI_CATEGORIZER_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)
    system = (
        "You are a taxonomy classifier for personal knowledge bases. "
        "Given raw page text, produce a hierarchical primary topic as a slug path, and supporting labels. "
        "Rules: \n"
        "- primary: concise lowercase path with '/', e.g., 'ai/agents/langgraph', 'web/react/hooks'\n"
        "- labels: 3-6 relevant tags with confidence (0..1) and optional 'path' list, e.g., ['ai','agents','langgraph']\n"
        "- Prefer technical specificity. Avoid vague labels.\n"
        "- If multiple candidates, pick the one best representing the majority of content.\n"
        "Return strict JSON: {primary: string, labels: [{label, score, path?}]}"
    )
    user = (
        "Text to categorize:\n" + text[:12000] + "\n"  # limit tokens
    )
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.1,
        )
        content = resp.choices[0].message.content or ""
        import json as _json
        data = None
        # Try to parse json directly or from fenced blocks
        try:
            data = _json.loads(content)
        except Exception:
            import re
            m = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", content)
            if m:
                data = _json.loads(m.group(1))
        if not isinstance(data, dict):
            return None
        primary = (data.get("primary") or "").strip().lower() or None
        labels = data.get("labels") or []
        if primary and isinstance(labels, list):
            # normalize
            for lab in labels:
                if isinstance(lab, dict):
                    if "label" in lab and isinstance(lab["label"], str):
                        lab["label"] = lab["label"].strip().lower()
            return {"primary": primary, "labels": labels}
    except Exception:
        return None
    return None


def _run_pipeline(raw_text: str, meta: Dict[str, Any], chunk_size: int, chunk_overlap: int) -> Dict[str, Any]:
    """Run via LangGraph if available, else sequential fallback."""
    if HAVE_LANGGRAPH:
        # Simple state dict graph
        State = dict
        graph = StateGraph(State)

        def node_clean(state: State) -> State:
            cleaned = (state.get("text") or "").strip()
            return {**state, "cleaned": cleaned}

        def node_chunk(state: State) -> State:
            cleaned = state.get("cleaned") or ""
            chs = _chunk_text(cleaned, chunk_size, chunk_overlap)
            return {**state, "chunks": chs}

        def node_embed(state: State) -> State:
            chs: List[str] = state.get("chunks") or []
            embed_fn = _choose_embeddings()
            vectors: List[Optional[List[float]]] = []
            if embed_fn:
                for ch in chs:
                    try:
                        vectors.append(embed_fn(ch))
                    except Exception:
                        vectors.append(None)
            else:
                vectors = [None for _ in chs]
            return {**state, "vectors": vectors}

        def node_summarize(state: State) -> State:
            cleaned = state.get("cleaned") or ""
            sm = summarize_text_naive(cleaned)
            return {**state, "summary": sm}

        def node_categorize(state: State) -> State:
            cleaned = state.get("cleaned") or ""
            tp = None
            prov = os.getenv("CATEGORIZER_PROVIDER", "heuristic").lower()
            if prov == "openai":
                tp = _categorize_openai(cleaned)
            if not tp:
                tp = _categorize_heuristic(cleaned)
            return {**state, "topics": tp}

        def node_persist(state: State) -> State:
            cleaned = state.get("cleaned") or ""
            chs: List[str] = state.get("chunks") or []
            vecs: List[Optional[List[float]]] = state.get("vectors") or []
            chunk_models: List[DocumentIngestChunk] = []
            for i, ch in enumerate(chs):
                v = vecs[i] if i < len(vecs) else None
                chunk_models.append(DocumentIngestChunk(idx=i, text=ch, embedding=v))
            summary = state.get("summary") or {}
            topics = state.get("topics") or {}
            di = DocumentIngest(
                source_url=meta.get("source_url") or meta.get("canonical_url") or "",
                canonical_url=meta.get("canonical_url") or meta.get("source_url") or "",
                title=meta.get("title"),
                content_type=meta.get("content_type") or "web",
                lang=meta.get("lang"),
                raw_html=None,
                raw_markdown=None,
                cleaned_text=cleaned,
                tokens=None,
                summary=DocSummary(**summary),
                topics=topics,
                entities=None,
                tags=["agent"],
                embedding=None,
                captured_at=datetime.utcnow(),
                published_at=None,
                processed_at=datetime.utcnow(),
                metadata=meta,
                chunks=chunk_models,
            )
            out = create_document_and_chunks(database, di)
            return {**state, "result": out}

        graph.add_node("clean", node_clean)
        graph.add_node("chunk", node_chunk)
        graph.add_node("embed", node_embed)
        graph.add_node("summarize", node_summarize)
        graph.add_node("categorize", node_categorize)
        graph.add_node("persist", node_persist)
        graph.add_edge(START, "clean")
        graph.add_edge("clean", "chunk")
        graph.add_edge("chunk", "embed")
        graph.add_edge("embed", "summarize")
        graph.add_edge("summarize", "categorize")
        graph.add_edge("categorize", "persist")
        graph.add_edge("persist", END)
        compiled = graph.compile()
        init_state: State = {"text": raw_text}
        final = compiled.invoke(init_state)
        return final.get("result") or {}

    # Sequential fallback
    cleaned = (raw_text or "").strip()
    chunks = _chunk_text(cleaned, chunk_size, chunk_overlap)
    embed_fn = _choose_embeddings()
    chunk_models: List[DocumentIngestChunk] = []
    for i, ch in enumerate(chunks):
        vec = None
        if embed_fn:
            try:
                vec = embed_fn(ch)
            except Exception:
                vec = None
        chunk_models.append(DocumentIngestChunk(idx=i, text=ch, tokens=None, section=None, char_start=None, char_end=None, embedding=vec))
    summary = summarize_text_naive(cleaned)
    topics = None
    prov = os.getenv("CATEGORIZER_PROVIDER", "heuristic").lower()
    if prov == "openai":
        topics = _categorize_openai(cleaned)
    if not topics:
        topics = _categorize_heuristic(cleaned)
    di = DocumentIngest(
        source_url=meta.get("source_url") or meta.get("canonical_url") or "",
        canonical_url=meta.get("canonical_url") or meta.get("source_url") or "",
        title=meta.get("title"),
        content_type=meta.get("content_type") or "web",
        lang=meta.get("lang"),
        raw_html=None,
        raw_markdown=None,
        cleaned_text=cleaned,
        tokens=None,
        summary=DocSummary(**summary),
        topics=topics,
        entities=None,
        tags=["agent"],
        embedding=None,
        captured_at=datetime.utcnow(),
        published_at=None,
        processed_at=datetime.utcnow(),
        metadata=meta,
        chunks=chunk_models,
    )
    return create_document_and_chunks(database, di)


@app.post("/agent/ingest-text")
def agent_ingest_text(body: AgentIngestText) -> Dict[str, Any]:
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    meta = {
        "ui": "agent",
        "source_url": body.source_url or None,
        "canonical_url": body.source_url or None,
        "title": body.title or None,
        "content_type": body.content_type or "web",
        "lang": body.lang or None,
    }
    try:
        out = _run_pipeline(text, meta, body.chunk_size or 1000, body.chunk_overlap or 150)
        return out
    except PyMongoError as e:
        raise HTTPException(status_code=500, detail=f"DB error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# -----------------------------
# Semantic search (Qdrant + fallback)
# -----------------------------
class SemanticSearchIn(BaseModel):
    query: str
    top_k: Optional[int] = 10
    scope: Optional[str] = "chunks"  # 'chunks' | 'docs'
    date: Optional[str] = None  # YYYY-MM-DD
    topic: Optional[str] = None  # only applied to docs


@app.post("/search/semantic")
def search_semantic(body: SemanticSearchIn) -> Dict[str, Any]:
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="query required")
    scope = (body.scope or "chunks").lower()
    top_k = max(1, min(200, int(body.top_k or 10)))

    embed_fn = _choose_embeddings()
    # Fallback when embeddings or qdrant are unavailable → simple regex over docs
    if not (embed_fn and qdrant_mgr and getattr(qdrant_mgr, 'enabled', False)):
        filt: Dict[str, Any] = {}
        if body.date:
            try:
                d = datetime.fromisoformat(body.date)
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                filt["day_bucket"] = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
            except Exception:
                pass
        if body.topic:
            filt["topics.primary"] = body.topic
        filt["$or"] = [{"cleaned_text": {"$regex": q, "$options": "i"}}, {"title": {"$regex": q, "$options": "i"}}]
        cursor = database.documents.find(filt).sort("captured_at", -1).limit(top_k)
        items = [{
            "id": str(d.get("_id")),
            "type": "doc",
            "title": d.get("title"),
            "source_url": d.get("source_url"),
            "captured_at": d.get("captured_at"),
            "snippet": (d.get("summary") or {}).get("short") or (d.get("cleaned_text") or "")[:220]
        } for d in cursor]
        return {"items": items, "total": len(items), "mode": "fallback"}

    # Qdrant path
    try:
        vec = embed_fn(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"embed failed: {e}")

    try:
        # Build filter
        must = []
        if body.date:
            must.append(FieldCondition(key="day_bucket_str", match=MatchValue(value=body.date)))
        if body.topic and scope == "docs":
            must.append(FieldCondition(key="topics_primary", match=MatchValue(value=body.topic)))
        qfilter = QFilter(must=must) if must else None

        if scope == "docs":
            col = qdrant_mgr.col_docs
            res = qdrant_mgr.client.query_points(collection_name=col, query=vec, limit=top_k, filter=qfilter)
            items = []
            for p in getattr(res, 'points', []) or getattr(res, 'result', []) or []:
                payload = p.payload or {}
                doc_id = payload.get("doc_id") or None
                # we stored doc payload with doc-level upsert; payload may not include text
                # fetch details from Mongo
                if doc_id is None:
                    # The doc upsert uses id hash of doc_id; we set payload doc_id earlier.
                    pass
                d = None
                if doc_id and ObjectId.is_valid(str(doc_id)):
                    d = database.documents.find_one({"_id": ObjectId(str(doc_id))})
                score = getattr(p, 'score', None) or getattr(p, 'similarity', None)
                if d:
                    items.append({
                        "id": str(d.get("_id")), "type": "doc", "title": d.get("title"),
                        "source_url": d.get("source_url"), "captured_at": d.get("captured_at"),
                        "score": score, "snippet": (d.get("summary") or {}).get("short") or (d.get("cleaned_text") or "")[:220]
                    })
            return {"items": items, "total": len(items), "mode": "qdrant"}
        else:
            # chunks
            col = qdrant_mgr.col_chunks
            res = qdrant_mgr.client.query_points(collection_name=col, query=vec, limit=top_k, filter=qfilter)
            items = []
            for p in getattr(res, 'points', []) or getattr(res, 'result', []) or []:
                pay = p.payload or {}
                score = getattr(p, 'score', None) or getattr(p, 'similarity', None)
                items.append({
                    "id": str(pay.get("_id") or ""),
                    "type": "chunk",
                    "doc_id": str(pay.get("doc_id") or ""),
                    "text": (pay.get("text") or "")[:400],
                    "captured_at": pay.get("captured_at"),
                    "score": score,
                })
            return {"items": items, "total": len(items), "mode": "qdrant"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"qdrant search failed: {e}")


class CategorizeIn(BaseModel):
    text: str


@app.post("/categorize/text")
def categorize_text_endpoint(body: CategorizeIn) -> Dict[str, Any]:
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    prov = os.getenv("CATEGORIZER_PROVIDER", "heuristic").lower()
    out = None
    if prov == "openai":
        out = _categorize_openai(text)
    if not out:
        out = _categorize_heuristic(text)
    return out or {"primary": None, "labels": []}


class ComposeAnswerIn(BaseModel):
    query: str
    scope: Optional[str] = "chunks"  # chunks | docs
    top_k: Optional[int] = 8
    date: Optional[str] = None
    topic: Optional[str] = None
    include_sources: Optional[bool] = True


def _compose_llm_answer(query: str, contexts: List[Dict[str, Any]]) -> Optional[str]:
    try:
        from openai import OpenAI  # type: ignore
    except Exception:
        return None
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None
    model = os.getenv("OPENAI_ANSWER_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)
    # Build context string with brief sources
    blocks = []
    for i, c in enumerate(contexts[:20], 1):
        text = (c.get("text") or c.get("snippet") or "")
        src = c.get("source_url") or c.get("doc_id") or c.get("id") or ""
        blocks.append(f"[{i}] {text[:900]}\nsource: {src}")
    ctx = "\n\n".join(blocks)
    system = (
        "You are an expert assistant. Answer the user's question ONLY using the provided context snippets. "
        "If the context is insufficient or irrelevant, reply 'Not enough information in memory.' "
        "Be concise and precise. Include brief inline references like [1], [2] where relevant."
    )
    user = f"Question: {query}\n\nContext:\n{ctx}\n\nAnswer:"
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.2,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception:
        return None


@app.post("/answer/compose")
def compose_answer(body: ComposeAnswerIn) -> Dict[str, Any]:
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="query required")
    scope = (body.scope or "chunks").lower()
    top_k = max(1, min(50, int(body.top_k or 8)))

    # Reuse search pipeline
    items: List[Dict[str, Any]] = []
    try:
        # Use the same logic as search_semantic
        req = SemanticSearchIn(query=q, scope=scope, top_k=top_k, date=body.date, topic=body.topic)
        result = search_semantic(req)
        # Normalize to contexts
        for it in result.get("items", []):
            ctx = {"text": it.get("text") or it.get("snippet"), "id": it.get("id")}
            if it.get("type") == "doc":
                # fetch URL for doc
                try:
                    if ObjectId.is_valid(str(it.get("id"))):
                        d = database.documents.find_one({"_id": ObjectId(str(it.get("id")))} , {"source_url":1})
                        if d and d.get("source_url"): ctx["source_url"] = d.get("source_url")
                except Exception:
                    pass
            else:
                # chunk: attach doc_id for reference
                ctx["doc_id"] = it.get("doc_id")
            items.append(ctx)
    except HTTPException:
        raise
    except Exception as e:
        # Fallback: simple keyword over documents
        filt = {"$or": [{"cleaned_text": {"$regex": q, "$options": "i"}}, {"title": {"$regex": q, "$options": "i"}}]}
        cur = database.documents.find(filt).sort("captured_at", -1).limit(top_k)
        for d in cur:
            items.append({"text": (d.get("summary") or {}).get("short") or (d.get("cleaned_text") or "")[:500], "id": str(d.get("_id")), "source_url": d.get("source_url")})

    # Compose answer
    answer = _compose_llm_answer(q, items)
    mode = "llm" if answer else "summary"
    if not answer:
        joined = "\n".join([(c.get("text") or "") for c in items])
        sm = summarize_text_naive(joined, sentences=3, bullets=5)
        answer = sm.get("short") or ""

    out: Dict[str, Any] = {"answer": answer, "mode": mode}
    if body.include_sources:
        out["sources"] = [{k: v for k, v in c.items() if k in {"id", "doc_id", "source_url"}} for c in items[:top_k]]
    return out


class ReprocessDocIn(BaseModel):
    chunk_size: Optional[int] = 1000
    chunk_overlap: Optional[int] = 150
    replace_chunks: Optional[bool] = True


@app.post("/categorize/doc/{doc_id}")
def categorize_doc_endpoint(doc_id: str) -> Dict[str, Any]:
    if not ObjectId.is_valid(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc id")
    doc = database.documents.find_one({"_id": ObjectId(doc_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    text = (doc.get("cleaned_text") or doc.get("raw_markdown") or doc.get("raw_html") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Document has no text to categorize")
    prov = os.getenv("CATEGORIZER_PROVIDER", "heuristic").lower()
    out = None
    if prov == "openai":
        out = _categorize_openai(text)
    if not out:
        out = _categorize_heuristic(text)
    database.documents.update_one({"_id": ObjectId(doc_id)}, {"$set": {"topics": out, "updated_at": datetime.utcnow()}})
    return out or {"primary": None, "labels": []}


@app.post("/reprocess/doc/{doc_id}")
def reprocess_doc_endpoint(doc_id: str, body: ReprocessDocIn) -> Dict[str, Any]:
    if not ObjectId.is_valid(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc id")
    doc = database.documents.find_one({"_id": ObjectId(doc_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    text = (doc.get("cleaned_text") or doc.get("raw_markdown") or doc.get("raw_html") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Document has no text to process")

    size = int(body.chunk_size or 1000)
    overlap = int(body.chunk_overlap or 150)
    replace = bool(body.replace_chunks if body.replace_chunks is not None else True)
    chunks = _chunk_text(text, size, overlap)
    embed_fn = _choose_embeddings()

    # Optionally remove old chunks and qdrant points
    removed = 0
    if replace:
        try:
            res = database.doc_chunks.delete_many({"doc_id": ObjectId(doc_id)})
            removed = res.deleted_count
        except Exception:
            removed = 0
        # Qdrant delete by filter payload doc_id
        try:
            if qdrant_mgr and getattr(qdrant_mgr, 'enabled', False):
                from qdrant_client.http.models import Filter as QF, FieldCondition as FC, MatchValue as MV  # type: ignore
                qdrant_mgr.client.delete(collection_name=qdrant_mgr.col_chunks, points_selector=QF(must=[FC(key="doc_id", match=MV(value=str(doc_id)))]))
        except Exception:
            pass

    # Insert new chunks
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    captured_at = doc.get("captured_at") or now
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    day_bucket = _start_of_day_utc(captured_at)
    captured_hour = captured_at.hour

    chunk_docs: List[Dict[str, Any]] = []
    vectors: List[Optional[List[float]]] = []
    for i, ch in enumerate(chunks):
        vec = None
        if embed_fn:
            try:
                vec = embed_fn(ch)
            except Exception:
                vec = None
        vectors.append(vec)
        chunk_docs.append({
            "doc_id": ObjectId(doc_id),
            "idx": i,
            "text": ch,
            "tokens": None,
            "section": None,
            "char_start": None,
            "char_end": None,
            "embedding": vec,
            "topics": None,
            "captured_at": captured_at,
            "captured_hour": captured_hour,
            "day_bucket": day_bucket,
            "created_at": now,
        })
    inserted_ids: List[str] = []
    try:
        if chunk_docs:
            r = database.doc_chunks.insert_many(chunk_docs)
            inserted_ids = [str(i) for i in r.inserted_ids]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Insert chunks failed: {e}")

    # Qdrant upsert
    try:
        if qdrant_mgr and getattr(qdrant_mgr, 'enabled', False):
            points = []
            for oid, chdoc in zip(inserted_ids, chunk_docs):
                vec = chdoc.get("embedding")
                if not vec:
                    continue
                pid = _qdrant_point_id(oid)
                payload = {k: v for k, v in chdoc.items() if k != "embedding"}
                payload["_id"] = oid
                payload["doc_id"] = str(doc_id)
                db = payload.get("day_bucket")
                if isinstance(db, datetime):
                    payload["day_bucket_str"] = db.date().isoformat()
                points.append(PointStruct(id=pid, vector=vec, payload=payload))
            if points:
                qdrant_mgr.client.upsert(collection_name=qdrant_mgr.col_chunks, points=points, wait=False)
    except Exception:
        pass

    return {"replaced": removed, "inserted": len(inserted_ids)}


# -----------------------------
# Topics management
# -----------------------------
@app.get("/topics")
def list_topics(q: Optional[str] = Query(default=None), limit: int = Query(default=100, ge=1, le=1000)) -> Dict[str, Any]:
    try:
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"topics.primary": {"$exists": True, "$ne": None, "$ne": ""}}},
            {"$group": {"_id": "$topics.primary", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": int(limit)},
        ]
        if q:
            pipeline.insert(0, {"$match": {"topics.primary": {"$regex": q, "$options": "i"}}})
        rows = list(database.documents.aggregate(pipeline))
        items = [{"topic": r["_id"], "count": r["count"]} for r in rows]
        return {"items": items, "total": len(items)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class TopicRenameIn(BaseModel):
    from_topic: str
    to_topic: str


@app.post("/topics/rename")
def rename_topic(body: TopicRenameIn) -> Dict[str, Any]:
    src = (body.from_topic or "").strip()
    dst = (body.to_topic or "").strip()
    if not src or not dst:
        raise HTTPException(status_code=400, detail="from_topic and to_topic required")
    try:
        res = database.documents.update_many({"topics.primary": src}, {"$set": {"topics.primary": dst, "updated_at": datetime.utcnow()}})
        return {"matched": res.matched_count, "modified": res.modified_count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/agent/ingest-url")
def agent_ingest_url(body: AgentIngestUrl) -> Dict[str, Any]:
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url required")
    # Reuse scrape logic to get markdown/html
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "http://localhost:8010").rstrip("/")
    try:
        r = httpx.post(f"{firecrawl}/scrape", json={"url": url, "formats": ["markdown", "html"]}, timeout=60)
        r.raise_for_status()
        payload = r.json() or {}
        def _find_first(obj, keys):
            if isinstance(obj, dict):
                for k in keys:
                    v = obj.get(k)
                    if isinstance(v, str) and v.strip():
                        return v
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
        markdown = _find_first(payload, ["markdown", "content_markdown", "markdown_text"]) or ""
        if not markdown:
            html_val = _find_first(payload, ["html", "content_html", "contentHtml"]) or ""
            if html_val:
                markdown = _html_to_md_basic(html_val)
        text = (markdown or "").strip()
        meta = {"ui": "agent", "source_url": url, "canonical_url": url, "title": None, "content_type": "web"}
        return _run_pipeline(text, meta, body.chunk_size or 1000, body.chunk_overlap or 150)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Firecrawl error: {e}")
    except PyMongoError as e:
        raise HTTPException(status_code=500, detail=f"DB error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/agent/status")
def agent_status() -> Dict[str, Any]:
    provider = os.getenv("EMBEDDING_PROVIDER", "none")
    firecrawl = os.getenv("FIRECRAWL_BASE_URL", "").rstrip("/")
    qd: Dict[str, Any] = {"enabled": False}
    if qdrant_mgr and getattr(qdrant_mgr, 'enabled', False):
        dist = getattr(qdrant_mgr, 'distance', None)
        dist_name = None
        try:
            dist_name = dist.name.lower() if hasattr(dist, 'name') else str(dist)
        except Exception:
            dist_name = None
        qd = {
            "enabled": True,
            "collections": {"docs": qdrant_mgr.col_docs, "chunks": qdrant_mgr.col_chunks},
            "vector_size": qdrant_mgr.vec_size,
            "distance": dist_name,
            "url": os.getenv("QDRANT_URL", "")
        }
    return {
        "langgraph": HAVE_LANGGRAPH,
        "langchain": HAVE_LANGCHAIN,
        "embedding_provider": provider,
        "qdrant": qd,
        "env": {"FIRECRAWL_BASE_URL": firecrawl}
    }


# -----------------------------
# Browse endpoints
# -----------------------------
@app.get("/documents")
def list_documents(
    q: Optional[str] = Query(default=None, description="Regex on cleaned_text/title"),
    topic: Optional[str] = Query(default=None, description="Filter by topics.primary"),
    date: Optional[str] = Query(default=None, description="YYYY-MM-DD UTC day"),
    start: Optional[str] = Query(default=None, description="ISO start datetime"),
    end: Optional[str] = Query(default=None, description="ISO end datetime"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
) -> Dict[str, Any]:
    filt: Dict[str, Any] = {}
    if q:
        filt["$or"] = [
            {"cleaned_text": {"$regex": q, "$options": "i"}},
            {"title": {"$regex": q, "$options": "i"}},
        ]
    if topic:
        filt["topics.primary"] = topic
    # Date range logic
    def _parse_utc_date(s: str) -> datetime:
        d = datetime.fromisoformat(s)  # type: ignore
        if isinstance(d, datetime) and d.tzinfo is None:
            return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    if date:
        try:
            day = _parse_utc_date(date)
            filt["day_bucket"] = day
        except Exception:
            pass
    # start/end on captured_at
    range_cond: Dict[str, Any] = {}
    for key, val in (("$gte", start), ("$lte", end)):
        if val:
            try:
                dt = datetime.fromisoformat(val)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                range_cond[key] = dt
            except Exception:
                pass
    if range_cond:
        filt["captured_at"] = range_cond

    cursor = (
        database.documents.find(filt, {
            "cleaned_text": 0, "raw_html": 0, "raw_markdown": 0, "embedding": 0, "entities": 0
        })
        .sort("captured_at", -1)
        .skip(int(skip))
        .limit(int(limit))
    )
    items = []
    for d in cursor:
        items.append({
            "id": str(d.get("_id")),
            "title": d.get("title"),
            "source_url": d.get("source_url"),
            "canonical_url": d.get("canonical_url"),
            "topics": d.get("topics"),
            "captured_at": d.get("captured_at"),
            "tokens": d.get("tokens"),
            "summary": (d.get("summary") or {}).get("short"),
        })
    total = database.documents.count_documents(filt)
    return {"items": items, "total": total, "skip": skip, "limit": limit}


@app.get("/chunks")
def list_chunks(
    doc_id: Optional[str] = Query(default=None),
    topic: Optional[str] = Query(default=None),
    date: Optional[str] = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
) -> Dict[str, Any]:
    filt: Dict[str, Any] = {}
    if doc_id:
        if not ObjectId.is_valid(doc_id):
            raise HTTPException(status_code=400, detail="Invalid doc_id")
        filt["doc_id"] = ObjectId(doc_id)
    if topic:
        filt["topics.primary"] = topic
    if date:
        try:
            d = datetime.fromisoformat(date)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            filt["day_bucket"] = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        except Exception:
            pass
    cursor = (
        database.doc_chunks.find(filt, {"embedding": 0})
        .sort("captured_at", -1)
        .skip(int(skip))
        .limit(int(limit))
    )
    items = []
    for c in cursor:
        items.append({
            "id": str(c.get("_id")),
            "doc_id": str(c.get("doc_id")),
            "idx": c.get("idx"),
            "section": c.get("section"),
            "text": (c.get("text") or "")[:260],
            "captured_at": c.get("captured_at"),
        })
    total = database.doc_chunks.count_documents(filt)
    return {"items": items, "total": total, "skip": skip, "limit": limit}


# -----------------------------
# Daily rollup generation
# -----------------------------
class DayRollupIn(BaseModel):
    date: str  # YYYY-MM-DD (UTC)
    rebuild: Optional[bool] = False


@app.post("/rollup/day")
def build_day_rollup(body: DayRollupIn) -> Dict[str, Any]:
    try:
        d = datetime.fromisoformat(body.date)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        day = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid date format; expected YYYY-MM-DD")

    # If exists and not rebuild, return existing
    existing = database.daily_rollups.find_one({"date": day})
    if existing and not body.rebuild:
        existing["id"] = str(existing.pop("_id"))
        return existing

    # Gather documents for the day
    docs = list(database.documents.find({"day_bucket": day}))
    # Fallback to notes if no docs exist
    if not docs:
        day_next = day + timedelta(days=1)
        notes = list(database.notes.find({
            "created_at": {"$gte": day, "$lt": day_next}
        }))
        # Minimal rollup from notes
        bullets = [(n.get("text") or "").strip()[:120] for n in notes[:20]]
        summary = f"Captured {len(notes)} notes."
        data = {"date": day, "summary": summary, "bullets": bullets, "top_topics": []}
        database.daily_rollups.update_one({"date": day}, {"$set": data}, upsert=True)
        out = database.daily_rollups.find_one({"date": day}) or data
        out["id"] = str(out.pop("_id"))
        return out

    # Build bullets from document summaries or beginnings of cleaned_text
    bullets: List[str] = []
    topic_counts: Dict[str, int] = {}
    for d in docs:
        tp = ((d.get("topics") or {}).get("primary") if d.get("topics") else None)
        if tp:
            topic_counts[tp] = topic_counts.get(tp, 0) + 1
        s = (d.get("summary") or {}).get("short") or None
        if s:
            bullets.append(s.strip())
        else:
            ct = (d.get("cleaned_text") or "").strip()
            if ct:
                bullets.append(ct[:180])
        if len(bullets) >= 24:
            break

    # Compose summary
    if bullets:
        summary = bullets[0]
    else:
        summary = f"Captured {len(docs)} documents."
    top_topics = sorted([{ "topic": k, "count": v } for k, v in topic_counts.items()], key=lambda x: -x["count"])[:8]

    data = {"date": day, "summary": summary, "bullets": bullets, "top_topics": top_topics}
    database.daily_rollups.update_one({"date": day}, {"$set": data}, upsert=True)
    out = database.daily_rollups.find_one({"date": day}) or data
    out["id"] = str(out.pop("_id"))
    return out
