"""Knowledge Center: upload, index, search, delete."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile

from ..api.errors import ApiError
from ..db import session_scope
from ..events import bus
from ..knowledge import ingest
from ..knowledge.search import search
from ..models import AuditRecord, KnowledgeSource
from ..schemas import KnowledgeOut
from ..security.auth import require_auth

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"], dependencies=[Depends(require_auth)])

ALLOWED_SUFFIXES = {".md", ".txt", ".rst", ".pdf", ".py", ".ts", ".tsx", ".js", ".jsx", ".json",
                    ".yml", ".yaml", ".toml", ".html", ".css", ".sh", ".csv", ".log"}


@router.get("")
def list_sources() -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(KnowledgeSource).order_by(KnowledgeSource.created_at.desc()).all()
        return {"items": [KnowledgeOut.model_validate(r).model_dump() for r in rows], "count": len(rows)}


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    tags: str = Form(""),
) -> dict[str, Any]:
    name = file.filename or "upload.txt"
    suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix not in ALLOWED_SUFFIXES:
        raise ApiError(
            "unsupported_file_type",
            f"'{suffix or name}' is not an accepted knowledge format. Accepted: "
            + ", ".join(sorted(ALLOWED_SUFFIXES)),
            status=415,
        )
    data = await file.read()
    if not data:
        raise ApiError("empty_file", "The uploaded file is empty.", status=422)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    try:
        source = ingest.index_source(name, data, tag_list)
    except ValueError as exc:
        raise ApiError("ingest_failed", str(exc), status=422)
    await bus.emit(
        "knowledge.indexed",
        source_id=source.id,
        name=source.name,
        chunks=source.chunk_count,
        status=source.index_status,
        warning=source.error,
    )
    with session_scope() as s:
        s.add(AuditRecord(actor="founder", action="knowledge.uploaded", target=source.id, result="ok",
                          context={"name": name, "bytes": len(data), "chunks": source.chunk_count}))
    return KnowledgeOut.model_validate(source).model_dump()


@router.get("/search")
def knowledge_search(q: str, limit: int = 5, tags: str = "") -> dict[str, Any]:
    if not q.strip():
        raise ApiError("invalid_query", "A search query is required.", status=422)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    return search(q, limit=min(limit, 25), tags=tag_list or None)


@router.post("/{source_id}/reindex")
async def reindex(source_id: str) -> dict[str, Any]:
    with session_scope() as s:
        if s.get(KnowledgeSource, source_id) is None:
            raise ApiError("not_found", f"Knowledge source '{source_id}' does not exist.", status=404)
    try:
        result = ingest.reindex(source_id)
    except LookupError as exc:
        raise ApiError("reindex_failed", str(exc), status=409, context={"source_id": source_id})
    await bus.emit("knowledge.reindexed", **result)
    return result


@router.delete("/{source_id}")
async def delete_source(source_id: str) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(KnowledgeSource, source_id)
        if row is None:
            raise ApiError("not_found", f"Knowledge source '{source_id}' does not exist.", status=404)
        name = row.name
    ingest.delete_source(source_id)
    with session_scope() as s:
        s.add(AuditRecord(actor="founder", action="knowledge.deleted", target=source_id, result="ok",
                          context={"name": name}))
    await bus.emit("knowledge.deleted", source_id=source_id, name=name)
    return {"deleted": True, "source_id": source_id, "name": name}


@router.get("/stats")
def knowledge_stats() -> dict[str, Any]:
    from ..models import KnowledgeChunk

    with session_scope() as s:
        sources = s.query(KnowledgeSource).count()
        chunks = s.query(KnowledgeChunk).count()
        bytes_total = sum(r.size_bytes for r in s.query(KnowledgeSource).all())
    return {"sources": sources, "chunks": chunks, "bytes": bytes_total,
            "engine": "keyword-bm25", "embedding_model": None}
