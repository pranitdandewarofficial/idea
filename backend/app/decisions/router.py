"""Decision router — System 1 (Laya / local engine) with System 2 (LLM) fallback."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

from ..config import settings
from . import local_engine
from .laya_adapter import LayaUnavailable, laya
from .schemas import Answer, DecisionRequest, DecisionResult

log = logging.getLogger("pranit.decisions")

LLMFallback = Callable[[DecisionRequest, DecisionResult], Awaitable[DecisionResult | None]]

#: Not every decision carries the same cost of being wrong.  A routing choice is
#: cheap and reversible (the orchestrator can reassign, and the planner's own
#: choice is kept whenever the engine is unsure), while a guardrail or approval
#: verdict is not.  The effective gate is ``global_threshold * strictness`` so a
#: founder who lowers the global threshold still keeps the ordering.
TYPE_STRICTNESS: dict[str, float] = {
    "routing": 0.70,
    "context_relevance": 0.65,
    "event_triage": 0.65,
    "plan_validation": 0.85,
    "repair_strategy": 0.85,
    "output_quality": 0.90,
    "guardrail": 1.00,
    "risk_assessment": 1.00,
}


class DecisionRouter:
    """Chooses the engine for a decision and applies the confidence gate.

    Order of preference:

    1. **Laya** (local ``laya``/``laya_mnn`` package, or a hosted endpoint) when
       installed and loadable — non-autoregressive, ~35 ms, calibrated.
    2. **Local deterministic engine** — always available, transparent heuristics.
    3. **LLM (System 2)** — only when the System-1 confidence is below the
       configured threshold and a fallback has been registered.
    """

    def __init__(self) -> None:
        self._llm_fallback: LLMFallback | None = None
        self._laya_disabled_until: float = 0.0

    def register_llm_fallback(self, fn: LLMFallback | None) -> None:
        self._llm_fallback = fn

    @property
    def threshold(self) -> float:
        from ..models import get_setting

        try:
            return float(get_setting("decision_confidence_threshold", settings.decision_confidence_threshold))
        except Exception:  # pragma: no cover - db not ready
            return settings.decision_confidence_threshold

    def threshold_for(self, decision_type: str) -> float:
        """Effective confidence gate for one decision type."""
        strictness = TYPE_STRICTNESS.get(decision_type, 1.0)
        return round(self.threshold * strictness, 4)

    def thresholds_by_type(self) -> dict[str, float]:
        base = self.threshold
        return {k: round(base * v, 4) for k, v in sorted(TYPE_STRICTNESS.items())}

    async def decide(self, request: DecisionRequest) -> DecisionResult:
        started = time.perf_counter()
        engine = "local"
        note = ""
        answers: dict[str, Answer] = {}

        mode = (settings.decision_mode or "auto").lower()
        use_laya = mode in ("auto", "laya", "laya_mnn", "laya_hosted") and time.time() > self._laya_disabled_until

        if use_laya:
            try:
                if await laya.health():
                    answers = await asyncio.wait_for(laya.predict(request.state, request.questions), timeout=20)
                    engine = laya.status.mode
            except LayaUnavailable as exc:
                note = f"laya unavailable: {exc}"
                self._laya_disabled_until = time.time() + 300  # stop retrying every call
            except asyncio.TimeoutError:
                note = "laya timed out after 20s"
                self._laya_disabled_until = time.time() + 300
            except Exception as exc:  # pragma: no cover - environment specific
                note = f"laya error: {type(exc).__name__}: {exc}"
                self._laya_disabled_until = time.time() + 300
                log.warning("Laya prediction failed: %s", note)

        if not answers:
            answers = {qid: local_engine.answer(q, request.state) for qid, q in request.questions.items()}
            if engine != "local":
                engine = "local"

        confidence = min((a.confidence for a in answers.values()), default=0.0)
        gating = [
            a.confidence for qid, a in answers.items()
            if request.questions.get(qid) is None or request.questions[qid].gating
        ]
        gate_confidence = min(gating, default=confidence)
        gate = self.threshold_for(request.decision_type)
        action = "auto" if gate_confidence >= gate else "escalate"
        result = DecisionResult(
            decision_type=request.decision_type,
            engine=engine,  # type: ignore[arg-type]
            answers=answers,
            confidence=round(confidence, 4),
            gate_confidence=round(gate_confidence, 4),
            action=action,
            latency_ms=round((time.perf_counter() - started) * 1000, 2),
            note=note or ("" if action == "auto" else f"below the {gate:.2f} gate for {request.decision_type}"),
        )

        if action == "escalate" and self._llm_fallback is not None and settings.decision_fallback_to_llm:
            try:
                escalated = await asyncio.wait_for(self._llm_fallback(request, result), timeout=60)
                if escalated is not None:
                    escalated.fallback_used = True
                    escalated.latency_ms = round((time.perf_counter() - started) * 1000, 2)
                    escalated.note = (result.note + " | escalated to System 2 (LLM)").strip(" |")
                    return escalated
            except Exception as exc:
                log.warning("LLM decision fallback failed: %s", exc)
                result.note = (result.note + f" | llm fallback failed: {type(exc).__name__}").strip(" |")

        return result


router = DecisionRouter()
