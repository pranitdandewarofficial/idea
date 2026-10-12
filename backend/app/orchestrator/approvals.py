"""Human-in-the-loop approval gate.

Two paths to a "yes":

1. **Auto-approve** — only for low-risk actions, only when the System-1 decision
   engine says approval is not required *with confidence above the threshold*,
   and only when ``auto_approve_low_risk`` is enabled.  Every auto-approval is
   audited with the confidence that produced it.
2. **Human decision** — an ``Approval`` row is created, an event is emitted, the
   requesting tool call blocks until the founder approves or denies it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..config import settings
from ..db import session_scope
from ..decisions import presets
from ..decisions.service import service as decisions
from ..events import bus
from ..models import Approval, AuditRecord, get_setting
from ..tools.context import ToolContext

log = logging.getLogger("pranit.approvals")


class ApprovalGate:
    def __init__(self) -> None:
        self._waiters: dict[str, asyncio.Event] = {}
        self._decisions: dict[str, bool] = {}

    async def resolve_tool_call(
        self, tool: str, args: dict[str, Any], risk: float, ctx: ToolContext
    ) -> bool:
        auto_ok = await self._maybe_auto_approve(tool, args, risk, ctx)
        if auto_ok:
            return True
        return await self.request(
            action=tool,
            detail={"args": args, "agent_id": ctx.agent_id, "task_id": ctx.task_id,
                    "project_id": ctx.project_id},
            risk=risk,
            plan_id=ctx.plan_id,
            task_id=ctx.task_id,
        )

    async def _maybe_auto_approve(
        self, tool: str, args: dict[str, Any], risk: float, ctx: ToolContext
    ) -> bool:
        if not bool(get_setting("auto_approve_low_risk", settings.auto_approve_low_risk)):
            return False
        threshold = float(get_setting("low_risk_threshold", settings.low_risk_threshold))
        if risk > threshold:
            return False
        # Always ask a human about irreversible or externally-visible operations.
        if tool in ("git_push", "delete_file"):
            return False
        result = await decisions.decide(
            presets.risk_assessment(
                tool,
                {"args": args, "agent_id": ctx.agent_id, "workspace": str(ctx.root)},
                risk,
            )
        )
        if result.action != "auto":
            return False
        if result.value("approval_required") is not False:
            return False
        self._audit(
            actor=f"decision:{result.engine}",
            action="approval.auto_granted",
            target=tool,
            context={"risk": risk, "confidence": result.confidence, "task_id": ctx.task_id},
        )
        await bus.emit(
            "approval.auto_granted",
            action=tool,
            risk=risk,
            confidence=result.confidence,
            engine=result.engine,
            task_id=ctx.task_id,
            plan_id=ctx.plan_id,
        )
        return True

    async def request(
        self,
        *,
        action: str,
        detail: dict[str, Any],
        risk: float,
        plan_id: str | None = None,
        task_id: str | None = None,
        requested_by: str = "orchestrator",
    ) -> bool:
        risk_label = "critical" if risk >= 0.8 else "high" if risk >= 0.6 else "medium" if risk >= 0.35 else "low"
        with session_scope() as s:
            row = Approval(
                plan_id=plan_id,
                task_id=task_id,
                requested_by=requested_by,
                action=action,
                detail=detail,
                risk=risk_label,
                risk_score=float(risk),
                status="pending",
            )
            s.add(row)
            s.flush()
            approval_id = row.id

        event = asyncio.Event()
        self._waiters[approval_id] = event
        await bus.emit(
            "approval.requested",
            approval_id=approval_id,
            action=action,
            risk=risk_label,
            risk_score=risk,
            detail=detail,
            plan_id=plan_id,
            task_id=task_id,
        )

        timeout = int(get_setting("approval_timeout_seconds", settings.approval_timeout_seconds) or 0)
        try:
            if timeout > 0:
                await asyncio.wait_for(event.wait(), timeout=timeout)
            else:
                await event.wait()
        except asyncio.TimeoutError:
            self.decide(approval_id, False, note=f"No decision within {timeout}s; denied by policy.")
        except asyncio.CancelledError:
            self.decide(approval_id, False, note="Run cancelled while waiting for approval.")
            raise
        finally:
            self._waiters.pop(approval_id, None)

        approved = self._decisions.pop(approval_id, False)
        await bus.emit(
            "approval.approved" if approved else "approval.denied",
            approval_id=approval_id,
            action=action,
            plan_id=plan_id,
            task_id=task_id,
        )
        return approved

    def decide(self, approval_id: str, approved: bool, note: str = "") -> bool:
        from ..models import now as _now

        with session_scope() as s:
            row = s.get(Approval, approval_id)
            if row is None:
                return False
            row.status = "approved" if approved else "denied"
            row.decided_at = _now()
            row.decision_note = note[:2000] or None
            s.add(
                AuditRecord(
                    actor="founder",
                    action=f"approval.{'approved' if approved else 'denied'}",
                    target=approval_id,
                    result="ok",
                    context={"action": row.action, "note": note[:500]},
                )
            )
        self._decisions[approval_id] = approved
        event = self._waiters.get(approval_id)
        if event is not None:
            event.set()
        return True

    def pending(self) -> list[dict]:
        with session_scope() as s:
            rows = s.query(Approval).filter(Approval.status == "pending").all()
            return [
                {
                    "id": r.id,
                    "action": r.action,
                    "risk": r.risk,
                    "risk_score": r.risk_score,
                    "detail": r.detail,
                    "plan_id": r.plan_id,
                    "task_id": r.task_id,
                    "requested_by": r.requested_by,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ]

    def _audit(self, *, actor: str, action: str, target: str, context: dict) -> None:
        try:
            with session_scope() as s:
                s.add(AuditRecord(actor=actor, action=action, target=target, result="ok", context=context))
        except Exception as exc:  # pragma: no cover
            log.warning("audit write failed: %s", exc)


gate = ApprovalGate()
