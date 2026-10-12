"""Agent directory and agent workspace endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..agents.profiles import PROFILE_MAP
from ..api.errors import ApiError
from ..db import session_scope
from ..memory import store as memory
from ..models import Agent, Message, Task, ToolCall
from ..providers.base import ProviderError
from ..providers.registry import providers
from ..schemas import AgentOut, AgentPatch
from ..security.auth import require_auth

router = APIRouter(prefix="/api/agents", tags=["agents"], dependencies=[Depends(require_auth)])


def _out(row: Agent) -> dict[str, Any]:
    data = AgentOut.model_validate(row).model_dump()
    profile = PROFILE_MAP.get(row.id)
    data["is_decision_agent"] = bool(profile and profile.is_decision_agent)
    data["output_contract"] = profile.output_contract if profile else {}
    return data


@router.get("")
def list_agents(
    department: str | None = None,
    status: str | None = None,
    enabled: bool | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(Agent).all()
        items = [_out(row) for row in rows]
        loads: dict[str, int] = {}
        for task in s.query(Task).filter(Task.status.in_(["running", "repairing", "ready"])).all():
            if task.agent_id:
                loads[task.agent_id] = loads.get(task.agent_id, 0) + 1
    for item in items:
        item["load"] = loads.get(item["id"], 0)
    if department:
        items = [i for i in items if i["department"].lower() == department.lower()]
    if status:
        items = [i for i in items if i["status"] == status]
    if enabled is not None:
        items = [i for i in items if i["is_enabled"] is enabled]
    if q:
        needle = q.lower()
        items = [
            i for i in items
            if needle in f"{i['name']} {i['role']} {i['department']} {' '.join(i['skills'])}".lower()
        ]
    return {"items": items, "count": len(items)}


@router.get("/{agent_id}")
def get_agent(agent_id: str) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(Agent, agent_id)
        if row is None:
            raise ApiError("not_found", f"Agent '{agent_id}' does not exist.", status=404)
        data = _out(row)
        current = s.get(Task, row.current_task_id) if row.current_task_id else None
        data["current_task"] = (
            {"id": current.id, "title": current.title, "status": current.status} if current else None
        )
        data["load"] = (
            s.query(Task)
            .filter(Task.agent_id == row.id, Task.status.in_(["running", "repairing", "ready"]))
            .count()
        )
    return data


@router.patch("/{agent_id}")
def patch_agent(agent_id: str, body: AgentPatch) -> dict[str, Any]:
    profile = PROFILE_MAP.get(agent_id)
    with session_scope() as s:
        row = s.get(Agent, agent_id)
        if row is None:
            raise ApiError("not_found", f"Agent '{agent_id}' does not exist.", status=404)
        updates = body.model_dump(exclude_unset=True)
        if "tools" in updates and updates["tools"] is not None:
            if profile is None:
                raise ApiError("invalid_tools", "Unknown agent; cannot validate the tool whitelist.")
            allowed = set(profile.tools)
            requested = set(updates["tools"])
            unknown = requested - allowed
            if unknown:
                raise ApiError(
                    "tool_not_permitted",
                    f"{agent_id} may not use: {', '.join(sorted(unknown))}. "
                    f"Authorised tools: {', '.join(sorted(allowed)) or 'none'}.",
                    status=409,
                    context={"agent_id": agent_id, "unknown": sorted(unknown)},
                )
            row.tools = sorted(requested)
            updates.pop("tools")
        if updates.get("provider_id"):
            from ..models import Provider

            if s.get(Provider, updates["provider_id"]) is None:
                raise ApiError("not_found", "That provider does not exist.", status=404)
        for key, value in updates.items():
            if value is not None:
                setattr(row, key, value)
        s.flush()
        return _out(row)


@router.post("/{agent_id}/test-model")
async def test_model(agent_id: str) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(Agent, agent_id)
        if row is None:
            raise ApiError("not_found", f"Agent '{agent_id}' does not exist.", status=404)
        profile = PROFILE_MAP.get(agent_id)
        role = row.model_role or (profile.model_role if profile else "coding")
        preferred_provider = row.provider_id
        preferred_model = row.model
    try:
        provider_id, model = providers.pick(
            role=role,
            preferred_provider_id=preferred_provider,
            preferred_model=preferred_model,
        )
    except ProviderError as exc:
        raise ApiError(exc.code, exc.message, status=409, context={"agent_id": agent_id, "role": role})
    try:
        result = await providers.complete(
            provider_id=provider_id,
            model=model,
            system="Reply with the single word: ready",
            user="Connectivity check.",
            max_tokens=8,
            temperature=0.0,
            purpose="connectivity_test",
        )
    except ProviderError as exc:
        raise ApiError(exc.code, exc.message, status=502,
                       context={"provider_id": provider_id, "model": model})
    return {
        "ok": True,
        "agent_id": agent_id,
        "provider_id": provider_id,
        "model": result.model,
        "role": role,
        "reply": result.text[:200],
        "latency_ms": result.latency_ms,
        "tokens": result.total_tokens,
        "mocked": result.mocked,
    }


@router.get("/{agent_id}/tools")
def agent_tools(agent_id: str) -> dict[str, Any]:
    """The real least-privilege whitelist: what this agent is *authorised* to use
    (fixed by its profile) versus what is currently *granted* (editable subset)."""
    from ..tools.policy import tool_risk
    from ..tools.registry import TOOL_SPECS

    profile = PROFILE_MAP.get(agent_id)
    if profile is None:
        with session_scope() as s:
            if s.get(Agent, agent_id) is None:
                raise ApiError("not_found", f"Agent '{agent_id}' does not exist.", status=404)
    authorised = list(profile.tools) if profile else []
    with session_scope() as s:
        row = s.get(Agent, agent_id)
        granted = sorted(row.tools or []) if row is not None else []

    def describe(name: str) -> dict[str, Any]:
        spec = TOOL_SPECS.get(name)
        return {
            "name": name,
            "description": spec.description if spec else "",
            "category": spec.category if spec else "",
            "gated": bool(spec and spec.gate is not None),
            "risk": round(tool_risk(name), 3),
            "params": sorted(spec.params) if spec else [],
        }

    return {
        "agent_id": agent_id,
        "authorised": [describe(n) for n in sorted(authorised)],
        "granted": granted,
        "revoked": sorted(set(authorised) - set(granted)),
        "catalogue_size": len(TOOL_SPECS),
    }


@router.get("/{agent_id}/tasks")
def agent_tasks(agent_id: str, limit: int = 50) -> dict[str, Any]:
    with session_scope() as s:
        rows = (
            s.query(Task)
            .filter(Task.agent_id == agent_id)
            .order_by(Task.created_at.desc())
            .limit(limit)
            .all()
        )
        return {
            "items": [
                {
                    "id": t.id, "external_id": t.external_id, "title": t.title, "status": t.status,
                    "plan_id": t.plan_id, "project_id": t.project_id, "retries": t.retries,
                    "error": t.error, "files_changed": list(t.files_changed or []),
                    "created_at": t.created_at.isoformat() if t.created_at else None,
                }
                for t in rows
            ]
        }


@router.get("/{agent_id}/tool-calls")
def agent_tool_calls(agent_id: str, limit: int = 50) -> dict[str, Any]:
    with session_scope() as s:
        rows = (
            s.query(ToolCall)
            .filter(ToolCall.agent_id == agent_id)
            .order_by(ToolCall.created_at.desc())
            .limit(limit)
            .all()
        )
        return {
            "items": [
                {
                    "id": c.id, "tool": c.tool, "ok": c.ok, "denied": c.denied, "reason": c.reason,
                    "task_id": c.task_id, "exit_code": c.exit_code, "duration_ms": c.duration_ms,
                    "args": c.args, "result_excerpt": c.result_excerpt,
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                }
                for c in rows
            ]
        }


@router.get("/{agent_id}/messages")
def agent_messages(agent_id: str, task_id: str | None = None, limit: int = 100) -> dict[str, Any]:
    with session_scope() as s:
        query = s.query(Message).filter(Message.agent_id == agent_id)
        if task_id:
            query = query.filter(Message.task_id == task_id)
        rows = query.order_by(Message.created_at.desc()).limit(limit).all()
        return {
            "items": [
                {
                    "id": m.id, "role": m.role, "content": m.content, "task_id": m.task_id,
                    "project_id": m.project_id, "meta": m.meta,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                }
                for m in reversed(rows)
            ]
        }


@router.get("/{agent_id}/memory")
def agent_memory(agent_id: str, q: str = "", limit: int = 20) -> dict[str, Any]:
    profile = PROFILE_MAP.get(agent_id)
    namespace = profile.memory_namespace if profile else f"agent:{agent_id}"
    items = memory.recall(q or "*", namespaces=[namespace], scopes=("agent",), limit=limit)
    return {"namespace": namespace, "items": items, "count": len(items)}


@router.delete("/{agent_id}/memory")
def clear_agent_memory(agent_id: str) -> dict[str, Any]:
    profile = PROFILE_MAP.get(agent_id)
    namespace = profile.memory_namespace if profile else f"agent:{agent_id}"
    deleted = memory.forget(namespace=namespace, scope="agent")
    return {"deleted": deleted, "namespace": namespace}
