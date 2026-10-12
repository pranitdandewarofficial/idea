"""End-to-end acceptance run: objective -> plan -> agents -> real files -> tests -> report.

One real run is executed against the offline **mock** provider (clearly flagged,
never presented as a delivery) and every acceptance criterion from the brief is
checked against what actually happened.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from app.config import settings

OBJECTIVE = (
    "Build a small Python API service that exposes a health endpoint and an add(a, b) function, "
    "with pytest tests, a README and a requirements file."
)
TERMINAL = {"complete", "failed", "cancelled"}


@pytest.fixture(scope="module")
def run(client, auth_headers):
    """Submit one objective and wait for the orchestrator to finish it."""
    from app.providers.registry import providers

    authed = client
    authed.headers.update(auth_headers)

    # Deterministic provider selection: earlier tests leave free/paid providers
    # behind, and `pick` would happily choose an Ollama endpoint that is not
    # running.  Disable everything, then make the offline mock the only enabled
    # provider AND the configured default - exactly what a founder does in the UI.
    disabled: list[str] = []
    for item in authed.get("/api/providers").json()["items"]:
        if item["is_enabled"]:
            authed.patch(f"/api/providers/{item['id']}", json={"is_enabled": False})
            disabled.append(item["id"])
    provider = authed.post("/api/providers", json={
        "label": "Offline mock (tests)", "kind": "mock", "is_paid": False, "is_enabled": True,
        "default_model": "mock-agent", "requests_per_minute": 600, "max_concurrent": 4,
    }).json()
    settings_response = authed.patch("/api/settings", json={"default_provider_id": provider["id"]})
    assert settings_response.status_code == 200, settings_response.text
    providers.invalidate()

    response = authed.post("/api/objectives", json={
        "objective": OBJECTIVE, "project_name": "e2e-demo", "auto_start": True,
    })
    assert response.status_code == 200, response.text
    submitted = response.json()
    assert submitted["validation"]["ok"] is True, submitted["validation"]
    plan_id = submitted["plan_id"]

    deadline = time.time() + 300
    plan = {}
    while time.time() < deadline:
        plan = authed.get(f"/api/plans/{plan_id}").json()
        if plan["state"] in TERMINAL:
            break
        time.sleep(0.5)

    tasks = authed.get("/api/tasks", params={"plan": plan_id}).json()["items"]
    report_response = authed.get(f"/api/plans/{plan_id}/report")
    assert report_response.status_code == 200, (
        f"no delivery report for a plan in state {plan['state']}: {report_response.text}"
    )
    report = report_response.json()

    yield {"provider": provider, "submitted": submitted, "plan": plan, "tasks": tasks,
           "report": report, "client": client}

    for provider_id in disabled:
        authed.patch(f"/api/providers/{provider_id}", json={"is_enabled": True})
    authed.patch("/api/settings", json={"default_provider_id": ""})
    providers.invalidate()


# --------------------------------------------------------------------------- #
# the run itself
# --------------------------------------------------------------------------- #
def test_the_run_completes(run):
    plan = run["plan"]
    assert plan["state"] == "complete", f"plan ended {plan['state']}: {plan.get('failure_reason')}"
    assert plan["progress"] == pytest.approx(1.0)
    assert plan["started_at"] and plan["finished_at"]


def test_every_task_was_executed_by_a_real_agent(run):
    tasks = run["tasks"]
    assert len(tasks) >= 6
    assert all(t["status"] == "completed" for t in tasks), [(t["id"], t["status"], t["error"]) for t in tasks]
    assert all(t["agent_id"] for t in tasks)
    owners = {t["agent_id"] for t in tasks}
    assert {"pm", "architect", "backend", "qa", "docs"} <= owners
    assert "ceo" not in owners, "the orchestrator must not do the work itself"
    assert all(t["summary"] for t in tasks)


def test_the_workspace_contains_real_files(run):
    root = Path(run["submitted"]["workspace"])
    assert root.exists()
    expected = [
        "README.md",
        "docs/requirements.md",
        "docs/architecture.md",
        "src/app.py",
        "tests/test_app.py",
    ]
    missing = [name for name in expected if not (root / name).exists()]
    assert not missing, f"missing artifacts: {missing}"
    for name in expected:
        assert (root / name).stat().st_size > 0, f"{name} is empty"


def test_the_generated_code_is_real_python_that_really_works(run):
    root = Path(run["submitted"]["workspace"])
    source = (root / "src" / "app.py").read_text()
    assert "def health" in source and "def add" in source
    namespace: dict = {}
    exec(compile(source, str(root / "src" / "app.py"), "exec"), namespace)  # noqa: S102 - test evidence
    assert namespace["health"]()["status"] == "ok"
    assert namespace["add"](2, 3) == 5


def test_the_qa_task_ran_pytest_and_quoted_the_real_output(run):
    qa = next(t for t in run["tasks"] if t["agent_id"] == "qa")
    verification = qa["verification"]
    assert verification["verified"] is True, verification
    commands = [c["command"] for c in verification["checks"]]
    assert any("pytest" in c for c in commands), commands
    pytest_check = next(c for c in verification["checks"] if "pytest" in c["command"])
    assert pytest_check["code"] == 0
    assert pytest_check["stdout"] or pytest_check["stderr"]


def test_tests_actually_pass_when_re_run_from_the_workspace(run):
    from app.tools.context import ToolContext
    from app.tools.shell import run_tests

    import asyncio

    root = Path(run["submitted"]["workspace"])
    ctx = ToolContext(root=root, project_id=run["submitted"]["project_id"], timeout_seconds=120)
    result = asyncio.run(run_tests(ctx, "python -m pytest -q"))
    assert result["code"] == 0, result
    assert "passed" in (result["stdout"] + result["stderr"]).lower()


def test_every_declared_verify_command_was_executed(run):
    for task in run["tasks"]:
        if not task["verify_commands"]:
            continue
        checks = task["verification"]["checks"]
        assert len(checks) == len(task["verify_commands"])
        assert all(check["passed"] for check in checks), (task["id"], checks)


def test_tool_calls_were_recorded_with_real_results(run):
    plan_id = run["plan"]["id"]
    body = run["report"]
    assert body["metrics"]["tool_calls"] > 0
    assert body["metrics"]["tool_calls_denied"] >= 0

    calls = _tool_calls_for_plan(plan_id)
    assert calls, "no tool calls were persisted"
    kinds = {c["tool"] for c in calls}
    assert "write_file" in kinds
    assert any(k in kinds for k in ("run_shell", "run_tests"))
    for call in calls:
        assert call["duration_ms"] >= 0


def _tool_calls_for_plan(plan_id: str) -> list[dict]:
    from app.db import session_scope
    from app.models import Task, ToolCall

    with session_scope() as s:
        task_ids = [t.id for t in s.query(Task).filter(Task.plan_id == plan_id).all()]
        rows = s.query(ToolCall).filter(ToolCall.task_id.in_(task_ids)).all() if task_ids else []
        return [{"tool": r.tool, "denied": r.denied, "duration_ms": r.duration_ms,
                 "ok": r.ok, "args": r.args} for r in rows]


# --------------------------------------------------------------------------- #
# honesty about the mock
# --------------------------------------------------------------------------- #
def test_a_mock_run_is_never_reported_as_a_delivery(run):
    report = run["report"]
    assert report["used_mock_provider"] is True
    assert report["delivered"] is False
    assert any("mock" in line.lower() and "not a real delivery" in line.lower()
               for line in report["limitations"])


def test_metrics_are_real_numbers(run):
    metrics = run["report"]["metrics"]
    assert metrics["cost_estimate"] == 0.0
    assert metrics["mocked_calls"] > 0
    assert metrics["tokens_in"] > 0 and metrics["tokens_out"] > 0
    assert metrics["decisions"] > 0
    assert metrics["decision_engines"], "the engine that answered must be recorded"


def test_spend_authorization_is_per_run_and_audited(run):
    plan_id = run["plan"]["id"]
    client = run["client"]
    response = client.post(f"/api/plans/{plan_id}/spend",
                           json={"plan_id": plan_id, "authorized": True, "note": "test authorization"})
    assert response.status_code == 200, response.text
    assert response.json()["spend_authorized"] is True
    revoked = client.post(f"/api/plans/{plan_id}/spend",
                          json={"plan_id": plan_id, "authorized": False, "note": "back to zero spend"})
    assert revoked.json()["spend_authorized"] is False
    events = _get(client, "/api/events", limit=500)["items"]
    kinds = {e["kind"] for e in events}
    assert "spend.authorized" in kinds and "spend.revoked" in kinds
    # zero-spend is a global default and must still be on
    assert _get(client, "/api/health")["zero_spend"] is True


def _get(client, url: str, **params):
    response = client.get(url, params=params or None)
    assert response.status_code == 200, f"{url} -> {response.status_code}: {response.text}"
    return response.json()


# --------------------------------------------------------------------------- #
# decision layer inside the run
# --------------------------------------------------------------------------- #
def test_decisions_were_recorded_for_the_run(run):
    plan_id = run["plan"]["id"]
    body = _get(run["client"], "/api/decisions", plan_id=plan_id, limit=200)
    assert body["items"], "the orchestrator must record its decisions"
    types = {item["decision_type"] for item in body["items"]}
    assert "routing" in types
    assert {"plan_validation", "output_quality"} & types
    assert all(item["engine"] for item in body["items"])
    assert all(0.0 <= item["confidence"] <= 1.0 for item in body["items"])


def test_routing_decisions_were_made_for_every_dispatch(run):
    plan_id = run["plan"]["id"]
    routing = _get(run["client"], "/api/decisions", plan_id=plan_id, decision_type="routing",
                   limit=200)["items"]
    assert len(routing) >= len(run["tasks"]), "every dispatch must consult the decision layer"
    local = [item for item in routing if item["engine"] != "llm"]
    assert local, "System 1 must answer routing locally"
    assert all(item["latency_ms"] < 100 for item in local)
    # anything the fast engine was unsure about was handed to System 2, and says so
    for item in routing:
        if item["engine"] == "llm":
            assert item["fallback_used"] is True


# --------------------------------------------------------------------------- #
# events, checkpoints, audit
# --------------------------------------------------------------------------- #
def test_the_event_stream_tells_the_whole_story(run):
    events = _get(run["client"], "/api/events", limit=500)["items"]
    kinds = {e["kind"] for e in events}
    assert "objective.received" in kinds
    assert "plan.started" in kinds or "plan.state_changed" in kinds
    assert "task.started" in kinds
    assert "task.completed" in kinds
    assert "decision.made" in kinds
    assert "tool.result" in kinds
    assert "plan.finished" in kinds
    finished = next(e for e in events if e["kind"] == "plan.finished")
    assert finished["payload"]["state"] == "complete"
    assert finished["payload"]["delivered"] is False, "a mock run is never a delivery"
    assert finished["payload"]["used_mock"] is True
    assert finished["payload"]["metrics"]["mocked_calls"] > 0
    for event in events:
        assert event["id"] and event["ts"]
        assert "priority" in event


def test_events_since_a_cursor_only_return_newer_items(run):
    all_events = _get(run["client"], "/api/events", limit=500)["items"]
    cursor = all_events[len(all_events) // 2]["id"]
    newer = _get(run["client"], "/api/events", since=cursor, limit=500)["items"]
    assert newer
    assert all(item["id"] > cursor for item in newer)


def test_checkpoints_were_written_during_the_run(run):
    plan_id = run["plan"]["id"]
    body = _get(run["client"], f"/api/plans/{plan_id}/checkpoints")
    assert body["items"], "a run must be resumable"
    assert body["items"][0]["task_count"] == len(run["tasks"])
    assert body["latest"]["snapshot"]["tasks"]
    assert body["latest"]["snapshot"]["plan_state"]


def test_audit_trail_is_append_only_and_covers_the_run(run):
    body = _get(run["client"], "/api/audit", limit=200)
    assert body["items"]
    actions = {item["action"] for item in body["items"]}
    assert any(action.startswith("tool.") for action in actions)
    assert any("provider" in action for action in actions)


# --------------------------------------------------------------------------- #
# project surface
# --------------------------------------------------------------------------- #
def test_project_tree_and_file_endpoints_read_the_real_workspace(run):
    project_id = run["submitted"]["project_id"]
    tree = _get(run["client"], f"/api/projects/{project_id}/tree")
    paths = {entry["path"] for entry in tree["entries"]}
    assert "README.md" in paths
    assert "src/" in paths
    assert "src/app.py" in paths
    assert tree["count"] == len(tree["entries"])

    file_body = _get(run["client"], f"/api/projects/{project_id}/file", path="README.md")
    assert file_body["content"].startswith("#")
    assert file_body["path"] == "README.md"

    denied = _get_or_error(run["client"], f"/api/projects/{project_id}/file", path="../../etc/passwd")
    assert denied.status_code in (400, 403, 422)


def _get_or_error(client, url: str, **params):
    return client.get(url, params=params or None)


def test_project_test_endpoint_re_runs_the_suite(run):
    project_id = run["submitted"]["project_id"]
    body = _get(run["client"], f"/api/projects/{project_id}/tests")
    assert body["detected"] is True, body
    assert body["code"] == 0, body
    assert body["passed"] is True
    assert "passed" in (body.get("stdout", "") + body.get("stderr", "")).lower()


def test_secrets_scan_is_clean(run):
    project_id = run["submitted"]["project_id"]
    body = _get(run["client"], f"/api/projects/{project_id}/secrets-scan")
    assert body["findings"] == []
    assert body["clean"] is True
    assert body["count"] == 0


def test_git_repository_was_initialised_and_committed(run):
    project_id = run["submitted"]["project_id"]
    log = _get(run["client"], f"/api/projects/{project_id}/git/log")
    assert log["repo"] is True
    assert log["commits"], "the delivered project must have real git history"
    assert log["commits"][0]["subject"].startswith("chore: deliver")
    assert log["commits"][0]["hash"]


def test_project_diff_reports_nothing_uncommitted_after_delivery(run):
    project_id = run["submitted"]["project_id"]
    diff = _get(run["client"], f"/api/projects/{project_id}/diff")
    assert diff["repo"] is True
    # everything was committed at delivery, so the working tree is clean
    assert diff["diff"] == ""


# --------------------------------------------------------------------------- #
# budget and settings guards during a run
# --------------------------------------------------------------------------- #
def test_budget_endpoint_reports_the_real_limits(run):
    body = _get(run["client"], f"/api/plans/{run['plan']['id']}/budget")
    assert body["ok"] is True
    assert body["tokens_plan_budget"] == settings.plan_token_budget
    assert body["tokens_used"] >= 0


def test_the_run_stays_inside_the_configured_budget(run):
    body = _get(run["client"], f"/api/plans/{run['plan']['id']}/budget")
    assert body["tokens_used"] < body["tokens_plan_budget"]


def test_the_dag_endpoint_exposes_dependencies(run):
    body = _get(run["client"], f"/api/plans/{run['plan']['id']}/dag")
    assert body["nodes"] and body["edges"]
    assert len(body["nodes"]) == len(run["tasks"])


# --------------------------------------------------------------------------- #
# plan list and the approval gate
# --------------------------------------------------------------------------- #
def test_plan_list_endpoint_returns_full_plan_rows(run):
    body = _get(run["client"], "/api/plans", limit=10)
    assert body["count"] >= 1
    item = next(p for p in body["items"] if p["id"] == run["plan"]["id"])
    assert item["objective"] == OBJECTIVE
    assert item["state"] == "complete"
    assert item["validation"]["ok"] is True
    assert item["acceptance_criteria"]


def test_pending_approvals_are_empty_after_a_clean_run(run):
    body = _get(run["client"], "/api/approvals", status="pending")
    assert body["items"] == []


def test_approval_decision_requires_a_real_pending_approval(run):
    response = run["client"].post("/api/approvals/does-not-exist/decision",
                                  json={"approved": True, "note": "x"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"

