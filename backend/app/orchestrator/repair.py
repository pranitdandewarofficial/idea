"""Repair loop — bounded self-correction with real error context.

A failure is not the end of a run; it is input.  The strategy is chosen by the
System-1 decision layer using hard signals computed in code (exit codes, error
classes, retry count), and the number of attempts is capped.
"""

from __future__ import annotations

from typing import Any

from ..config import settings
from ..decisions import presets
from ..decisions.service import service as decisions
from ..models import get_setting
from ..providers.base import ProviderError

RETRYABLE_PROVIDER_CODES = {"provider_rate_limited", "provider_server_error", "provider_timeout"}

FATAL_ERROR_MARKERS = (
    "zero_spend_blocked",
    "provider_auth_error",
    "invalid api key",
    "permission denied",
    "no ai provider is configured",
    "budget exhausted",
    "could not reach",
)


def classify_error(error: str, exit_code: int | None = None, exception: BaseException | None = None) -> dict[str, Any]:
    """Compute the hard signals the decision layer needs."""
    text = (error or "").lower()
    code = getattr(exception, "code", None)

    fatal = code in ("zero_spend_blocked", "provider_auth_error") or any(
        marker in text for marker in FATAL_ERROR_MARKERS
    )
    provider_transient = code in RETRYABLE_PROVIDER_CODES
    policy_denied = "blocked by policy" in text or "not on the allowlist" in text or "denied:" in text
    contract_violation = "output contract not satisfied" in text
    verification_failure = exit_code not in (None, 0)
    repairable_signal = 0.0
    if provider_transient:
        repairable_signal = 0.9
    elif contract_violation:
        repairable_signal = 0.8
    elif verification_failure:
        repairable_signal = 0.7
    elif policy_denied:
        repairable_signal = -0.9
    elif fatal:
        repairable_signal = -1.0
    else:
        repairable_signal = 0.4

    strategy_bias: dict[str, float] = {}
    if provider_transient:
        strategy_bias = {"retry_same": 1.0}
    elif policy_denied:
        strategy_bias = {"escalate": 1.0}
    elif fatal:
        strategy_bias = {"escalate": 1.0}
    elif contract_violation:
        strategy_bias = {"fix_context": 0.8}
    elif verification_failure:
        strategy_bias = {"fix_context": 0.6, "reassign": 0.2}

    return {
        "fatal": fatal,
        "provider_transient": provider_transient,
        "policy_denied": policy_denied,
        "contract_violation": contract_violation,
        "verification_failure": verification_failure,
        "repairable_signal": repairable_signal,
        "strategy_bias": strategy_bias,
    }


def max_repairs() -> int:
    return int(get_setting("max_repairs", settings.max_repairs))


async def decide_strategy(
    task: dict[str, Any],
    error: str,
    retries: int,
    facts: dict[str, Any],
    exit_code: int | None = None,
) -> dict[str, Any]:
    """Return ``{"strategy", "repairable", "confidence", "engine", "reason"}``."""
    signals = classify_error(error, exit_code)
    merged = {**signals, **{k: v for k, v in facts.items() if k not in signals}}
    merged["exit_code"] = exit_code
    merged["repairable_signal"] = float(facts.get("repairable_signal", signals["repairable_signal"]))
    if facts.get("strategy_bias"):
        merged["strategy_bias"] = facts["strategy_bias"]

    if signals["fatal"]:
        return {
            "strategy": "escalate",
            "repairable": False,
            "confidence": 1.0,
            "engine": "code",
            "reason": "The failure is not repairable by an agent (credential, spend or policy problem).",
        }
    if retries >= max_repairs():
        return {
            "strategy": "escalate",
            "repairable": False,
            "confidence": 1.0,
            "engine": "code",
            "reason": f"Repair budget exhausted ({retries}/{max_repairs()} attempts used).",
        }

    request = presets.repair_strategy(task, error, retries, merged)
    result = await decisions.decide(request)
    strategy = str(result.value("strategy", "fix_context"))
    repairable = bool(result.value("is_repairable", True))
    if not repairable and strategy != "escalate":
        strategy = "escalate"
    if strategy not in ("retry_same", "fix_context", "reassign", "escalate"):
        strategy = "fix_context"
    return {
        "strategy": strategy,
        "repairable": repairable,
        "confidence": result.confidence,
        "engine": result.engine,
        "reason": result.note or f"System-1 chose '{strategy}' at confidence {result.confidence:.2f}.",
    }


def is_provider_error(exc: BaseException) -> bool:
    return isinstance(exc, ProviderError)


def reassign_candidates(task: dict[str, Any], roster: list[str]) -> list[str]:
    """Same-skill alternatives for a task whose owner keeps failing."""
    current = task.get("agent_id")
    skill_groups = {
        "backend": ["backend", "architect", "devops"],
        "frontend": ["frontend", "designer"],
        "architect": ["backend", "architect"],
        "qa": ["qa", "security"],
        "security": ["security", "qa"],
        "devops": ["devops", "backend"],
        "docs": ["docs", "pm"],
        "pm": ["pm", "docs"],
        "designer": ["designer", "frontend"],
        "research": ["research", "pm"],
    }
    ordered = skill_groups.get(str(current), [])
    candidates = [a for a in ordered if a != current and a in roster]
    candidates += [a for a in roster if a not in candidates and a != current and a not in ("ceo", "laya")]
    return candidates[:3]
