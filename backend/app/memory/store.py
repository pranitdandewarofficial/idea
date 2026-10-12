"""Memory store.

Scopes enforce isolation:

* ``agent``   — private to one agent's namespace.  Other agents can never read it.
* ``project`` — shared by every agent working on the same project.
* ``company`` — shared knowledge distilled from finished runs (procedural memory).
"""

from __future__ import annotations

import math
import re
from typing import Iterable

from ..db import session_scope
from ..models import MemoryItem

_WORD = re.compile(r"[a-z0-9_]{2,}")
STOP = frozenset("the a an and or of to in for with on is are be this that it as at by from".split())
MAX_ITEMS_PER_QUERY = 2000


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if w not in STOP}


def remember(
    *,
    namespace: str,
    content: str,
    scope: str = "agent",
    scope_id: str | None = None,
    key: str = "",
    kind: str = "episodic",
    weight: float = 1.0,
) -> str:
    if not content or not content.strip():
        return ""
    with session_scope() as s:
        item = MemoryItem(
            namespace=namespace,
            scope=scope,
            scope_id=scope_id,
            key=key[:200],
            content=content[:20_000],
            kind=kind,
            weight=float(weight),
        )
        s.add(item)
        s.flush()
        return item.id


def recall(
    query: str,
    *,
    namespaces: Iterable[str] = (),
    scopes: Iterable[str] = ("agent", "project", "company"),
    scope_id: str | None = None,
    limit: int = 4,
) -> list[dict]:
    wanted_namespaces = set(namespaces)
    wanted_scopes = set(scopes)
    query_tokens = _tokens(query)
    if not query_tokens and not wanted_namespaces:
        return []

    with session_scope() as s:
        rows = s.query(MemoryItem).limit(MAX_ITEMS_PER_QUERY).all()

    scored: list[tuple[float, dict]] = []
    for row in rows:
        if row.scope not in wanted_scopes:
            continue
        if row.scope == "agent" and row.namespace not in wanted_namespaces:
            continue
        if row.scope in ("project", "company") and scope_id and row.scope_id and row.scope_id != scope_id:
            continue
        overlap = len(query_tokens & _tokens(f"{row.key} {row.content}"))
        if not overlap and query_tokens:
            continue
        score = (overlap / math.sqrt(max(len(query_tokens), 1))) * float(row.weight or 1.0)
        scored.append((score, {
            "id": row.id,
            "namespace": row.namespace,
            "scope": row.scope,
            "key": row.key,
            "content": row.content,
            "kind": row.kind,
            "score": round(score, 4),
        }))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [payload for _, payload in scored[:limit]]


def recall_for_agent(
    *,
    agent_id: str,
    project_id: str | None,
    query: str,
    limit: int = 4,
) -> list[dict]:
    """Return only what this agent is allowed to see."""
    return recall(
        query,
        namespaces=[f"agent:{agent_id}"],
        scopes=("agent", "project", "company"),
        scope_id=project_id,
        limit=limit,
    )


def lessons_for(kind: str = "procedural", limit: int = 5) -> list[dict]:
    with session_scope() as s:
        rows = (
            s.query(MemoryItem)
            .filter(MemoryItem.scope == "company", MemoryItem.kind == kind)
            .order_by(MemoryItem.weight.desc())
            .limit(limit)
            .all()
        )
        return [{"key": r.key, "content": r.content, "weight": r.weight} for r in rows]


def record_lesson(content: str, key: str = "", weight: float = 1.0) -> str:
    """Procedural memory: a pattern distilled from a finished run."""
    return remember(namespace="company", scope="company", scope_id=None, key=key,
                    content=content, kind="procedural", weight=weight)


def forget(*, namespace: str | None = None, scope: str | None = None, scope_id: str | None = None) -> int:
    with session_scope() as s:
        query = s.query(MemoryItem)
        if namespace:
            query = query.filter(MemoryItem.namespace == namespace)
        if scope:
            query = query.filter(MemoryItem.scope == scope)
        if scope_id:
            query = query.filter(MemoryItem.scope_id == scope_id)
        return int(query.delete(synchronize_session=False))


def stats() -> dict:
    with session_scope() as s:
        rows = s.query(MemoryItem).all()
    by_scope: dict[str, int] = {}
    by_namespace: dict[str, int] = {}
    for row in rows:
        by_scope[row.scope] = by_scope.get(row.scope, 0) + 1
        by_namespace[row.namespace] = by_namespace.get(row.namespace, 0) + 1
    return {"total": len(rows), "by_scope": by_scope, "by_namespace": by_namespace}
