import os
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
from pymongo import MongoClient
from pymongo.errors import PyMongoError


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
