"""Decision Lab endpoints: stats, history, live probe and Laya runtime status."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..api.errors import ApiError
from ..db import session_scope
from ..decisions import presets
from ..decisions.laya_adapter import laya
from ..decisions.schemas import DecisionRequest, Question
from ..decisions.service import service as decisions
from ..models import DecisionRecord
from ..schemas import DecisionProbe
from ..security.auth import require_auth

router = APIRouter(prefix="/api/decisions", tags=["decisions"], dependencies=[Depends(require_auth)])


@router.get("/status")
def status() -> dict[str, Any]:
    from ..decisions.router import TYPE_STRICTNESS, router

    return {
        "stats": decisions.stats(),
        "laya": laya.status.as_dict(),
        "threshold": decisions.threshold,
        "thresholds_by_type": router.thresholds_by_type(),
        "type_strictness": dict(sorted(TYPE_STRICTNESS.items())),
        "enabled": decisions.enabled,
    }


@router.post("/status/refresh")
async def refresh_status() -> dict[str, Any]:
    """Re-detect the Laya runtime and warm it up.  Reports the real outcome."""
    result = await laya.warmup()
    return {"laya": result.as_dict(), "stats": decisions.stats()}


@router.get("")
def history(
    decision_type: str | None = None,
    engine: str | None = None,
    plan_id: str | None = None,
    task_id: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    with session_scope() as s:
        query = s.query(DecisionRecord)
        if decision_type:
            query = query.filter(DecisionRecord.decision_type == decision_type)
        if engine:
            query = query.filter(DecisionRecord.engine == engine)
        if plan_id:
            query = query.filter(DecisionRecord.plan_id == plan_id)
        if task_id:
            query = query.filter(DecisionRecord.task_id == task_id)
        rows = query.order_by(DecisionRecord.created_at.desc()).limit(min(limit, 500)).all()
        return {
            "items": [
                {
                    "id": r.id, "decision_type": r.decision_type, "engine": r.engine,
                    "confidence": r.confidence, "action": r.action, "fallback_used": r.fallback_used,
                    "latency_ms": r.latency_ms, "state_hash": r.state_hash,
                    "answers": r.answers, "plan_id": r.plan_id, "task_id": r.task_id,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ]
        }


@router.get("/types")
def decision_types() -> dict[str, Any]:
    return {
        "items": [
            {"type": "routing", "primitive": "choice",
             "purpose": "Pick the agent that should own a task."},
            {"type": "plan_validation", "primitive": "noul",
             "purpose": "Semantic pre-check on a generated plan."},
            {"type": "output_quality", "primitive": "noul + score",
             "purpose": "Gate an agent's output before it enters the next task's context."},
            {"type": "repair_strategy", "primitive": "noul + choice",
             "purpose": "Decide whether a failure is repairable and how."},
            {"type": "guardrail", "primitive": "noul",
             "purpose": "Injection, destructive action, secret leak and path escape checks."},
            {"type": "risk", "primitive": "noul + score",
             "purpose": "Confidence-gated human approval."},
            {"type": "event_triage", "primitive": "choice + noul",
             "purpose": "Priority and notification decisions for the activity stream."},
            {"type": "context_relevance", "primitive": "noul + score",
             "purpose": "Re-rank retrieved memory and knowledge."},
        ]
    }


@router.post("/probe")
async def probe(body: DecisionProbe) -> dict[str, Any]:
    """Run one decision through the real pipeline (used by the Test button)."""
    if body.decision_type == "routing":
        from ..agents.profiles import PROFILES, as_dict

        agents = [
            {**as_dict(p), "load": 0, "enabled": True, "max_parallel_tasks": p.max_parallel_tasks}
            for p in PROFILES
            if not p.is_decision_agent and p.id != "ceo"
        ]
        task = {
            "id": "probe",
            "title": str(body.state.get("task_title") or "Probe task"),
            "description": str(body.state.get("task_description") or "Write a pytest test suite for the API."),
        }
        request = presets.routing(task, agents)
    elif body.decision_type == "guardrail":
        request = presets.guardrails(
            str(body.state.get("text") or ""),
            body.state.get("tool_call"),
            {
                "injection_signal": float(body.state.get("injection_signal", -1.0)),
                "destructive_signal": float(body.state.get("destructive_signal", -1.0)),
                "secret_signal": float(body.state.get("secret_signal", -1.0)),
                "path_escape_signal": float(body.state.get("path_escape_signal", -1.0)),
            },
        )
    elif body.questions:
        questions = {}
        for qid, raw in body.questions.items():
            try:
                questions[qid] = Question.model_validate({"id": qid, **raw})
            except Exception as exc:  # noqa: BLE001
                raise ApiError("invalid_question", f"Question '{qid}' is invalid: {exc}", status=422)
        request = DecisionRequest(decision_type=body.decision_type, state=body.state, questions=questions)
    else:
        raise ApiError(
            "invalid_probe",
            "Provide either a known decision_type ('routing' or 'guardrail') or an explicit "
            "'questions' map.",
            status=422,
        )

    result = await decisions.decide(request, use_cache=False)
    return {
        "decision_type": result.decision_type,
        "engine": result.engine,
        "confidence": result.confidence,
        "action": result.action,
        "latency_ms": result.latency_ms,
        "fallback_used": result.fallback_used,
        "note": result.note,
        "answers": {qid: a.model_dump() for qid, a in result.answers.items()},
        "threshold": decisions.threshold,
    }


@router.get("/calibration")
def calibration() -> dict[str, Any]:
    """Confidence distribution over recorded decisions (for threshold tuning)."""
    with session_scope() as s:
        rows = s.query(DecisionRecord).all()
    buckets = {f"{i/10:.1f}-{(i+1)/10:.1f}": 0 for i in range(10)}
    for row in rows:
        index = min(int(row.confidence * 10), 9)
        key = f"{index/10:.1f}-{(index+1)/10:.1f}"
        buckets[key] = buckets.get(key, 0) + 1
    return {
        "total": len(rows),
        "buckets": buckets,
        "threshold": decisions.threshold,
        "note": "Accuracy-vs-confidence calibration requires a labelled set; see "
                "backend/tests/test_decisions.py::test_confidence_is_separable and "
                "docs/decisions/ADR-0004-decision-layer.md.",
    }
