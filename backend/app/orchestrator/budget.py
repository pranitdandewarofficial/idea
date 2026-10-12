"""Budget guard: tokens, cost and wall clock.

Overruns cause a graceful pause with an explicit reason, never silent spend.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..config import settings
from ..db import session_scope
from ..models import Plan, UsageRecord, get_setting


@dataclass
class BudgetState:
    tokens_used: int
    tokens_plan_budget: int
    tokens_global_budget: int
    cost_estimate: float
    elapsed_seconds: float
    calls: int
    mocked_calls: int
    ok: bool
    reason: str = ""

    def as_dict(self) -> dict:
        return {
            "tokens_used": self.tokens_used,
            "tokens_plan_budget": self.tokens_plan_budget,
            "tokens_global_budget": self.tokens_global_budget,
            "tokens_plan_remaining": max(0, self.tokens_plan_budget - self.tokens_used),
            "cost_estimate": round(self.cost_estimate, 6),
            "elapsed_seconds": round(self.elapsed_seconds, 1),
            "calls": self.calls,
            "mocked_calls": self.mocked_calls,
            "ok": self.ok,
            "reason": self.reason,
        }


class BudgetGuard:
    def __init__(self) -> None:
        self._started: dict[str, float] = {}

    def start(self, plan_id: str) -> None:
        self._started.setdefault(plan_id, time.monotonic())

    def elapsed(self, plan_id: str) -> float:
        return time.monotonic() - self._started.get(plan_id, time.monotonic())

    def snapshot(self, plan_id: str) -> BudgetState:
        plan_budget = int(get_setting("plan_token_budget", settings.plan_token_budget))
        global_budget = int(get_setting("global_token_budget", settings.global_token_budget))
        with session_scope() as s:
            plan = s.get(Plan, plan_id)
            plan_tokens = int(plan.tokens_used) if plan else 0
            plan_cost = float(plan.cost_estimate) if plan else 0.0
            rows = s.query(UsageRecord).all()
        total_tokens = sum(r.tokens_in + r.tokens_out for r in rows)
        total_cost = sum(r.cost_estimate for r in rows)
        elapsed = self.elapsed(plan_id)

        ok = True
        reason = ""
        if plan_tokens >= plan_budget:
            ok, reason = False, f"Plan token budget exhausted ({plan_tokens}/{plan_budget})."
        elif total_tokens >= global_budget:
            ok, reason = False, f"Global token budget exhausted ({total_tokens}/{global_budget})."

        return BudgetState(
            tokens_used=plan_tokens,
            tokens_plan_budget=plan_budget,
            tokens_global_budget=global_budget,
            cost_estimate=plan_cost or total_cost,
            elapsed_seconds=elapsed,
            calls=len(rows),
            mocked_calls=sum(1 for r in rows if r.mocked),
            ok=ok,
            reason=reason,
        )

    def warning_threshold(self, state: BudgetState) -> bool:
        if state.tokens_plan_budget <= 0:
            return False
        return state.tokens_used >= 0.8 * state.tokens_plan_budget

    def add_usage(self, plan_id: str, tokens: int, cost: float) -> None:
        if not tokens and not cost:
            return
        with session_scope() as s:
            plan = s.get(Plan, plan_id)
            if plan is not None:
                plan.tokens_used = int(plan.tokens_used or 0) + int(tokens)
                plan.cost_estimate = round(float(plan.cost_estimate or 0.0) + float(cost), 6)


budget = BudgetGuard()
