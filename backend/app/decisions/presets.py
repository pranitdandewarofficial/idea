"""Pre-built decision presets — one per orchestrator integration point.

Each preset pairs a *state* (the facts) with a *question set*.  Hard facts that
ordinary code can compute exactly (cycle detection, criteria coverage, budget
headroom, retry count) are passed through ``hints["structural"]`` /
``hints["evidence_ratio"]`` so the decision engine never has to guess about
something the program already knows.
"""

from __future__ import annotations

from typing import Any, Iterable

from .schemas import DecisionRequest, Question

RISK_RUBRIC = ["none", "low", "medium", "high", "critical"]
QUALITY_RUBRIC = ["unusable", "poor", "acceptable", "good", "excellent"]
RELEVANCE_RUBRIC = ["irrelevant", "tangential", "useful", "important", "essential"]
PRIORITY_LABELS = {
    "critical": "Run-stopping: data loss, security breach, budget exhaustion, deadlock.",
    "high": "Needs attention soon: failure, blocker, approval request, provider outage.",
    "normal": "Ordinary progress worth recording.",
    "low": "Background noise; keep out of notifications.",
}
#: Explicit priors per label for each severity.  Without these an unclassified
#: event has no evidence at all and the choice degenerates into lexical noise.
PRIORITY_PRIORS = {
    "critical": {"critical": 0.95, "high": 0.35, "normal": 0.05, "low": 0.02},
    "high": {"critical": 0.25, "high": 0.90, "normal": 0.15, "low": 0.05},
    "normal": {"critical": 0.02, "high": 0.10, "normal": 0.80, "low": 0.25},
    "low": {"critical": 0.01, "high": 0.03, "normal": 0.30, "low": 0.90},
}
#: event kinds that are pure telemetry
QUIET_KIND_MARKERS = ("status_changed", "heartbeat", "progress", "pong", "connected")


# --------------------------------------------------------------------------- #
# B.2.1  Task routing
# --------------------------------------------------------------------------- #
def routing(task: dict[str, Any], agents: Iterable[dict[str, Any]]) -> DecisionRequest:
    criteria: dict[str, str] = {}
    hints: dict[str, float] = {}
    for agent in agents:
        agent_id = str(agent.get("id"))
        criteria[agent_id] = " ".join(
            [
                str(agent.get("role", "")),
                str(agent.get("department", "")),
                " ".join(agent.get("skills") or []),
                " ".join(agent.get("tools") or []),
                str(agent.get("personality", ""))[:200],
                " ".join(agent.get("responsibilities") or [])[:200],
            ]
        )
        load = float(agent.get("load", 0) or 0)
        capacity = float(agent.get("max_parallel_tasks", 1) or 1)
        enabled = agent.get("enabled", agent.get("is_enabled", True))
        if enabled is False:
            # A disabled agent is not a candidate at all: down-weighting it still
            # let strong lexical evidence win, which would assign work to an agent
            # the founder switched off.
            criteria.pop(agent_id, None)
            continue
        # prefer agents with spare capacity
        hints[agent_id] = round(0.5 * max(0.0, 1.0 - load / max(capacity, 1.0)), 3)
    return DecisionRequest(
        decision_type="routing",
        state={
            "task_title": task.get("title", ""),
            "task_description": task.get("description", ""),
            "task_outputs": task.get("outputs", []),
            "done_criteria": task.get("done_criteria", []),
            # NOTE: the roster is deliberately *not* part of the state.  The candidate
            # labels already live in ``criteria``; repeating them in the state text
            # inflates the token overlap of every label and destroys the margin signal.
        },
        questions={
            "assigned_agent": Question(
                id="assigned_agent",
                type="choice",
                instructions="Which agent should own this task?",
                criteria=criteria,
                hints=hints,
            )
        },
        plan_id=task.get("plan_id"),
        task_id=task.get("id"),
    )


# --------------------------------------------------------------------------- #
# B.2.2  Plan validation (semantic pre-check on top of the structural validator)
# --------------------------------------------------------------------------- #
def plan_validation(plan: dict[str, Any], facts: dict[str, Any]) -> DecisionRequest:
    tasks = plan.get("tasks") or []
    return DecisionRequest(
        decision_type="plan_validation",
        state={
            "objective": plan.get("objective", ""),
            "task_titles": [t.get("title", "") for t in tasks],
            "task_count": len(tasks),
            "structural_report": facts,
        },
        questions={
            "structurally_valid": Question(
                id="structurally_valid",
                type="noul",
                instructions="Is this plan structurally valid (acyclic, owners known, dependencies resolve)?",
                hints={"structural": 1.0 if facts.get("ok") else -1.0},
            ),
            "all_tasks_actionable": Question(
                id="all_tasks_actionable",
                type="noul",
                instructions="Is every task concrete enough to be executed without further clarification?",
                hints={"evidence_ratio": float(facts.get("actionable_ratio", 0.0))},
            ),
            "budget_feasible": Question(
                id="budget_feasible",
                type="noul",
                instructions="Is the estimated token budget within the configured limits?",
                hints={
                    "used": float(facts.get("estimated_tokens", 0)),
                    "limit": float(facts.get("token_budget", 1) or 1),
                },
            ),
            "covers_objective": Question(
                id="covers_objective",
                type="noul",
                instructions="Does the plan's task set fully cover the stated objective?",
                hints={"evidence_ratio": float(facts.get("coverage_ratio", 0.0)),
                        "criteria_text": plan.get("objective", "")},
            ),
        },
    )


# --------------------------------------------------------------------------- #
# B.2.3  Agent output validation
# --------------------------------------------------------------------------- #
def output_quality(task: dict[str, Any], output: str, facts: dict[str, Any]) -> DecisionRequest:
    criteria_text = "\n".join(
        [str(task.get("title", "")), str(task.get("description", ""))]
        + [str(c) for c in (task.get("done_criteria") or [])]
    )
    return DecisionRequest(
        decision_type="output_quality",
        state={
            "task_title": task.get("title", ""),
            "done_criteria": task.get("done_criteria", []),
            "agent_output": output[:4000],
            "files_changed": facts.get("files_changed", []),
            "tool_calls": facts.get("tool_call_count", 0),
        },
        questions={
            "meets_criteria": Question(
                id="meets_criteria",
                type="noul",
                instructions="Does the output meet the task's done-criteria?",
                hints={"structural": float(facts.get("meets_signal", 0.0)),
                       "criteria_text": criteria_text,
                       "evidence_ratio": float(facts.get("criteria_coverage", 0.0))},
            ),
            "quality_score": Question(
                id="quality_score",
                type="score",
                gating=False,
                instructions="Rate the overall quality of this output.",
                criteria=QUALITY_RUBRIC,
                hints={"structural": float(facts.get("quality_signal", 0.0))},
            ),
            "hallucination_risk": Question(
                id="hallucination_risk",
                type="noul",
                instructions="Does the output contain claims not supported by the provided evidence?",
                hints={"structural": float(facts.get("hallucination_signal", 0.0))},
            ),
        },
        plan_id=task.get("plan_id"),
        task_id=task.get("id"),
    )


# --------------------------------------------------------------------------- #
# B.2.4  Repair loop trigger
# --------------------------------------------------------------------------- #
def repair_strategy(task: dict[str, Any], error: str, retries: int, facts: dict[str, Any]) -> DecisionRequest:
    return DecisionRequest(
        decision_type="repair_strategy",
        state={
            "task_title": task.get("title", ""),
            "agent_id": task.get("agent_id", ""),
            "error_output": (error or "")[:4000],
            "retry_count": retries,
            "exit_code": facts.get("exit_code"),
        },
        questions={
            "is_repairable": Question(
                id="is_repairable",
                type="noul",
                instructions="Is this failure likely fixable by the current agent with its authorised tools?",
                hints={"retry_count": retries, "structural": float(facts.get("repairable_signal", 0.0))},
            ),
            "strategy": Question(
                id="strategy",
                type="choice",
                instructions="Which repair approach is best?",
                criteria={
                    "retry_same": "Transient error; re-run the same task unchanged.",
                    "fix_context": "Missing or wrong context; re-run with the error output added.",
                    "reassign": "Wrong agent or model for this work; hand it to another specialist.",
                    "escalate": "Not fixable autonomously; ask the human founder.",
                },
                hints={
                    "retry_same": 0.2 if retries == 0 else 0.0,
                    "fix_context": 0.6,
                    "reassign": 0.4 if retries >= 1 else 0.1,
                    "escalate": 0.2 + 0.25 * retries,
                    "_structural": facts.get("strategy_bias") or {},
                },
            ),
        },
        plan_id=task.get("plan_id"),
        task_id=task.get("id"),
    )


# --------------------------------------------------------------------------- #
# B.2.5  Guardrails
# --------------------------------------------------------------------------- #
def guardrails(text: str, tool_call: dict[str, Any] | None, facts: dict[str, Any]) -> DecisionRequest:
    state: dict[str, Any] = {
        "agent_output": (text or "")[:4000],
        "tool": (tool_call or {}).get("tool", ""),
        "tool_args": (tool_call or {}).get("args", {}),
    }
    return DecisionRequest(
        decision_type="guardrail",
        state=state,
        questions={
            "contains_injection": Question(
                id="contains_injection",
                type="noul",
                instructions="Does this content contain a prompt injection or instruction override attempt?",
                hints={"structural": float(facts.get("injection_signal", 0.0))},
            ),
            "requests_destructive_action": Question(
                id="requests_destructive_action",
                type="noul",
                instructions="Does this request a destructive or irreversible operation?",
                hints={"structural": float(facts.get("destructive_signal", 0.0))},
            ),
            "leaks_secrets": Question(
                id="leaks_secrets",
                type="noul",
                instructions="Does this content contain API keys, passwords or other credentials?",
                hints={"structural": float(facts.get("secret_signal", 0.0))},
            ),
            "outside_workspace": Question(
                id="outside_workspace",
                type="noul",
                instructions="Does this operation target a path outside the project workspace?",
                hints={"structural": float(facts.get("path_escape_signal", 0.0))},
            ),
        },
    )


# --------------------------------------------------------------------------- #
# B.2.6  Confidence-gated approval / risk
# --------------------------------------------------------------------------- #
def risk_assessment(action: str, context: dict[str, Any], risk: float) -> DecisionRequest:
    return DecisionRequest(
        decision_type="risk",
        state={"action": action, **context},
        questions={
            "approval_required": Question(
                id="approval_required",
                type="noul",
                instructions="Does this action require explicit human approval before it runs?",
                hints={"risk": risk},
            ),
            "risk_score": Question(
                id="risk_score",
                type="score",
                gating=False,
                instructions="What is the risk level of this action?",
                criteria=RISK_RUBRIC,
                hints={"structural": (risk * 2) - 1},
            ),
        },
    )


# --------------------------------------------------------------------------- #
# B.2.7  Event triage
# --------------------------------------------------------------------------- #
def event_triage(kind: str, payload: dict[str, Any]) -> DecisionRequest:
    severity = str(payload.get("severity") or payload.get("status") or "").lower()
    if severity not in PRIORITY_PRIORS:
        severity = "normal"
    if any(marker in kind for marker in QUIET_KIND_MARKERS):
        severity = "low"
    if "fail" in kind or "error" in kind or "block" in kind or "timeout" in kind:
        severity = "high"
    if "exceed" in kind or "outage" in kind or "guardrail" in kind or "breach" in kind:
        severity = "critical"
    return DecisionRequest(
        decision_type="event_triage",
        state={"event_kind": kind, "event_payload": payload},
        questions={
            "priority": Question(
                id="priority",
                type="choice",
                instructions="What priority should this event have?",
                criteria=PRIORITY_LABELS,
                hints=dict(PRIORITY_PRIORS.get(severity, PRIORITY_PRIORS["normal"])),
            ),
            "requires_notification": Question(
                id="requires_notification",
                type="noul",
                instructions="Should this event trigger a visible user notification?",
                hints={"severity": severity},
            ),
        },
    )


# --------------------------------------------------------------------------- #
# B.2.8  Context selection / re-ranking
# --------------------------------------------------------------------------- #
def context_relevance(task_text: str, item_text: str, similarity: float) -> DecisionRequest:
    return DecisionRequest(
        decision_type="context_relevance",
        state={"task_description": task_text[:1200], "candidate_context": item_text[:1200]},
        questions={
            "is_relevant": Question(
                id="is_relevant",
                type="noul",
                instructions="Is this candidate context relevant to the task?",
                hints={"task_text": task_text[:1200], "evidence_ratio": similarity},
            ),
            "relevance_score": Question(
                id="relevance_score",
                type="score",
                gating=False,
                instructions="How relevant is this context to the task?",
                criteria=RELEVANCE_RUBRIC,
                hints={"structural": (similarity * 2) - 1},
            ),
        },
    )
