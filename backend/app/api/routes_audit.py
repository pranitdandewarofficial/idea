"""Audit trail — append-only record of who did what."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..db import session_scope
from ..models import AuditRecord
from ..security.auth import require_auth

router = APIRouter(prefix="/api/audit", tags=["audit"], dependencies=[Depends(require_auth)])


@router.get("")
def list_audit(
    actor: str | None = None,
    action: str | None = None,
    target: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    with session_scope() as s:
        query = s.query(AuditRecord)
        if actor:
            query = query.filter(AuditRecord.actor == actor)
        if action:
            query = query.filter(AuditRecord.action.like(f"{action}%"))
        if target:
            query = query.filter(AuditRecord.target == target)
        rows = query.order_by(AuditRecord.id.desc()).limit(min(limit, 1000)).all()
        return {
            "items": [
                {
                    "id": r.id, "actor": r.actor, "action": r.action, "target": r.target,
                    "result": r.result, "context": r.context,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ],
            "count": len(rows),
        }


@router.get("/actors")
def actors() -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(AuditRecord.actor).distinct().all()
    return {"items": sorted({r[0] for r in rows if r[0]})}
