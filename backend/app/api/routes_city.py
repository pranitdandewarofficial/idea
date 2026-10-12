"""The City read model — every visual maps to persisted backend state."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..agents.profiles import PROFILE_MAP
from ..city import BUILDING_BY_DEPARTMENT, city_layout
from ..db import session_scope
from ..models import Agent, Approval, Plan, Provider, Task, get_setting
from ..providers.registry import providers
from ..security.auth import require_auth

router = APIRouter(prefix="/api/city", tags=["city"], dependencies=[Depends(require_auth)])

BUILDING_ORDER = (
    "command-tower", "decision-lab", "product-studio", "design-studio", "research-lab",
    "engineering-hq", "collaboration-hub", "qa-center", "security-ops", "infra-center",
    "docs-delivery",
)


@router.get("")
def city() -> dict[str, Any]:
    with session_scope() as s:
        agents = s.query(Agent).all()
        agent_rows = [
            {
                "id": a.id, "name": a.name, "role": a.role, "department": a.department,
                "status": a.status, "current_task_id": a.current_task_id,
                "avatar_seed": a.avatar_seed, "is_enabled": a.is_enabled,
                "model_role": a.model_role, "model": a.model, "tools": list(a.tools or []),
                "skills": list(a.skills or []),
                "city_x": a.city_x, "city_y": a.city_y, "home_x": a.home_x, "home_y": a.home_y,
            }
            for a in agents
        ]
        running = (
            s.query(Task)
            .filter(Task.status.in_(["running", "repairing", "ready", "blocked", "timeout"]))
            .all()
        )
        task_rows = [
            {
                "id": t.id, "external_id": t.external_id, "title": t.title, "status": t.status,
                "agent_id": t.agent_id, "plan_id": t.plan_id, "project_id": t.project_id,
                "retries": t.retries, "error": (t.error or "")[:300],
            }
            for t in running
        ]
        active_plans = (
            s.query(Plan)
            .filter(Plan.state.in_(["executing", "scheduling", "verifying", "repairing",
                                    "integrating", "reviewing", "delivering", "paused", "blocked"]))
            .all()
        )
        plan_rows = [
            {"id": p.id, "project_id": p.project_id, "state": p.state, "progress": p.progress,
             "objective": p.objective[:160]}
            for p in active_plans
        ]
        pending_approvals = s.query(Approval).filter(Approval.status == "pending").count()
        provider_rows = s.query(Provider).all()
        providers_out = [
            {
                "id": p.id, "label": p.label, "kind": p.kind, "is_paid": p.is_paid,
                "is_enabled": p.is_enabled, "last_test_ok": p.last_test_ok,
                "last_test_message": p.last_test_message,
            }
            for p in provider_rows
        ]

    loads: dict[str, int] = {}
    for task in task_rows:
        if task["agent_id"] and task["status"] in ("running", "repairing"):
            loads[task["agent_id"]] = loads.get(task["agent_id"], 0) + 1
    for row in agent_rows:
        profile = PROFILE_MAP.get(row["id"])
        row["load"] = loads.get(row["id"], 0)
        row["is_decision_agent"] = bool(profile and profile.is_decision_agent)
        building = BUILDING_BY_DEPARTMENT.get(row["department"])
        row["building_id"] = building.id if building else "collaboration-hub"
        current = next((t for t in task_rows if t["id"] == row["current_task_id"]), None)
        row["current_task"] = (
            {"id": current["id"], "title": current["title"], "status": current["status"]}
            if current
            else None
        )

    layout = city_layout(agent_rows)
    layout["order"] = list(BUILDING_ORDER)

    building_state: dict[str, dict[str, Any]] = {b["id"]: {"active": 0, "blocked": 0, "agents": []}
                                                 for b in layout["buildings"]}
    for row in layout["agents"]:
        entry = building_state.setdefault(row["building_id"], {"active": 0, "blocked": 0, "agents": []})
        entry["agents"].append(row["id"])
        if row["status"] in ("working", "collaborating"):
            entry["active"] += 1
        if row["status"] in ("blocked", "failed"):
            entry["blocked"] += 1

    markers = []
    for task in task_rows:
        agent = next((a for a in layout["agents"] if a["id"] == task["agent_id"]), None)
        markers.append(
            {
                "task_id": task["id"],
                "external_id": task["external_id"],
                "title": task["title"],
                "status": task["status"],
                "agent_id": task["agent_id"],
                "building_id": agent["building_id"] if agent else "collaboration-hub",
                "x": agent["city_x"] if agent else 840,
                "y": (agent["city_y"] - 34) if agent else 500,
                "retries": task["retries"],
                "error": task["error"],
            }
        )

    degraded_providers = [p for p in providers_out if p["is_enabled"] and p["last_test_ok"] is False]
    return {
        **layout,
        "buildings_state": building_state,
        "task_markers": markers,
        "active_plans": plan_rows,
        "pending_approvals": pending_approvals,
        "providers": providers_out,
        "degraded_providers": [p["label"] for p in degraded_providers],
        "zero_spend": providers.zero_spend_active(),
        "compact_mode": bool(get_setting("compact_mode", False)),
        "connection": {"event_subscribers": 0},
    }


@router.get("/buildings/{building_id}")
def building_detail(building_id: str) -> dict[str, Any]:
    data = city()
    building = next((b for b in data["buildings"] if b["id"] == building_id), None)
    if building is None:
        from ..api.errors import ApiError

        raise ApiError("not_found", f"Building '{building_id}' does not exist.", status=404)
    agents = [a for a in data["agents"] if a["building_id"] == building_id]
    tasks = [t for t in data["task_markers"] if t["building_id"] == building_id]
    return {
        "building": building,
        "state": data["buildings_state"].get(building_id, {}),
        "agents": agents,
        "active_tasks": tasks,
    }
