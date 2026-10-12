"""Chunking and indexing for uploaded knowledge sources."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from ..db import session_scope
from ..models import KnowledgeChunk, KnowledgeSource

CHUNK_CHARS = 1400
CHUNK_OVERLAP = 200
MAX_FILE_BYTES = 8 * 1024 * 1024

_WORD = re.compile(r"[a-z0-9_]{2,}")
STOP = frozenset("the a an and or of to in for with on is are be this that it as at by from".split())


def tokenize(text: str) -> list[str]:
    return [w for w in _WORD.findall((text or "").lower()) if w not in STOP]


def chunk_text(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    paragraphs = re.split(r"\n{2,}", text)
    chunks: list[str] = []
    buffer = ""
    for paragraph in paragraphs:
        if len(buffer) + len(paragraph) + 2 <= CHUNK_CHARS:
            buffer = f"{buffer}\n\n{paragraph}".strip()
            continue
        if buffer:
            chunks.append(buffer)
        if len(paragraph) > CHUNK_CHARS:
            start = 0
            while start < len(paragraph):
                chunks.append(paragraph[start : start + CHUNK_CHARS])
                start += CHUNK_CHARS - CHUNK_OVERLAP
            buffer = ""
        else:
            buffer = paragraph
    if buffer:
        chunks.append(buffer)
    return chunks


def decode(data: bytes, name: str) -> str:
    lowered = name.lower()
    if lowered.endswith((".md", ".txt", ".rst", ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yml",
                         ".yaml", ".toml", ".html", ".css", ".sh", ".csv", ".log", ".env")):
        return data.decode("utf-8", errors="replace")
    if lowered.endswith(".pdf"):
        return _extract_pdf_text(data)
    return data.decode("utf-8", errors="replace")


def _extract_pdf_text(data: bytes) -> str:
    """Minimal PDF text extraction (no external dependency).

    Handles the common uncompressed ``Tj``/``TJ`` string operators.  Scanned or
    compressed PDFs yield little text; the source is then marked with a warning
    rather than pretending it was indexed properly.
    """
    import zlib

    text_parts: list[str] = []
    for match in re.finditer(rb"stream\r?\n(.*?)endstream", data, re.DOTALL):
        raw = match.group(1)
        decoded = raw
        try:
            decoded = zlib.decompress(raw)
        except zlib.error:
            pass
        for string_match in re.finditer(rb"\((?:[^()\\]|\\.)*\)", decoded):
            fragment = string_match.group(0)[1:-1]
            fragment = fragment.replace(b"\\(", b"(").replace(b"\\)", b")").replace(b"\\\\", b"\\")
            text_parts.append(fragment.decode("latin-1", errors="replace"))
    return " ".join(text_parts)


def _storage_dir(source_id: str) -> Path:
    from ..config import settings

    target = settings.data_dir / "knowledge" / source_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def index_source(name: str, data: bytes, tags: list[str] | None = None) -> KnowledgeSource:
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"File is larger than the {MAX_FILE_BYTES // (1024 * 1024)} MB limit.")
    text = decode(data, name)
    checksum = hashlib.sha256(data).hexdigest()
    chunks = chunk_text(text)
    kind = Path(name).suffix.lstrip(".").lower() or "text"
    warning = ""
    if kind == "pdf" and len(text.strip()) < 40:
        warning = "PDF text extraction produced almost no content (scanned or encrypted PDF)."

    with session_scope() as s:
        source = KnowledgeSource(
            name=name,
            kind=kind,
            size_bytes=len(data),
            checksum=checksum,
            tags=list(tags or []),
            index_status="indexed" if chunks else "empty",
            chunk_count=len(chunks),
            error=warning or None,
        )
        s.add(source)
        s.flush()
        stored = _storage_dir(source.id) / Path(name).name
        stored.write_bytes(data)
        source.storage_path = str(stored)
        for position, chunk in enumerate(chunks):
            s.add(
                KnowledgeChunk(
                    source_id=source.id,
                    position=position,
                    text=chunk,
                    tokens=sorted(set(tokenize(chunk)))[:400],
                )
            )
        s.flush()
        return source


def reindex(source_id: str) -> dict:
    """Re-chunk a stored source.  Returns real counts, never a fake success."""
    with session_scope() as s:
        source = s.get(KnowledgeSource, source_id)
        if source is None:
            raise LookupError(f"Knowledge source '{source_id}' not found.")
        storage_path = source.storage_path
        name = source.name
        if not storage_path or not Path(storage_path).exists():
            raise LookupError(
                f"The original bytes for '{name}' are not on disk, so it cannot be re-indexed. "
                "Upload the file again."
            )
        data = Path(storage_path).read_bytes()
        s.query(KnowledgeChunk).filter(KnowledgeChunk.source_id == source_id).delete()
        text = decode(data, name)
        chunks = chunk_text(text)
        for position, chunk in enumerate(chunks):
            s.add(KnowledgeChunk(source_id=source_id, position=position, text=chunk,
                                 tokens=sorted(set(tokenize(chunk)))[:400]))
        source.chunk_count = len(chunks)
        source.index_status = "indexed" if chunks else "empty"
        source.size_bytes = len(data)
        source.checksum = hashlib.sha256(data).hexdigest()
        s.flush()
        return {"id": source_id, "name": name, "chunk_count": len(chunks),
                "index_status": source.index_status}


def delete_source(source_id: str) -> None:
    import shutil

    with session_scope() as s:
        source = s.get(KnowledgeSource, source_id)
        storage_path = source.storage_path if source else None
        s.query(KnowledgeChunk).filter(KnowledgeChunk.source_id == source_id).delete()
        if source is not None:
            s.delete(source)
    if storage_path:
        directory = Path(storage_path).parent
        if directory.name == source_id and directory.exists():
            shutil.rmtree(directory, ignore_errors=True)
