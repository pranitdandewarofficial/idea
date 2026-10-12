"""Deterministic event triage.

Maps an event kind to a priority and a ``notify`` flag.  This table is the fast
path; the System-1 Decision Service may override it for high-stakes kinds
(see ``TRIAGE_DECISION_KINDS``).
"""

from __future__ import annotations

CRITICAL: dict[str, bool] = {
    "provider.outage": True,
    "budget.exceeded": True,
    "guardrail.triggered": True,
    "plan.blocked": True,
    "security.finding": True,
}

HIGH: dict[str, bool] = {
    "task.failed": True,
    "task.timeout": True,
    "plan.failed": True,
    "approval.requested": True,
    "provider.rate_limited": False,
    "decision.low_confidence": False,
    "tool.denied": False,
    "budget.warning": True,
}

NOTIFY_ON_SUCCESS: dict[str, bool] = {
    "plan.finished": True,
    "task.completed": False,
    "approval.approved": False,
    "approval.denied": True,
    "preview.started": True,
    "provider.test_succeeded": False,
    "provider.test_failed": True,
    "checkpoint.restored": True,
}

#: Event kinds whose priority is decided by the System-1 decision engine
#: rather than the static table above.
TRIAGE_DECISION_KINDS: frozenset[str] = frozenset(
    {"task.failed", "security.finding", "guardrail.triggered", "approval.requested", "plan.blocked"}
)


def classify(kind: str, payload: dict | None = None) -> tuple[str, bool]:
    """Return ``(priority, notify)`` for an event kind."""
    payload = payload or {}
    if kind in CRITICAL:
        return "critical", True
    if kind in HIGH:
        return "high", HIGH[kind]
    if kind in NOTIFY_ON_SUCCESS:
        return "normal", NOTIFY_ON_SUCCESS[kind]
    if payload.get("notify") is True:
        return "normal", True
    return "low", False
