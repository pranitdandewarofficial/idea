"""System-2 fallback: ask a reasoning model to re-make a low-confidence decision.

Only used when the System-1 confidence is below the threshold, a provider is
available, and ``PRANIT_DECISION_FALLBACK_TO_LLM`` is on.  The model is forced
into the same typed answer space, so its reply can never wander.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..protocol import DECISION_MARKER, extract_json
from ..providers.base import ProviderError
from ..providers.registry import providers
from .schemas import Answer, DecisionRequest, DecisionResult

log = logging.getLogger("pranit.decisions.llm")

SYSTEM = "\n".join(
    [
        DECISION_MARKER,
        "You are the System-2 reasoning layer of PRANIT AI CITY.",
        "A fast decision engine answered with low confidence. Re-answer the same typed questions.",
        "Reply with ONLY a JSON object of the form:",
        '{"answers": {"<question_id>": <value>}}',
        "Value rules: a 'choice' question takes one of its criteria keys; a 'score' question takes one",
        "of its ordered rubric labels; a 'noul' question takes true or false.",
        "Do not add commentary. Do not invent new question ids.",
    ]
)


def _describe(request: DecisionRequest) -> str:
    questions = {}
    for qid, question in request.questions.items():
        questions[qid] = {
            "type": question.type,
            "instructions": question.instructions,
            "criteria": question.criteria,
        }
    return json.dumps(
        {"state": request.state, "questions": questions, "system1_confidence": None},
        ensure_ascii=False,
        default=str,
    )[:12_000]


async def llm_fallback(request: DecisionRequest, first_pass: DecisionResult) -> DecisionResult | None:
    try:
        provider_id, model = providers.pick(role="reasoning")
    except ProviderError as exc:
        log.info("no provider available for decision fallback: %s", exc.message)
        return None

    prompt = _describe(request) + (
        f"\n\nThe System-1 engine ({first_pass.engine}) answered with confidence "
        f"{first_pass.confidence:.2f}:\n"
        + json.dumps({qid: a.model_dump() for qid, a in first_pass.answers.items()}, default=str)[:2000]
    )
    try:
        completion = await providers.complete(
            provider_id=provider_id,
            model=model,
            system=SYSTEM,
            user=prompt,
            max_tokens=400,
            temperature=0.0,
            purpose="decision_fallback",
        )
    except ProviderError as exc:
        log.warning("decision fallback failed: %s", exc.message)
        return None

    parsed = extract_json(completion.text)
    if not isinstance(parsed, dict):
        return None
    raw_answers: dict[str, Any] = parsed.get("answers") or {}
    if not isinstance(raw_answers, dict):
        return None

    answers: dict[str, Answer] = {}
    for qid, question in request.questions.items():
        if qid not in raw_answers:
            keep = first_pass.answers.get(qid)
            if keep is not None:
                answers[qid] = keep
            continue
        value = raw_answers[qid]
        if question.type == "noul":
            value = bool(value) if not isinstance(value, str) else value.strip().lower() in ("true", "yes", "1")
            answers[qid] = Answer(question_id=qid, type="noul", value=value,
                                  probability=1.0 if value else 0.0, confidence=0.85,
                                  probabilities={"true": 1.0 if value else 0.0,
                                                 "false": 0.0 if value else 1.0})
        elif question.type == "choice":
            criteria = question.criteria if isinstance(question.criteria, dict) else {}
            label = str(value)
            if criteria and label not in criteria:
                match = next((k for k in criteria if k.lower() == label.lower()), None)
                if match is None:
                    continue
                label = match
            answers[qid] = Answer(question_id=qid, type="choice", value=label, probability=1.0,
                                  confidence=0.85, probabilities={label: 1.0})
        else:
            rubric = question.criteria if isinstance(question.criteria, list) else []
            label = str(value)
            if rubric and label not in [str(r) for r in rubric]:
                match = next((r for r in rubric if str(r).lower() == label.lower()), None)
                if match is None:
                    continue
                label = str(match)
            index = [str(r) for r in rubric].index(label) if rubric else 0
            normalised = index / max(len(rubric) - 1, 1) if rubric else 0.0
            answers[qid] = Answer(question_id=qid, type="score", value=label,
                                  probability=round(normalised, 4), confidence=0.85)

    if not answers:
        return None
    # 0.85, not 1.0: a typed answer from a reasoning model is strong evidence but
    # it is not a proof, and it must still clear the same gate as System 1.
    confidence = min(a.confidence for a in answers.values())
    gating = [a.confidence for qid, a in answers.items()
              if request.questions.get(qid) is None or request.questions[qid].gating]
    gate_confidence = min(gating, default=confidence)
    from .router import router

    threshold = router.threshold_for(request.decision_type)
    return DecisionResult(
        decision_type=request.decision_type,
        engine="llm",
        answers=answers,
        confidence=round(confidence, 4),
        gate_confidence=round(gate_confidence, 4),
        action="auto" if gate_confidence >= threshold else "escalate",
        fallback_used=True,
    )
