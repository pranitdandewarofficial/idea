"""Checkpointing so every long run survives a crash."""

from __future__ import annotations

import logging

from ..db import session_scope
from ..events import bus
from ..models import Checkpoint, Plan, Task

log = logging.getLogger("pranit.checkpoints")


def _task_state(task: Task) -> dict:
    return {
        "id": task.id,
        "external_id": task.external_id,
        "status": task.status,
        "agent_id": task.agent_id,
        "retries": task.retries,
        "files_changed": list(task.files_changed or []),
    }


async def save(plan_id: str, reason: str = "task_completed") -> str | None:
    with session_scope() as s:
        plan = s.get(Plan, plan_id)
        if plan is None:
            return None
        tasks = s.query(Task).filter(Task.plan_id == plan_id).order_by(Task.order_index).all()
        sequence = s.query(Checkpoint).filter(Checkpoint.plan_id == plan_id).count() + 1
        snapshot = {
            "plan_state": plan.state,
            "progress": plan.progress,
            "weight_done": plan.weight_done,
            "weight_total": plan.weight_total,
            "tokens_used": plan.tokens_used,
            "tasks": [_task_state(t) for t in tasks],
        }
        row = Checkpoint(plan_id=plan_id, sequence=sequence, snapshot=snapshot, reason=reason)
        s.add(row)
        s.flush()
        checkpoint_id = row.id
    await bus.emit("checkpoint.saved", plan_id=plan_id, checkpoint_id=checkpoint_id,
                   sequence=sequence, reason=reason)
    return checkpoint_id


def latest(plan_id: str) -> dict | None:
    with session_scope() as s:
        row = (
            s.query(Checkpoint)
            .filter(Checkpoint.plan_id == plan_id)
            .order_by(Checkpoint.sequence.desc())
            .first()
        )
        if row is None:
            return None
        return {"id": row.id, "sequence": row.sequence, "snapshot": row.snapshot,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "reason": row.reason}


def history(plan_id: str, limit: int = 50) -> list[dict]:
    with session_scope() as s:
        rows = (
            s.query(Checkpoint)
            .filter(Checkpoint.plan_id == plan_id)
            .order_by(Checkpoint.sequence.desc())
            .limit(limit)
            .all()
        )
        return [
            {"id": r.id, "sequence": r.sequence, "reason": r.reason,
             "created_at": r.created_at.isoformat() if r.created_at else None,
             "task_count": len((r.snapshot or {}).get("tasks", []))}
            for r in rows
        ]


async def restore_interrupted() -> dict:
    """Called on startup: any task left 'running' by a crash goes back to 'pending'.

    The run is *not* restarted automatically — the founder presses Resume in the
    Command Center — but state is made consistent and the fact is reported.
    """
    repaired: list[str] = []
    with session_scope() as s:
        stuck = s.query(Task).filter(Task.status.in_(["running", "repairing"])).all()
        for task in stuck:
            task.status = "pending"
            task.error = (task.error or "") + "\n[interrupted by a backend restart; reset to pending]"
            repaired.append(task.id)
        plans = (
            s.query(Plan)
            .filter(Plan.state.in_(["executing", "scheduling", "verifying", "repairing", "integrating"]))
            .all()
        )
        plan_ids = [p.id for p in plans]
        for plan in plans:
            plan.state = "paused"
    if repaired or plan_ids:
        await bus.emit(
            "checkpoint.restored",
            tasks_reset=repaired,
            plans_paused=plan_ids,
            detail=f"{len(repaired)} in-flight task(s) were reset and {len(plan_ids)} plan(s) paused "
                   "by the restart. Press Resume to continue from the last checkpoint.",
        )
    return {"tasks_reset": repaired, "plans_paused": plan_ids}
