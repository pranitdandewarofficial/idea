"""Filesystem tools — every agent file operation goes through here."""

from __future__ import annotations

import fnmatch
import hashlib
import os
from pathlib import Path

from ..security.paths import WorkspaceViolation, resolve_in_workspace
from .context import ToolContext

MAX_READ_BYTES = 400_000
IGNORED_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache",
                ".next", "dist", "build", ".ruff_cache", ".tox", "coverage"}


async def read_file(ctx: ToolContext, path: str, *, max_bytes: int = MAX_READ_BYTES) -> dict:
    target = resolve_in_workspace(ctx.root, path)
    if not target.exists():
        raise FileNotFoundError(f"No such file in the workspace: {path}")
    if target.is_dir():
        raise IsADirectoryError(f"'{path}' is a directory; use list_dir instead.")
    size = target.stat().st_size
    data = target.read_bytes()[:max_bytes]
    text = data.decode("utf-8", errors="replace")
    return {
        "path": ctx.rel(target),
        "size": size,
        "truncated": size > len(data),
        "content": text,
    }


async def write_file(ctx: ToolContext, path: str, content: str) -> dict:
    target = resolve_in_workspace(ctx.root, path)
    existed = target.exists()
    previous = None
    if existed:
        try:
            previous = target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            previous = None
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content or "", encoding="utf-8")
    rel = ctx.rel(target)
    ctx.changed_files.add(rel)
    return {
        "path": rel,
        "bytes": len((content or "").encode("utf-8")),
        "created": not existed,
        "previous_bytes": len(previous.encode("utf-8")) if previous is not None else None,
    }


async def edit_file(ctx: ToolContext, path: str, old_text: str, new_text: str) -> dict:
    """Replace the first occurrence of ``old_text`` (whitespace-tolerant)."""
    target = resolve_in_workspace(ctx.root, path)
    if not target.exists():
        raise FileNotFoundError(f"No such file in the workspace: {path}")
    current = target.read_text(encoding="utf-8", errors="replace")
    if old_text in current:
        updated = current.replace(old_text, new_text, 1)
        exact = True
    else:
        normalized = _normalize(current)
        needle = _normalize(old_text)
        if not needle:
            raise ValueError("old_text is empty")
        index = normalized.find(needle)
        if index == -1:
            raise ValueError(
                "old_text was not found in the file. Read the file first and copy the exact text."
            )
        updated = _apply_fuzzy(current, old_text, new_text)
        exact = False
    target.write_text(updated, encoding="utf-8")
    rel = ctx.rel(target)
    ctx.changed_files.add(rel)
    return {"path": rel, "changed": True, "exact_match": exact, "bytes": len(updated.encode("utf-8"))}


def _normalize(text: str) -> str:
    return " ".join(text.split())


def _apply_fuzzy(current: str, old_text: str, new_text: str) -> str:
    lines = current.splitlines(keepends=True)
    needle = [ln.strip() for ln in old_text.splitlines() if ln.strip()]
    if not needle:
        return current
    for start in range(len(lines) - len(needle) + 1):
        window = [ln.strip() for ln in lines[start : start + len(needle)]]
        if window == needle:
            indent = lines[start][: len(lines[start]) - len(lines[start].lstrip())]
            replacement = "".join(indent + ln + "\n" for ln in new_text.splitlines())
            return "".join(lines[:start]) + replacement + "".join(lines[start + len(needle) :])
    raise ValueError("old_text was not found in the file (fuzzy match failed).")


async def create_dir(ctx: ToolContext, path: str) -> dict:
    target = resolve_in_workspace(ctx.root, path)
    target.mkdir(parents=True, exist_ok=True)
    return {"path": ctx.rel(target), "created": True}


async def delete_file(ctx: ToolContext, path: str) -> dict:
    target = resolve_in_workspace(ctx.root, path)
    if not target.exists():
        raise FileNotFoundError(f"No such file in the workspace: {path}")
    if target.is_dir():
        raise IsADirectoryError("delete_file only removes files, never directories.")
    target.unlink()
    rel = ctx.rel(target)
    ctx.changed_files.discard(rel)
    return {"path": rel, "deleted": True}


async def list_dir(ctx: ToolContext, path: str = ".") -> dict:
    target = resolve_in_workspace(ctx.root, path)
    if not target.exists():
        raise FileNotFoundError(f"No such directory in the workspace: {path}")
    if not target.is_dir():
        raise NotADirectoryError(f"'{path}' is not a directory.")
    entries = []
    for child in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if child.name in IGNORED_DIRS:
            continue
        stat = child.stat()
        entries.append(
            {
                "path": ctx.rel(child),
                "name": child.name,
                "type": "dir" if child.is_dir() else "file",
                "size": stat.st_size if child.is_file() else None,
            }
        )
    return {"path": ctx.rel(target), "entries": entries, "count": len(entries)}


async def workspace_tree(ctx: ToolContext, path: str = ".", max_entries: int = 400) -> dict:
    root = resolve_in_workspace(ctx.root, path)
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
        for name in sorted(filenames):
            full = Path(dirpath) / name
            out.append({"path": ctx.rel(full), "size": full.stat().st_size})
            if len(out) >= max_entries:
                return {"entries": out, "truncated": True, "count": len(out)}
        for name in sorted(dirnames):
            full = Path(dirpath) / name
            out.append({"path": ctx.rel(full) + "/", "size": 0})
    return {"entries": out, "truncated": False, "count": len(out)}


async def search_in_workspace(
    ctx: ToolContext, query: str, glob: str = "*", max_results: int = 60, ignore_case: bool = True
) -> dict:
    if not query:
        raise ValueError("query is required")
    needle = query.lower() if ignore_case else query
    results: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(ctx.root):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
        for name in filenames:
            if not fnmatch.fnmatch(name, glob):
                continue
            full = Path(dirpath) / name
            try:
                if full.stat().st_size > 2_000_000:
                    continue
                text = full.read_text(encoding="utf-8", errors="replace")
            except (OSError, UnicodeDecodeError):
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                haystack = line.lower() if ignore_case else line
                if needle in haystack:
                    results.append({"path": ctx.rel(full), "line": lineno, "text": line.strip()[:240]})
                    if len(results) >= max_results:
                        return {"query": query, "matches": results, "truncated": True}
    return {"query": query, "matches": results, "truncated": False}


def workspace_hash(root: Path) -> str:
    """Cheap content fingerprint of the workspace, used for the audit trail."""
    digest = hashlib.sha256()
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            for name in sorted(filenames):
                full = Path(dirpath) / name
                try:
                    stat = full.stat()
                    digest.update(f"{full.relative_to(root).as_posix()}:{stat.st_size}:{int(stat.st_mtime)}\n".encode())
                except OSError:
                    continue
    except (OSError, WorkspaceViolation):
        return ""
    return digest.hexdigest()[:16]
