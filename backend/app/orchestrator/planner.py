"""Planner — turns an objective into a validated, dependency-aware task DAG."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..agents.profiles import PROFILE_MAP, WORKER_IDS
from ..config import settings
from ..models import get_setting
from ..planning import heuristic_plan
from ..protocol import PLANNER_MARKER, extract_json
from ..providers.base import ProviderError
from ..providers.registry import providers

log = logging.getLogger("pranit.planner")

MAX_REPAIR_ATTEMPTS = 2
VALID_AGENT_IDS = set(PROFILE_MAP.keys())


def planner_system_prompt() -> str:
    return "\n".join(
        [
            PLANNER_MARKER,
            "You are Pranit, the CEO and single orchestrator of PRANIT AI CITY.",
            "You decompose an objective into a dependency-aware execution plan. You never write code,",
            "never edit files and never run commands - other agents do that.",
            "",
            "Return ONLY one JSON object, no prose, matching exactly this schema:",
            "{",
            '  "requirements": ["string"],',
            '  "acceptance_criteria": ["string, each one testable"],',
            '  "assumptions": ["string"],',
            '  "tasks": [',
            "    {",
            '      "id": "t1",',
            '      "title": "string",',
            '      "agent_id": "one of: ' + ", ".join(sorted(WORKER_IDS)) + '",',
            '      "description": "what exactly must be produced, concrete enough to execute",',
            '      "depends_on": ["t0"],',
            '      "outputs": ["relative/path/or/dir/"],',
            '      "done_criteria": ["string, checkable"],',
            '      "verify_commands": ["shell command from the allowlist, may be empty"],',
            '      "priority": 1,',
            '      "effort": 2',
            "    }",
            "  ]",
            "}",
            "",
            "Rules:",
            f"- Between 3 and {settings.max_plan_tasks} tasks.",
            "- Dependencies may only reference earlier task ids. The graph must be acyclic.",
            "- Every task must have at least one done_criterion.",
            "- verify_commands must only use: python, python3, pytest, pip, node, npm, npx, git, ls,",
            "  cat, head, tail, grep, find, wc, mkdir, touch, ruff, mypy, tsc. No pipes, no rm, no curl.",
            "- The last task must be a verification pass owned by 'qa'.",
            "- Prefer the smallest plan that fully satisfies the objective.",
            "- Assign documentation to 'docs', tests to 'qa', infrastructure to 'devops'.",
        ]
    )


def normalise_plan(raw: Any, objective: str) -> dict[str, Any]:
    """Coerce a model reply (or heuristic output) into the canonical plan shape."""
    if not isinstance(raw, dict):
        raise ValueError("plan is not a JSON object")
    tasks_in = raw.get("tasks") or []
    if not isinstance(tasks_in, list) or not tasks_in:
        raise ValueError("plan contains no tasks")

    tasks: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(tasks_in):
        if not isinstance(item, dict):
            continue
        task_id = str(item.get("id") or f"t{index + 1}").strip()
        if task_id in seen_ids:
            task_id = f"{task_id}-{index}"
        seen_ids.add(task_id)
        agent_id = str(item.get("agent_id") or item.get("agent") or "pm").strip().lower()
        if agent_id not in VALID_AGENT_IDS or agent_id in ("ceo", "laya"):
            agent_id = _guess_agent(str(item.get("title", "")) + " " + str(item.get("description", "")))
        tasks.append(
            {
                "id": task_id,
                "title": str(item.get("title") or f"Task {index + 1}")[:200],
                "agent_id": agent_id,
                "description": str(item.get("description") or "")[:4000],
                "depends_on": [str(d) for d in (item.get("depends_on") or []) if str(d)],
                "outputs": [str(o) for o in (item.get("outputs") or [])][:20],
                "done_criteria": [str(c) for c in (item.get("done_criteria") or [])][:20],
                "verify_commands": [str(c) for c in (item.get("verify_commands") or [])][:6],
                "priority": _int_in(item.get("priority"), 1, 5, 3),
                "effort": _int_in(item.get("effort"), 1, 5, 1),
            }
        )

    plan = {
        "objective": objective,
        "requirements": _as_list(raw.get("requirements")),
        "acceptance_criteria": _as_list(raw.get("acceptance_criteria")),
        "assumptions": _as_list(raw.get("assumptions")),
        "tasks": tasks,
        "heuristic": bool(raw.get("heuristic", False)),
    }

    # --- dependency repair ------------------------------------------------ #
    # A plan whose dependencies point at ids that were renamed, merged or dropped
    # can never schedule: the tasks stay 'pending' forever.  Unknown and
    # self-referential dependencies are removed here, then any remaining cycle is
    # broken by deleting the minimum number of back-edges.
    known = {task["id"] for task in tasks}
    dropped: list[str] = []
    for task in tasks:
        kept = [d for d in dict.fromkeys(task["depends_on"]) if d in known and d != task["id"]]
        dropped.extend(d for d in task["depends_on"] if d not in kept)
        task["depends_on"] = kept
    cycle_cuts = _break_cycles(tasks)
    if dropped or cycle_cuts:
        plan["normalisation"] = {
            "dropped_dependencies": sorted(set(dropped)),
            "cycle_edges_cut": cycle_cuts,
            "detail": "Unknown, duplicate or self-referential dependencies were removed and any "
                      "cycle was broken so the plan can actually be scheduled.",
        }
    return plan


def _as_list(value: Any, limit: int = 40) -> list[str]:
    """Coerce a model's ``requirements``/``acceptance_criteria`` field into a list.

    Models regularly return a single string of newline- or semicolon-separated
    bullets.  Iterating that string directly would produce one 'requirement' per
    character, so it is split on the usual bullet separators first.
    """
    if value is None:
        return []
    if isinstance(value, str):
        parts = [part.strip() for part in re.split(r"[\n;]+|(?<=\.)\s+(?=[A-Z0-9])", value) if part.strip()]
        value = parts or ([value.strip()] if value.strip() else [])
    if not isinstance(value, (list, tuple, set)):
        value = [value]
    out: list[str] = []
    for item in value:
        text = str(item).strip().lstrip("-*• ").strip()
        if text:
            out.append(text[:500])
    return out[:limit]


def _int_in(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, number))


_AGENT_KEYWORD_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("qa", ("test", "verify", "qa", "pytest", "acceptance")),
    ("security", ("security", "audit", "vulnerab", "secret", "threat")),
    ("docs", ("readme", "document", "docs", "guide")),
    ("devops", ("docker", "ci", "deploy", "environment", "script", "infra")),
    ("designer", ("design", "layout", "ui spec", "wireframe", "style")),
    ("architect", ("architect", "schema", "interface", "module", "data model", "contract")),
    ("frontend", ("frontend", "react", "component", "page", "css", "client", "ui")),
    ("backend", ("backend", "api", "endpoint", "database", "server", "crud", "auth")),
    ("research", ("research", "investigate", "compare", "findings")),
    ("pm", ("requirement", "scope", "priorit", "user stor")),
)


def _guess_agent(text: str) -> str:
    lowered = (text or "").lower()
    for agent_id, keywords in _AGENT_KEYWORD_HINTS:
        if any(k in lowered for k in keywords):
            return agent_id
    return "backend"


def validate_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Structural validation.  Returns facts + a list of blocking errors."""
    tasks = plan.get("tasks") or []
    ids = [t["id"] for t in tasks]
    id_set = set(ids)
    errors: list[str] = []

    if not tasks:
        errors.append("The plan has no tasks.")
    if len(tasks) > settings.max_plan_tasks:
        errors.append(f"Too many tasks ({len(tasks)}); the limit is {settings.max_plan_tasks}.")
    if len(ids) != len(id_set):
        errors.append("Duplicate task ids in the plan.")

    for task in tasks:
        for dep in task.get("depends_on") or []:
            if dep not in id_set:
                errors.append(f"Task '{task['id']}' depends on unknown task '{dep}'.")
            if dep == task["id"]:
                errors.append(f"Task '{task['id']}' depends on itself.")
        if task.get("agent_id") not in WORKER_IDS:
            errors.append(f"Task '{task['id']}' has an unknown owner '{task.get('agent_id')}'.")
        if not task.get("done_criteria"):
            errors.append(f"Task '{task['id']}' has no done_criteria.")
        if len((task.get("description") or "").strip()) < 12:
            errors.append(f"Task '{task['id']}' has a description too vague to execute.")

    order = topological_sort(tasks)
    if order is None:
        errors.append("The dependency graph contains a cycle.")

    actionable = sum(1 for t in tasks if len((t.get("description") or "").split()) >= 6)
    estimated_tokens = sum(2500 + 400 * int(t.get("effort") or 1) for t in tasks)
    token_budget = int(get_setting("plan_token_budget", settings.plan_token_budget))
    objective_tokens = set(re.findall(r"[a-z]{4,}", (plan.get("objective") or "").lower()))
    covered = set()
    for task in tasks:
        covered |= set(re.findall(r"[a-z]{4,}", f"{task.get('title', '')} {task.get('description', '')}".lower()))
    coverage = len(objective_tokens & covered) / len(objective_tokens) if objective_tokens else 1.0

    return {
        "ok": not errors,
        "errors": errors,
        "task_count": len(tasks),
        "order": order or [],
        "actionable_ratio": round(actionable / len(tasks), 3) if tasks else 0.0,
        "coverage_ratio": round(coverage, 3),
        "estimated_tokens": estimated_tokens,
        "token_budget": token_budget,
        "budget_ok": estimated_tokens <= token_budget,
    }


def _topological(tasks: list[dict[str, Any]]) -> tuple[list[str], bool]:
    """Kahn's algorithm.  Returns ``(order, complete)``; a cyclic graph yields the
    partial order of everything that *could* be placed plus ``complete=False``."""
    graph = {t["id"]: set(t.get("depends_on") or []) for t in tasks}
    graph = {node: {d for d in deps if d in graph} for node, deps in graph.items()}
    indegree = {node: len(deps) for node, deps in graph.items()}
    ready = sorted([n for n, d in indegree.items() if d == 0])
    order: list[str] = []
    while ready:
        node = ready.pop(0)
        order.append(node)
        for other, deps in graph.items():
            if node in deps:
                deps.discard(node)
                indegree[other] -= 1
                if indegree[other] == 0:
                    ready.append(other)
        ready.sort()
    return order, len(order) == len(graph)


def topological_sort(tasks: list[dict[str, Any]]) -> list[str] | None:
    """Kahn's algorithm.  Returns None when the graph has a cycle."""
    order, complete = _topological(tasks)
    return order if complete else None


def _break_cycles(tasks: list[dict[str, Any]]) -> list[str]:
    """Delete the fewest back-edges needed to make the graph schedulable.

    Returns a log of ``"task_id <- removed_dependency"`` cuts.  Cycles are rare
    but models do emit them, and a cyclic plan would otherwise sit in ``pending``
    until the deadlock detector gave up.
    """
    cuts: list[str] = []
    limit = len(tasks) * len(tasks) + 4
    for _ in range(limit):
        order, complete = _topological(tasks)
        if complete:
            return cuts
        placed = set(order)
        stuck = [t for t in tasks if t["id"] not in placed]
        if not stuck:
            return cuts
        target = stuck[-1]
        culprits = [d for d in target["depends_on"] if d not in placed] or list(target["depends_on"])
        if not culprits:  # nothing left to cut - validation will report the cycle
            return cuts
        removed = culprits[-1]
        target["depends_on"] = [d for d in target["depends_on"] if d != removed]
        cuts.append(f"{target['id']} <- {removed}")
    return cuts


async def generate_plan(
    objective: str,
    *,
    provider_id: str | None,
    model: str | None,
    spend_authorized: bool,
    available_agents: list[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``(plan, meta)``.  ``meta`` explains which path produced the plan."""
    agents = available_agents or list(WORKER_IDS)

    if provider_id is None:
        plan = normalise_plan(heuristic_plan(objective, agents), objective)
        return plan, {
            "source": "heuristic",
            "reason": "No AI provider is configured, so the deterministic rule-based planner was used.",
            "heuristic": True,
        }

    last_error = ""
    rejection_reasons: list[str] = []
    for attempt in range(MAX_REPAIR_ATTEMPTS + 1):
        prompt_extra = (
            ""
            if not rejection_reasons
            else "\n\nYour previous plan was REJECTED for these reasons:\n- "
            + "\n- ".join(rejection_reasons)
            + "\nReturn a corrected JSON plan and nothing else."
        )
        try:
            completion = await providers.complete(
                provider_id=provider_id,
                model=model,
                system=planner_system_prompt(),
                user=f"Objective: {objective}{prompt_extra}",
                max_tokens=3000,
                temperature=0.2,
                purpose="planning",
                spend_authorized=spend_authorized,
            )
        except ProviderError as exc:
            last_error = exc.message
            log.warning("planner provider call failed: %s", exc.message)
            break
        except Exception as exc:  # noqa: BLE001
            last_error = f"{type(exc).__name__}: {exc}"
            break

        parsed = extract_json(completion.text)
        if parsed is None:
            rejection_reasons = ["The reply was not valid JSON."]
            last_error = "planner reply was not valid JSON"
            continue
        try:
            plan = normalise_plan(parsed, objective)
        except ValueError as exc:
            rejection_reasons = [str(exc)]
            last_error = str(exc)
            continue

        facts = validate_plan(plan)
        if facts["ok"]:
            plan["heuristic"] = False
            return plan, {
                "source": "llm",
                "model": completion.model,
                "mocked": completion.mocked,
                "attempts": attempt + 1,
                "tokens": completion.total_tokens,
                "heuristic": False,
            }
        rejection_reasons = facts["errors"][:8]
        last_error = "; ".join(facts["errors"][:4])

    plan = normalise_plan(heuristic_plan(objective, agents), objective)
    return plan, {
        "source": "heuristic",
        "reason": f"The language model did not return a valid plan ({last_error or 'unknown error'}). "
                  "The deterministic planner produced this one instead.",
        "heuristic": True,
        "llm_error": last_error,
    }


def plan_to_prompt_json(plan: dict[str, Any]) -> str:
    return json.dumps(plan, indent=2, ensure_ascii=False)
