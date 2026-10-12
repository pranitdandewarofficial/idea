"""The Decision Service — the single entry point for every System-1 decision."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict

from ..config import settings
from ..db import session_scope
from ..events import bus
from ..models import DecisionRecord, get_setting
from .laya_adapter import laya
from .router import router
from .schemas import DecisionRequest, DecisionResult

log = logging.getLogger("pranit.decisions")


def _state_hash(request: DecisionRequest) -> str:
    canonical = json.dumps(
        {
            "type": request.decision_type,
            "state": request.state,
            "questions": sorted(request.questions.keys()),
            "instructions": {qid: q.instructions for qid, q in sorted(request.questions.items())},
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _truncate_state(request: DecisionRequest) -> DecisionRequest:
    limit = settings.decision_max_state_chars
    state = request.state
    encoded = json.dumps(state, default=str)
    if len(encoded) <= limit:
        return request
    clipped: dict = {}
    for key, value in state.items():
        text = value if isinstance(value, str) else json.dumps(value, default=str)
        clipped[key] = text[: max(200, limit // max(len(state), 1))]
    request = request.model_copy(update={"state": clipped})
    request.state["_truncated"] = True
    return request


class DecisionService:
    """decide(state, questions) -> answers + confidence + engine + latency.

    Every decision is persisted (``DecisionRecord``) and emitted on the event
    bus, so the whole decision history of a run is auditable and replayable.
    """

    def __init__(self, cache_size: int = 512) -> None:
        self._cache: OrderedDict[str, tuple[float, DecisionResult]] = OrderedDict()
        self._cache_size = cache_size
        self._count = 0

    @property
    def enabled(self) -> bool:
        try:
            return bool(get_setting("decisions_enabled", settings.decisions_enabled))
        except Exception:  # pragma: no cover - db not ready
            return settings.decisions_enabled

    async def decide(self, request: DecisionRequest, *, use_cache: bool = True) -> DecisionResult:
        if not self.enabled:
            return DecisionResult(
                decision_type=request.decision_type,
                engine="local",
                answers={},
                confidence=1.0,
                action="auto",
                note="decision layer disabled - orchestrator used its deterministic code defaults",
                state_hash=_state_hash(request),
            )

        request = _truncate_state(request)
        key = _state_hash(request)
        request_state_hash = key

        if use_cache:
            hit = self._cache.get(key)
            if hit is not None:
                expires_at, cached = hit
                if expires_at > time.time():
                    self._cache.move_to_end(key)
                    return cached.model_copy(update={"note": (cached.note + " | cache hit").strip(" |")})
                self._cache.pop(key, None)

        started = time.perf_counter()
        result = await router.decide(request)
        result.state_hash = request_state_hash
        result.latency_ms = round((time.perf_counter() - started) * 1000, 2)

        if use_cache and result.decision_type in ("routing", "context_relevance", "event_triage"):
            self._cache[key] = (time.time() + 120, result)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)

        self._count += 1
        self._persist(request, result)
        await self._announce(request, result)
        return result

    def _persist(self, request: DecisionRequest, result: DecisionResult) -> None:
        try:
            with session_scope() as s:
                s.add(
                    DecisionRecord(
                        plan_id=request.plan_id,
                        task_id=request.task_id,
                        decision_type=request.decision_type,
                        engine=result.engine,
                        state_hash=result.state_hash,
                        questions={qid: q.model_dump(exclude_none=True) for qid, q in request.questions.items()},
                        answers={qid: a.model_dump() for qid, a in result.answers.items()},
                        confidence=result.confidence,
                        action=result.action,
                        fallback_used=result.fallback_used,
                        latency_ms=result.latency_ms,
                    )
                )
        except Exception as exc:  # pragma: no cover - never break a run on bookkeeping
            log.warning("could not persist decision record: %s", exc)

    async def _announce(self, request: DecisionRequest, result: DecisionResult) -> None:
        summary = {
            qid: {"value": a.value, "confidence": a.confidence, "probability": a.probability}
            for qid, a in result.answers.items()
        }
        await bus.emit(
            "decision.made",
            decision_type=request.decision_type,
            engine=result.engine,
            confidence=result.confidence,
            action=result.action,
            latency_ms=result.latency_ms,
            plan_id=request.plan_id,
            task_id=request.task_id,
            answers=summary,
            state_hash=result.state_hash[:12],
        )
        if result.action == "escalate":
            await bus.emit(
                "decision.low_confidence",
                decision_type=request.decision_type,
                confidence=result.confidence,
                threshold=self.threshold,
                fallback_used=result.fallback_used,
                plan_id=request.plan_id,
                task_id=request.task_id,
            )
        if result.fallback_used:
            await bus.emit(
                "decision.fallback",
                decision_type=request.decision_type,
                engine=result.engine,
                plan_id=request.plan_id,
                task_id=request.task_id,
            )

    @property
    def threshold(self) -> float:
        return router.threshold

    def stats(self) -> dict:
        with session_scope() as s:
            rows = s.query(DecisionRecord).all()
        if not rows:
            return {
                "total": 0,
                "by_engine": {},
                "avg_latency_ms": 0.0,
                "avg_confidence": 0.0,
                "fallback_rate": 0.0,
                "escalation_rate": 0.0,
                "laya": laya.status.as_dict(),
                "threshold": self.threshold,
                "enabled": self.enabled,
            }
        total = len(rows)
        by_engine: dict[str, int] = {}
        for row in rows:
            by_engine[row.engine] = by_engine.get(row.engine, 0) + 1
        return {
            "total": total,
            "by_engine": by_engine,
            "avg_latency_ms": round(sum(r.latency_ms for r in rows) / total, 2),
            "avg_confidence": round(sum(r.confidence for r in rows) / total, 4),
            "fallback_rate": round(sum(1 for r in rows if r.fallback_used) / total, 4),
            "escalation_rate": round(sum(1 for r in rows if r.confidence < self.threshold) / total, 4),
            "laya": laya.status.as_dict(),
            "threshold": self.threshold,
            "enabled": self.enabled,
        }


service = DecisionService()
