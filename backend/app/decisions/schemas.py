"""Decision-layer contracts (System 1).

The decision layer speaks the same three primitives as Convai Innovations'
``Laya`` model — ``choice``, ``score`` and ``noul`` — so a Laya runtime can be
dropped in without changing a single call site.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

QuestionType = Literal["choice", "score", "noul"]
EngineName = Literal["laya", "laya_mnn", "laya_hosted", "local", "llm"]


class Question(BaseModel):
    id: str
    type: QuestionType
    instructions: str
    #: ``choice`` -> mapping of label -> description of that label
    #: ``score``  -> ordered list of rubric labels (worst first)
    #: ``noul``   -> ignored
    criteria: dict[str, str] | list[str] | None = None
    #: caller-supplied signals.  Values are usually floats in ``[-1, 1]``
    #: (``structural``, ``evidence_ratio``, ``risk``, per-label priors) but some
    #: keys carry text or structure the engine reads directly: ``criteria_text``,
    #: ``task_text``, ``severity``, ``positive_terms``/``negative_terms`` and the
    #: ``_structural`` label->weight map used by ``choice`` questions.
    hints: dict[str, Any] = Field(default_factory=dict)
    #: False for informational sub-answers (a quality *rating*, a risk *level*).
    #: They are reported and persisted, but they must not drag the whole decision
    #: below the automation gate: one soft 3/5 rating would otherwise force an LLM
    #: round-trip on every task even when the hard verdict is certain.
    gating: bool = True


class DecisionRequest(BaseModel):
    decision_type: str
    state: dict[str, Any]
    questions: dict[str, Question]
    plan_id: str | None = None
    task_id: str | None = None


class Answer(BaseModel):
    question_id: str
    type: QuestionType
    #: ``choice`` -> label, ``noul`` -> bool, ``score`` -> rubric label
    value: Any = None
    #: ``noul`` -> P(true); ``score`` -> normalised expected value in [0, 1]
    probability: float = 0.0
    #: ``choice`` -> per-label probabilities; ``score`` -> per-step probabilities
    probabilities: dict[str, float] | list[float] | None = None
    confidence: float = 0.0


class DecisionResult(BaseModel):
    decision_type: str
    engine: EngineName
    answers: dict[str, Answer]
    #: minimum confidence across all answers (what the UI shows)
    confidence: float = 0.0
    #: minimum confidence across the *gating* answers - this is what the
    #: automation gate actually compares against the threshold
    gate_confidence: float = 0.0
    #: ``auto`` when confidence clears the threshold, otherwise ``escalate``
    action: Literal["auto", "escalate"] = "auto"
    fallback_used: bool = False
    latency_ms: float = 0.0
    state_hash: str = ""
    note: str = ""

    def answer(self, question_id: str) -> Answer | None:
        return self.answers.get(question_id)

    def value(self, question_id: str, default: Any = None) -> Any:
        ans = self.answers.get(question_id)
        return default if ans is None else ans.value

    def prob(self, question_id: str, default: float = 0.0) -> float:
        ans = self.answers.get(question_id)
        return default if ans is None else ans.probability


def _flatten(value: Any, depth: int = 0) -> str:
    if depth > 3:
        return "…"
    if isinstance(value, dict):
        return ", ".join(f"{k}={_flatten(v, depth + 1)}" for k, v in list(value.items())[:24])
    if isinstance(value, (list, tuple)):
        return ", ".join(_flatten(v, depth + 1) for v in list(value)[:24])
    return str(value)


def state_to_text(state: dict[str, Any] | str) -> str:
    """Flatten a decision state into the single text block a decision model sees."""
    if isinstance(state, str):
        return state
    parts: list[str] = []
    for key, value in state.items():
        if value is None or isinstance(value, (str, int, float, bool)):
            parts.append(f"{key}: {value}")
        else:
            parts.append(f"{key}: {_flatten(value)}")
    return "\n".join(parts)
