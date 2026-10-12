"""Dependency-aware scheduler."""

from __future__ import annotations

from typing import Any, Iterable

TERMINAL_OK = {"completed"}
TERMINAL_BAD = {"cancelled"}
ACTIVE = {"running", "repairing"}


def ready_tasks(
    tasks: Iterable[dict[str, Any]],
    *,
    running_agent_load: dict[str, int] | None = None,
    max_tasks_per_agent: int = 1,
    max_concurrency: int = 4,
) -> list[dict[str, Any]]:
    """Tasks whose dependencies are all satisfied and that can start now.

    Sorted by (priority asc, effort desc, order_index asc) so critical, heavy
    work starts first and short filler work fills the remaining capacity.
    """
    tasks = list(tasks)
    by_id = {t["id"]: t for t in tasks}
    done = {t["id"] for t in tasks if t["status"] in TERMINAL_OK}
    running = [t for t in tasks if t["status"] in ACTIVE]
    load = dict(running_agent_load or {})
    for task in running:
        if task.get("agent_id"):
            load[task["agent_id"]] = load.get(task["agent_id"], 0) + 1

    capacity = max(0, max_concurrency - len(running))
    if capacity == 0:
        return []

    candidates = []
    for task in tasks:
        if task["status"] not in ("pending", "ready"):
            continue
        deps = [d for d in (task.get("depends_on") or []) if d in by_id]
        if any(by_id[d]["status"] in TERMINAL_BAD for d in deps):
            continue
        if any(by_id[d]["status"] not in TERMINAL_OK for d in deps):
            continue
        agent_id = task.get("agent_id")
        if agent_id and load.get(agent_id, 0) >= max_tasks_per_agent:
            continue
        candidates.append(task)

    candidates.sort(key=lambda t: (int(t.get("priority") or 3), -int(t.get("effort") or 1),
                                   int(t.get("order_index") or 0)))

    chosen: list[dict[str, Any]] = []
    for task in candidates[:capacity]:
        agent_id = task.get("agent_id")
        if agent_id:
            load[agent_id] = load.get(agent_id, 0) + 1
        chosen.append(task)
    return chosen


def is_deadlocked(tasks: Iterable[dict[str, Any]]) -> tuple[bool, str]:
    """True when nothing is running, nothing is ready, but work remains."""
    tasks = list(tasks)
    if not tasks:
        return False, ""
    if any(t["status"] in ACTIVE for t in tasks):
        return False, ""
    remaining = [t for t in tasks if t["status"] in ("pending", "ready")]
    if not remaining:
        return False, ""
    ready = ready_tasks(tasks, max_concurrency=8, max_tasks_per_agent=99)
    if ready:
        return False, ""
    blocked = [t["id"] for t in remaining if t["status"] == "blocked"]
    if blocked:
        return True, f"Tasks are waiting on a human decision: {', '.join(blocked[:5])}"
    failed_deps = sorted({
        d
        for t in remaining
        for d in (t.get("depends_on") or [])
        if any(x["id"] == d and x["status"] in ("failed", "cancelled", "timeout") for x in tasks)
    })
    if failed_deps:
        return True, f"Dependencies failed and cannot be satisfied: {', '.join(failed_deps[:5])}"
    return True, "No task is runnable and none is waiting on approval - the plan is stuck."


def progress(tasks: Iterable[dict[str, Any]]) -> tuple[int, int, float]:
    """Return ``(weight_done, weight_total, fraction)`` from real task state."""
    tasks = list(tasks)
    total = sum(int(t.get("effort") or 1) for t in tasks) or 1
    done = sum(int(t.get("effort") or 1) for t in tasks if t["status"] in TERMINAL_OK)
    return done, total, round(done / total, 4)


def critical_path(tasks: Iterable[dict[str, Any]]) -> list[str]:
    tasks = list(tasks)
    by_id = {t["id"]: t for t in tasks}
    memo: dict[str, int] = {}

    def depth(task_id: str, seen: set[str]) -> int:
        if task_id in memo:
            return memo[task_id]
        task = by_id.get(task_id)
        if task is None or task_id in seen:
            return 0
        seen = seen | {task_id}
        deps = [d for d in (task.get("depends_on") or []) if d in by_id]
        value = int(task.get("effort") or 1) + max((depth(d, seen) for d in deps), default=0)
        memo[task_id] = value
        return value

    if not tasks:
        return []
    deepest = max(tasks, key=lambda t: depth(t["id"], set()))
    path = [deepest["id"]]
    current = deepest
    while True:
        deps = [d for d in (current.get("depends_on") or []) if d in by_id]
        if not deps:
            break
        current = max((by_id[d] for d in deps), key=lambda t: depth(t["id"], set()))
        path.append(current["id"])
    return list(reversed(path))
