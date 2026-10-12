"""Objectives, plans and tasks."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..agents.profiles import PROFILE_MAP
from ..api.errors import ApiError
from ..db import session_scope
from ..events import bus
from ..models import Approval, Event, Message, Plan, Project, Task, ToolCall
from ..orchestrator import budget as budget_guard
from ..orchestrator import checkpoints
from ..orchestrator.approvals import gate
from ..orchestrator.orchestrator import orchestrator
from ..orchestrator.scheduler import critical_path
from ..schemas import (ApprovalDecision, ObjectiveIn, ObjectiveOut, PlanOut,
                     SpendAuthorization, TaskOut)
from ..security.auth import require_auth

router = APIRouter(prefix="/api", tags=["plans"], dependencies=[Depends(require_auth)])


def _task_out(row: Task) -> dict[str, Any]:
    return TaskOut.model_validate(row).model_dump()


def _plan_or_404(plan_id: str) -> Plan:
    with session_scope() as s:
        row = s.get(Plan, plan_id)
        if row is None:
            raise ApiError("not_found", f"Plan '{plan_id}' does not exist.", status=404)
        return row


# --------------------------------------------------------------------------- #
# objectives
# --------------------------------------------------------------------------- #
@router.post("/objectives", response_model=ObjectiveOut)
async def submit_objective(body: ObjectiveIn) -> dict[str, Any]:
    try:
        return await orchestrator.submit_objective(
            body.objective,
            project_name=body.project_name,
            spend_authorized=body.spend_authorized,
            auto_start=body.auto_start,
        )
    except ValueError as exc:
        raise ApiError("invalid_objective", str(exc), status=422)


@router.get("/objectives")
def list_objectives(limit: int = 50, state: str | None = None) -> dict[str, Any]:
    with session_scope() as s:
        query = s.query(Plan).order_by(Plan.created_at.desc())
        if state:
            query = query.filter(Plan.state == state)
        rows = query.limit(limit).all()
        projects = {p.id: p for p in s.query(Project).all()}
        items = []
        for row in rows:
            project = projects.get(row.project_id)
            items.append(
                {
                    "plan_id": row.id,
                    "project_id": row.project_id,
                    "project_name": project.name if project else "",
                    "objective": row.objective,
                    "state": row.state,
                    "progress": row.progress,
                    "heuristic": row.heuristic,
                    "spend_authorized": row.spend_authorized,
                    "tokens_used": row.tokens_used,
                    "cost_estimate": row.cost_estimate,
                    "failure_reason": row.failure_reason,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                    "finished_at": row.finished_at.isoformat() if row.finished_at else None,
                }
            )
        return {"items": items, "count": len(items)}


# --------------------------------------------------------------------------- #
# plans
# --------------------------------------------------------------------------- #
@router.get("/plans")
def list_plans(limit: int = 50, state: str | None = None, project_id: str | None = None) -> dict[str, Any]:
    """Full plan rows (not the abbreviated objective list) for the Command Center."""
    limit = max(1, min(limit, 200))
    with session_scope() as s:
        query = s.query(Plan).order_by(Plan.created_at.desc())
        if state and state != "all":
            query = query.filter(Plan.state == state)
        if project_id:
            query = query.filter(Plan.project_id == project_id)
        rows = query.limit(limit).all()
        return {
            "items": [PlanOut.model_validate(row).model_dump() for row in rows],
            "count": len(rows),
        }


@router.get("/plans/{plan_id}", response_model=PlanOut)
def get_plan(plan_id: str) -> dict[str, Any]:
    row = _plan_or_404(plan_id)
    data = PlanOut.model_validate(row).model_dump()
    with session_scope() as s:
        tasks = s.query(Task).filter(Task.plan_id == plan_id).order_by(Task.order_index).all()
        task_dicts = [_task_out(t) for t in tasks]
    data["tasks"] = task_dicts
    data["critical_path"] = critical_path(task_dicts)
    data["budget"] = budget_guard.budget.snapshot(plan_id).as_dict()
    data["runs"] = [r for r in orchestrator.status()["active_runs"] if r["plan_id"] == plan_id]
    return data


@router.get("/plans/{plan_id}/dag")
def plan_dag(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    with session_scope() as s:
        tasks = s.query(Task).filter(Task.plan_id == plan_id).order_by(Task.order_index).all()
        nodes = [
            {"id": t.id, "external_id": t.external_id, "title": t.title, "agent_id": t.agent_id,
             "status": t.status, "priority": t.priority, "effort": t.effort,
             "department": PROFILE_MAP[t.agent_id].department if t.agent_id in PROFILE_MAP else None}
            for t in tasks
        ]
    by_external = {t["external_id"]: t["id"] for t in nodes}
    with session_scope() as s:
        rows = s.query(Task).filter(Task.plan_id == plan_id).all()
        deps = {r.id: list(r.depends_on or []) for r in rows}
    edges = [{"from": src, "to": dst} for dst, sources in deps.items() for src in sources]
    return {"nodes": nodes, "edges": edges, "external_ids": by_external,
            "critical_path": critical_path(nodes)}


@router.post("/plans/{plan_id}/start")
async def start_plan(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    return await orchestrator.start(plan_id)


@router.post("/plans/{plan_id}/pause")
async def pause_plan(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    return await orchestrator.pause(plan_id)


@router.post("/plans/{plan_id}/resume")
async def resume_plan(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    return await orchestrator.resume(plan_id)


@router.post("/plans/{plan_id}/cancel")
async def cancel_plan(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    return await orchestrator.cancel(plan_id)


@router.post("/plans/{plan_id}/spend")
async def authorize_spend(plan_id: str, body: SpendAuthorization) -> dict[str, Any]:
    row = _plan_or_404(plan_id)
    with session_scope() as s:
        plan = s.get(Plan, plan_id)
        if plan is not None:
            plan.spend_authorized = body.authorized
    await bus.emit(
        "spend.authorized" if body.authorized else "spend.revoked",
        plan_id=plan_id,
        note=body.note,
        detail="Per-run authorization; it is not persisted as a global setting.",
    )
    return {"plan_id": plan_id, "spend_authorized": body.authorized, "previous": row.spend_authorized}


@router.get("/plans/{plan_id}/report")
def plan_report(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    with session_scope() as s:
        plan = s.get(Plan, plan_id)
        project = s.get(Project, plan.project_id) if plan else None
        report = dict(project.report or {}) if project else {}
    if not report:
        raise ApiError(
            "report_not_ready",
            "This plan has not finished yet, so there is no delivery report. "
            "Reports are generated only from real executed evidence.",
            status=409,
            context={"plan_id": plan_id, "state": plan.state if plan else None},
        )
    return report


@router.get("/plans/{plan_id}/checkpoints")
def plan_checkpoints(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    return {"items": checkpoints.history(plan_id), "latest": checkpoints.latest(plan_id)}


@router.get("/plans/{plan_id}/budget")
def plan_budget(plan_id: str) -> dict[str, Any]:
    _plan_or_404(plan_id)
    return budget_guard.budget.snapshot(plan_id).as_dict()


@router.get("/plans/{plan_id}/timeline")
def plan_timeline(plan_id: str, limit: int = 400) -> dict[str, Any]:
    _plan_or_404(plan_id)
    with session_scope() as s:
        rows = (
            s.query(Event)
            .order_by(Event.id.desc())
            .limit(3000)
            .all()
        )
    items = [
        {
            "id": r.id, "kind": r.kind, "payload": r.payload, "priority": r.priority,
            "ts": r.created_at.isoformat() if r.created_at else None,
        }
        for r in reversed(rows)
        if (r.payload or {}).get("plan_id") == plan_id
    ][-limit:]
    return {"items": items, "count": len(items)}


# --------------------------------------------------------------------------- #
# tasks
# --------------------------------------------------------------------------- #
@router.get("/tasks")
def list_tasks(
    status: str | None = None,
    agent: str | None = None,
    plan: str | None = None,
    project: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    with session_scope() as s:
        query = s.query(Task)
        if status:
            query = query.filter(Task.status.in_([v.strip() for v in status.split(",") if v.strip()]))
        if agent:
            query = query.filter(Task.agent_id == agent)
        if plan:
            query = query.filter(Task.plan_id == plan)
        if project:
            query = query.filter(Task.project_id == project)
        rows = query.order_by(Task.created_at.desc()).limit(limit).all()
        return {"items": [_task_out(r) for r in rows], "count": len(rows)}


def _task_or_404(task_id: str) -> Task:
    with session_scope() as s:
        row = s.get(Task, task_id)
        if row is None:
            raise ApiError("not_found", f"Task '{task_id}' does not exist.", status=404)
        return row


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str) -> dict[str, Any]:
    return _task_out(_task_or_404(task_id))


@router.get("/tasks/{task_id}/timeline")
def task_timeline(task_id: str) -> dict[str, Any]:
    _task_or_404(task_id)
    with session_scope() as s:
        tools = (
            s.query(ToolCall).filter(ToolCall.task_id == task_id).order_by(ToolCall.created_at).all()
        )
        messages = (
            s.query(Message).filter(Message.task_id == task_id).order_by(Message.created_at).all()
        )
        events = s.query(Event).order_by(Event.id.desc()).limit(3000).all()
    task_events = [
        {"id": e.id, "kind": e.kind, "payload": e.payload,
         "ts": e.created_at.isoformat() if e.created_at else None}
        for e in reversed(events)
        if (e.payload or {}).get("task_id") == task_id
    ]
    return {
        "tool_calls": [
            {"id": c.id, "tool": c.tool, "ok": c.ok, "denied": c.denied, "reason": c.reason,
             "exit_code": c.exit_code, "duration_ms": c.duration_ms, "args": c.args,
             "result_excerpt": c.result_excerpt,
             "created_at": c.created_at.isoformat() if c.created_at else None}
            for c in tools
        ],
        "messages": [
            {"id": m.id, "role": m.role, "content": m.content, "meta": m.meta,
             "created_at": m.created_at.isoformat() if m.created_at else None}
            for m in messages
        ],
        "events": task_events,
    }


@router.post("/tasks/{task_id}/retry")
async def retry_task(task_id: str) -> dict[str, Any]:
    row = _task_or_404(task_id)
    if row.status in ("running", "repairing"):
        raise ApiError("conflict", "That task is already running.", status=409)
    with session_scope() as s:
        task = s.get(Task, task_id)
        if task is not None:
            task.status = "pending"
            task.error = None
        plan_id = row.plan_id
    handle = orchestrator.runs.get(plan_id)
    if handle is not None:
        handle.pause_event.clear()
        await orchestrator.start(plan_id)
        return {"task_id": task_id, "status": "pending", "plan_restarted": True}
    await bus.emit("task.ready", task_id=task_id, plan_id=plan_id,
                   detail="Reset to pending. Start the plan to run it.")
    return {"task_id": task_id, "status": "pending", "plan_restarted": False,
            "note": "The plan is not running. Press Resume in the Command Center to execute it."}


@router.post("/tasks/{task_id}/reassign")
async def reassign_task(task_id: str, agent_id: str) -> dict[str, Any]:
    row = _task_or_404(task_id)
    if agent_id not in PROFILE_MAP or agent_id in ("ceo", "laya"):
        raise ApiError("invalid_agent", f"'{agent_id}' cannot own tasks.", status=422)
    if row.status in ("running", "repairing"):
        raise ApiError("conflict", "Cancel or wait for the running task before reassigning.", status=409)
    with session_scope() as s:
        task = s.get(Task, task_id)
        previous = task.agent_id if task else None
        if task is not None:
            task.agent_id = agent_id
            task.status = "pending"
    await bus.emit("task.reassigned", task_id=task_id, plan_id=row.plan_id,
                   from_agent=previous, to_agent=agent_id, reason="manual reassignment by the founder")
    return {"task_id": task_id, "agent_id": agent_id, "previous_agent_id": previous}


@router.get("/approvals", response_model=None)
def list_approvals(status: str = "pending") -> dict[str, Any]:
    with session_scope() as s:
        query = s.query(Approval)
        if status and status != "all":
            query = query.filter(Approval.status == status)
        rows = query.order_by(Approval.created_at.desc()).limit(200).all()
        return {
            "items": [
                {"id": r.id, "action": r.action, "risk": r.risk, "risk_score": r.risk_score,
                 "detail": r.detail, "status": r.status, "plan_id": r.plan_id, "task_id": r.task_id,
                 "requested_by": r.requested_by, "decision_note": r.decision_note,
                 "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows
            ]
        }


@router.post("/approvals/{approval_id}/decision")
async def decide_approval(approval_id: str, body: ApprovalDecision) -> dict[str, Any]:
    """Approve or deny a pending gate.  This unblocks the waiting tool call."""
    with session_scope() as s:
        row = s.get(Approval, approval_id)
        if row is None:
            raise ApiError("not_found", f"Approval '{approval_id}' does not exist.", status=404)
        if row.status != "pending":
            raise ApiError(
                "already_decided",
                f"This approval was already {row.status}.",
                status=409,
                context={"approval_id": approval_id, "status": row.status},
            )
        action, plan_id, task_id = row.action, row.plan_id, row.task_id

    resolved = gate.decide(approval_id, bool(body.approved), body.note or "")
    if not resolved:
        raise ApiError("decision_failed", "The approval could not be decided.", status=409)
    await bus.emit(
        "approval.decided",
        approval_id=approval_id,
        approved=bool(body.approved),
        action=action,
        plan_id=plan_id,
        task_id=task_id,
        note=body.note or "",
    )
    with session_scope() as s:
        row = s.get(Approval, approval_id)
        return {
            "approval_id": approval_id,
            "approved": bool(body.approved),
            "status": row.status if row else "unknown",
            "action": action,
            "plan_id": plan_id,
            "task_id": task_id,
            "note": body.note or "",
        }


@router.get("/runs")
def runs() -> dict[str, Any]:
    return orchestrator.status()


@router.get("/projects")
def list_projects() -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(Project).order_by(Project.created_at.desc()).all()
        plans = {p.project_id: p for p in s.query(Plan).all()}
        items = []
        for row in rows:
            plan = plans.get(row.id)
            items.append(
                {
                    "id": row.id, "name": row.name, "objective": row.objective,
                    "workspace_path": row.workspace_path, "status": row.status,
                    "preview_url": row.preview_url, "preview_port": row.preview_port,
                    "plan_id": plan.id if plan else None,
                    "plan_state": plan.state if plan else None,
                    "progress": plan.progress if plan else 0.0,
                    "has_report": bool(row.report),
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
            )
        return {"items": items, "count": len(items)}
