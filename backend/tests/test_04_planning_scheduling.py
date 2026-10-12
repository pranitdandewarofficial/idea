"""Planning, scheduling, budget and repair-loop tests (no provider required)."""

from __future__ import annotations

import pytest

from app.config import settings
from app.orchestrator import scheduler
from app.orchestrator.budget import budget as budget_guard
from app.orchestrator.planner import heuristic_plan, normalise_plan, topological_sort, validate_plan
from app.orchestrator.repair import classify_error
from app.agents.profiles import WORKER_IDS


def _plan(objective: str = "Build a small Python API service with tests and a README") -> dict:
    return heuristic_plan(objective, list(WORKER_IDS))


# --------------------------------------------------------------------------- #
# planner
# --------------------------------------------------------------------------- #
def test_heuristic_plan_is_a_valid_dag():
    plan = _plan()
    facts = validate_plan(plan)
    assert facts["ok"], facts["errors"]
    assert facts["task_count"] == len(plan["tasks"]) <= settings.max_plan_tasks
    assert facts["budget_ok"] is True
    assert facts["order"], "topological order must be produced"


def test_every_task_is_executable_on_its_own():
    for task in _plan()["tasks"]:
        assert task["agent_id"] in WORKER_IDS
        assert task["done_criteria"], task["id"]
        assert len(task["description"].split()) >= 6, task["id"]
        assert task["id"]


def test_dependency_order_puts_implementation_before_tests():
    tasks = _plan()["tasks"]
    by_id = {t["id"]: t for t in tasks}
    order = topological_sort(tasks)
    position = {task_id: i for i, task_id in enumerate(order)}
    tests = next(t for t in tasks if t["agent_id"] == "qa")
    for dep in tests["depends_on"]:
        assert position[dep] < position[tests["id"]], f"{dep} must run before the QA task"
    assert by_id[tests["id"]]["verify_commands"], "QA must be verified by a real command"


def test_validate_plan_detects_a_cycle():
    plan = _plan()
    plan["tasks"][0]["depends_on"] = [plan["tasks"][-1]["id"]]
    plan["tasks"][-1]["depends_on"] = [plan["tasks"][0]["id"]]
    facts = validate_plan(plan)
    assert facts["ok"] is False
    assert any("cycle" in e.lower() for e in facts["errors"])


def test_validate_plan_detects_unknown_owners_and_missing_criteria():
    plan = _plan()
    plan["tasks"][0]["agent_id"] = "intern-from-the-internet"
    plan["tasks"][1]["done_criteria"] = []
    facts = validate_plan(plan)
    assert facts["ok"] is False
    joined = " ".join(facts["errors"])
    assert "unknown owner" in joined
    assert "done_criteria" in joined


def test_validate_plan_rejects_an_oversized_plan():
    plan = _plan()
    template = dict(plan["tasks"][0])
    for i in range(settings.max_plan_tasks + 5):
        plan["tasks"].append({**template, "id": f"extra-{i}", "depends_on": []})
    facts = validate_plan(plan)
    assert facts["ok"] is False
    assert any("Too many tasks" in e for e in facts["errors"])


def test_normalise_plan_repairs_a_messy_model_response():
    raw = {
        "objective": "Ship a landing page",
        "requirements": "make it fast",  # wrong type
        "tasks": [
            {"id": "t1", "title": "Design the page", "description": "Design the landing page layout",
             "agent_id": "ui-designer", "depends_on": ["nope"], "done_criteria": [], "effort": 99},
            {"id": "t1", "title": "Duplicate id", "description": "Duplicate id task", "agent_id": "frontend",
             "done_criteria": ["exists"]},
            {"title": "No id", "description": "Implement the hero component in React", "agent_id": "frontend",
             "done_criteria": ["component renders"]},
        ],
    }
    plan = normalise_plan(raw, "Ship a landing page")
    ids = [t["id"] for t in plan["tasks"]]
    assert len(ids) == len(set(ids)), "duplicate ids must be resolved"
    assert all(t["agent_id"] in WORKER_IDS for t in plan["tasks"]), "unknown owners must be re-mapped"
    assert all(t["effort"] <= 5 for t in plan["tasks"])
    assert isinstance(plan["requirements"], list)
    assert all(dep in set(ids) for t in plan["tasks"] for dep in t["depends_on"])


def test_normalise_plan_refuses_an_empty_plan():
    with pytest.raises(ValueError):
        normalise_plan({"tasks": []}, "Do something")


def test_normalise_plan_breaks_a_cycle_so_the_plan_can_run():
    plan = normalise_plan(
        {"tasks": [
            {"id": "a", "title": "A", "description": "First task description here", "agent_id": "backend",
             "depends_on": ["c"], "done_criteria": ["a"]},
            {"id": "b", "title": "B", "description": "Second task description here", "agent_id": "backend",
             "depends_on": ["a"], "done_criteria": ["b"]},
            {"id": "c", "title": "C", "description": "Third task description here", "agent_id": "backend",
             "depends_on": ["b"], "done_criteria": ["c"]},
        ]},
        "Break the cycle",
    )
    assert topological_sort(plan["tasks"]) is not None
    assert plan["normalisation"]["cycle_edges_cut"]
    assert validate_plan(plan)["ok"] is True


# --------------------------------------------------------------------------- #
# scheduler
# --------------------------------------------------------------------------- #
def _tasks():
    return [
        {"id": "a", "agent_id": "pm", "status": "pending", "depends_on": [], "priority": 3, "effort": 1},
        {"id": "b", "agent_id": "backend", "status": "pending", "depends_on": ["a"], "priority": 2, "effort": 2},
        {"id": "c", "agent_id": "frontend", "status": "pending", "depends_on": ["a"], "priority": 2, "effort": 1},
        {"id": "d", "agent_id": "qa", "status": "pending", "depends_on": ["b", "c"], "priority": 1, "effort": 1},
    ]


def test_ready_tasks_respects_dependencies():
    ready = scheduler.ready_tasks(_tasks(), running_agent_load={}, max_tasks_per_agent=1, max_concurrency=4)
    assert [t["id"] for t in ready] == ["a"]


def test_ready_tasks_unlocks_dependents_once_a_task_completes():
    tasks = _tasks()
    tasks[0]["status"] = "completed"
    ready = scheduler.ready_tasks(tasks, running_agent_load={}, max_tasks_per_agent=1, max_concurrency=4)
    assert {t["id"] for t in ready} == {"b", "c"}


def test_ready_tasks_respects_per_agent_and_global_concurrency():
    tasks = _tasks()
    tasks[0]["status"] = "completed"
    ready = scheduler.ready_tasks(tasks, running_agent_load={}, max_tasks_per_agent=1, max_concurrency=1)
    assert len(ready) == 1

    blocked = scheduler.ready_tasks(tasks, running_agent_load={"backend": 1, "frontend": 1},
                                    max_tasks_per_agent=1, max_concurrency=4)
    assert blocked == []


def test_ready_tasks_skips_terminal_tasks():
    tasks = _tasks()
    for task in tasks:
        task["status"] = "completed"
    assert scheduler.ready_tasks(tasks, running_agent_load={}, max_tasks_per_agent=1, max_concurrency=4) == []


def test_deadlock_detection():
    tasks = _tasks()
    tasks[0]["depends_on"] = ["d"]
    deadlocked, reason = scheduler.is_deadlocked(tasks)
    assert deadlocked is True
    assert reason

    assert scheduler.is_deadlocked(_tasks())[0] is False


def test_progress_and_critical_path():
    tasks = _tasks()
    done, total, ratio = scheduler.progress(tasks)
    assert (done, total) == (0, 5) and ratio == 0.0  # effort-weighted, not task-counted
    tasks[0]["status"] = "completed"
    done, total, ratio = scheduler.progress(tasks)
    assert done == 1 and ratio == pytest.approx(0.2)

    path = scheduler.critical_path(tasks)
    assert path[0] == "a" and path[-1] == "d"
    assert len(path) == 3  # a -> (b|c) -> d


# --------------------------------------------------------------------------- #
# repair classification
# --------------------------------------------------------------------------- #
def test_classify_error_marks_transient_provider_failures_repairable():
    signals = classify_error("provider is busy", exception=type("E", (Exception,), {"code": "provider_rate_limited"})())
    assert signals["repairable_signal"] > 0.5
    assert signals["strategy_bias"].get("retry_same") == 1.0


def test_classify_error_marks_policy_denials_unrepairable():
    signals = classify_error("Command contains a blocked pattern: 'rm' (denied: not on the allowlist)")
    assert signals["repairable_signal"] < 0
    assert signals["fatal"] is False or signals["policy_denied"] is True


def test_classify_error_marks_zero_spend_blocks_fatal():
    signals = classify_error("zero_spend_blocked: paid provider requires explicit authorization")
    assert signals["fatal"] is True
    assert signals["repairable_signal"] <= -0.9


def test_classify_error_treats_a_failing_exit_code_as_repairable():
    signals = classify_error("pytest: 2 failed, 3 passed", exit_code=1)
    assert signals["repairable_signal"] > 0.5


# --------------------------------------------------------------------------- #
# budget
# --------------------------------------------------------------------------- #
def test_budget_snapshot_is_clean_for_an_unknown_plan():
    state = budget_guard.snapshot("plan-does-not-exist")
    assert state.ok is True
    assert state.tokens_used == 0
    assert state.tokens_plan_budget == settings.plan_token_budget
    assert state.as_dict()["tokens_plan_remaining"] == settings.plan_token_budget


def test_budget_warning_threshold():
    state = budget_guard.snapshot("plan-does-not-exist")
    assert budget_guard.warning_threshold(state) is False
    state.tokens_used = int(state.tokens_plan_budget * 0.9)
    assert budget_guard.warning_threshold(state) is True
