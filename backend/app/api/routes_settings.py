"""Settings: execution limits, security policy, persistence and the danger zone."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..api.errors import ApiError
from ..config import settings
from ..db import session_scope
from ..events import bus
from ..models import (
    SETTING_KEYS,
    AuditRecord,
    Checkpoint,
    DecisionRecord,
    Event,
    MemoryItem,
    Message,
    ToolCall,
    UsageRecord,
    all_settings,
    get_setting,
    set_setting,
)
from ..orchestrator import budget as budget_guard
from ..providers.registry import providers
from ..schemas import SettingsPatch
from ..security.auth import current_token, require_auth

router = APIRouter(prefix="/api/settings", tags=["settings"], dependencies=[Depends(require_auth)])

DESCRIPTIONS: dict[str, str] = {
    "zero_spend": "Block every paid provider call unless spend is authorised for that run.",
    "max_concurrency": "Maximum number of tasks the orchestrator runs at the same time.",
    "max_tasks_per_agent": "Maximum parallel tasks for a single agent.",
    "task_timeout_seconds": "Wall-clock cap for one task before it is marked as timed out.",
    "shell_timeout_seconds": "Wall-clock cap for one sandboxed command.",
    "max_repairs": "Repair attempts before a failing task escalates to a human.",
    "sandbox_tier": "1 = subprocess with resource limits, 2 = Docker container per project.",
    "decision_confidence_threshold": "System-1 confidence needed to act without escalating to System 2.",
    "decision_mode": "auto | laya | laya_mnn | laya_hosted | local | llm",
    "decisions_enabled": "Turn the System-1 decision layer off to use only deterministic code rules.",
    "guardrail_sensitivity": "How aggressively the guardrail layer blocks suspicious model output.",
    "auto_approve_low_risk": "Allow low-risk actions to proceed without a human click.",
    "low_risk_threshold": "Risk score below which an action may be auto-approved.",
    "compact_mode": "Reduce city animation for slower hardware.",
    "default_provider_id": "Provider used first when an agent has no explicit assignment.",
    "fallback_provider_id": "Provider used when the primary one fails.",
    "plan_token_budget": "Token cap for a single plan; hitting it pauses the run.",
    "global_token_budget": "Token cap across all runs; hitting it pauses the run.",
    "approval_timeout_seconds": "0 = wait indefinitely for a human decision.",
}


@router.get("")
def get_all() -> dict[str, Any]:
    values = all_settings()
    return {
        "values": values,
        "defaults": dict(SETTING_KEYS),
        "descriptions": DESCRIPTIONS,
        "api_token": current_token() if settings.auth_enabled else None,
        "auth_enabled": settings.auth_enabled,
        "paths": {
            "data_dir": str(settings.data_dir),
            "workspaces_dir": str(settings.workspaces_dir),
            "database": settings.resolved_db_url(),
        },
        "sandbox": {"tier": int(values.get("sandbox_tier", 1)),
                    "docker_image": settings.docker_image},
        "usage": providers.global_usage(),
    }


@router.patch("")
async def patch(body: SettingsPatch) -> dict[str, Any]:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise ApiError("nothing_to_update", "Send at least one setting to change.", status=422)
    for key, value in updates.items():
        if value is None:
            continue
        set_setting(key, value)
    with session_scope() as s:
        s.add(AuditRecord(actor="founder", action="settings.changed", target="settings", result="ok",
                          context={k: v for k, v in updates.items() if v is not None}))
    await bus.emit("settings.changed", **{k: v for k, v in updates.items() if v is not None})
    return {"values": all_settings(), "changed": sorted(k for k, v in updates.items() if v is not None)}


@router.get("/budget")
def budget(plan_id: str | None = None) -> dict[str, Any]:
    if plan_id:
        return budget_guard.budget.snapshot(plan_id).as_dict()
    usage = providers.global_usage()
    return {
        "global": usage,
        "global_token_budget": int(get_setting("global_token_budget", settings.global_token_budget)),
        "plan_token_budget": int(get_setting("plan_token_budget", settings.plan_token_budget)),
        "zero_spend": providers.zero_spend_active(),
    }


@router.post("/zero-spend")
async def set_zero_spend(enabled: bool) -> dict[str, Any]:
    set_setting("zero_spend", bool(enabled))
    with session_scope() as s:
        s.add(AuditRecord(actor="founder", action="zero_spend.changed", target="settings",
                          result="ok", context={"enabled": bool(enabled)}))
    await bus.emit("settings.zero_spend", enabled=bool(enabled))
    return {"zero_spend": bool(enabled)}


@router.post("/purge")
async def purge(
    events_older_than_days: int = 7,
    include_tool_calls: bool = False,
    include_decisions: bool = False,
    include_messages: bool = False,
) -> dict[str, Any]:
    """Danger zone: remove historical bookkeeping rows. Never touches workspaces."""
    from datetime import datetime, timedelta

    cutoff = datetime.utcnow() - timedelta(days=max(0, events_older_than_days))
    deleted: dict[str, int] = {}
    with session_scope() as s:
        deleted["events"] = int(s.query(Event).filter(Event.created_at < cutoff).delete())
        deleted["checkpoints"] = int(
            s.query(Checkpoint).filter(Checkpoint.created_at < cutoff).delete()
        )
        deleted["usage_records"] = int(
            s.query(UsageRecord).filter(UsageRecord.created_at < cutoff).delete()
        )
        if include_tool_calls:
            deleted["tool_calls"] = int(
                s.query(ToolCall).filter(ToolCall.created_at < cutoff).delete()
            )
        if include_decisions:
            deleted["decision_records"] = int(
                s.query(DecisionRecord).filter(DecisionRecord.created_at < cutoff).delete()
            )
        if include_messages:
            deleted["messages"] = int(
                s.query(Message).filter(Message.created_at < cutoff).delete()
            )
        s.add(AuditRecord(actor="founder", action="data.purged", target="history", result="ok",
                          context=deleted))
    await bus.emit("settings.purged", **deleted)
    return {"deleted": deleted, "cutoff": cutoff.isoformat()}


@router.post("/memory/reset")
async def reset_memory(scope: str = "company") -> dict[str, Any]:
    if scope not in ("company", "all"):
        raise ApiError("invalid_scope", "scope must be 'company' or 'all'.", status=422)
    with session_scope() as s:
        query = s.query(MemoryItem)
        if scope == "company":
            query = query.filter(MemoryItem.scope == "company")
        deleted = int(query.delete(synchronize_session=False))
        s.add(AuditRecord(actor="founder", action="memory.reset", target=scope, result="ok",
                          context={"deleted": deleted}))
    await bus.emit("settings.memory_reset", scope=scope, deleted=deleted)
    return {"deleted": deleted, "scope": scope}
