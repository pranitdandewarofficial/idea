"""Approval gate, audit trail and the live event transports (WS + history)."""

from __future__ import annotations

import asyncio

import pytest

from app.events import bus
from app.orchestrator.approvals import gate
from app.security.auth import current_token
from app.tools.context import ToolContext
from app.tools.registry import executor


# --------------------------------------------------------------------------- #
# the gate really blocks
# --------------------------------------------------------------------------- #
def test_a_gated_action_blocks_until_the_founder_decides():
    async def scenario() -> tuple[bool, list[dict]]:
        waiting = asyncio.create_task(
            gate.request(action="delete_file", detail={"path": "src/app.py"}, risk=0.9,
                         plan_id="plan-gate", task_id="task-gate", requested_by="agent:devops")
        )
        await asyncio.sleep(0.05)
        assert not waiting.done(), "a destructive action must not proceed on its own"
        pending = gate.pending()
        assert pending, "the request must be visible to the UI"
        assert pending[0]["action"] == "delete_file"
        gate.decide(pending[0]["id"], True, "approved in a test")
        approved = await asyncio.wait_for(waiting, 2)
        return approved, pending

    approved, pending = asyncio.run(scenario())
    assert approved is True
    assert pending[0]["risk_score"] == 0.9


def test_a_denied_action_stays_denied():
    async def scenario() -> bool:
        waiting = asyncio.create_task(
            gate.request(action="git_push", detail={"branch": "main"}, risk=0.8, plan_id="plan-gate2")
        )
        await asyncio.sleep(0.05)
        target = next(item for item in gate.pending() if item["action"] == "git_push")
        gate.decide(target["id"], False, "not today")
        return await asyncio.wait_for(waiting, 2)

    assert asyncio.run(scenario()) is False


def test_deciding_twice_is_reported_not_silently_ignored(authed):
    async def scenario() -> str:
        waiting = asyncio.create_task(gate.request(action="npm publish", detail={}, risk=0.7,
                                                   plan_id="plan-gate3"))
        await asyncio.sleep(0.05)
        approval_id = next(item["id"] for item in gate.pending() if item["action"] == "npm publish")
        gate.decide(approval_id, True, "first")
        await asyncio.wait_for(waiting, 2)
        return approval_id

    approval_id = asyncio.run(scenario())
    response = authed.post(f"/api/approvals/{approval_id}/decision", json={"approved": False, "note": "late"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "already_decided"


def test_irreversible_tools_are_never_auto_approved(workspace):
    """delete_file and git_push must reach a human even with auto-approve enabled."""

    async def scenario() -> bool:
        ctx = ToolContext(root=workspace, project_id="p", plan_id="plan-auto", task_id="t",
                          agent_id="devops", timeout_seconds=5)
        (workspace / "victim.txt").write_text("still here")
        call = asyncio.create_task(
            executor.execute(ctx, "delete_file", {"path": "victim.txt"})
        )
        await asyncio.sleep(0.2)
        assert not call.done(), "delete_file must wait for a human"
        pending = [item for item in gate.pending() if item["action"] == "delete_file"]
        assert pending
        gate.decide(pending[0]["id"], False, "denied by test")
        result = await asyncio.wait_for(call, 5)
        return result.denied

    assert asyncio.run(scenario()) is True
    assert (workspace / "victim.txt").exists()


# --------------------------------------------------------------------------- #
# audit trail
# --------------------------------------------------------------------------- #
def test_tool_calls_are_audited_with_their_real_outcome(authed):
    body = authed.get("/api/audit", params={"limit": 100}).json()
    assert body["items"]
    tool_rows = [row for row in body["items"] if row["action"].startswith("tool.")]
    assert tool_rows, "every tool call must leave an audit row"
    assert any(row["action"] == "tool.delete_file" or row["result"] != "ok" for row in tool_rows)
    for row in tool_rows:
        assert row["actor"]
        assert "created_at" in row


def test_audit_actors_are_listed(authed):
    body = authed.get("/api/audit/actors").json()
    assert body["items"]
    assert any("agent:" in actor or actor == "founder" for actor in
               [item["actor"] if isinstance(item, dict) else item for item in body["items"]])


def test_audit_never_contains_a_plaintext_secret(authed, workspace):
    async def scenario() -> None:
        ctx = ToolContext(root=workspace, project_id="p", plan_id="plan-audit", task_id="t",
                          agent_id="devops", timeout_seconds=10)
        await executor.execute(ctx, "write_file", {
            "path": "leak.txt",
            "content": "OPENAI_API_KEY=sk-abcdefghij1234567890\n",
        })

    asyncio.run(scenario())
    body = authed.get("/api/audit", params={"limit": 200}).json()
    assert "sk-abcdefghij1234567890" not in str(body)


# --------------------------------------------------------------------------- #
# event history, kinds and export
# --------------------------------------------------------------------------- #
def test_event_history_is_ordered_and_cursor_addressable(authed):
    body = authed.get("/api/events", params={"limit": 50}).json()
    assert body["items"]
    ids = [item["id"] for item in body["items"]]
    assert ids == sorted(ids), "history must be chronological"
    assert body["last_id"] >= ids[-1]

    cursor = ids[len(ids) // 2]
    newer = authed.get("/api/events", params={"since": cursor, "limit": 50}).json()["items"]
    assert all(item["id"] > cursor for item in newer)


def test_event_kind_filter(authed):
    kinds = authed.get("/api/events/kinds").json()["items"]
    assert "approval.requested" in kinds
    filtered = authed.get("/api/events", params={"kind": "approval.requested", "limit": 10}).json()["items"]
    assert all(item["kind"] == "approval.requested" for item in filtered)


def test_event_export_includes_payloads(authed):
    body = authed.get("/api/events/export", params={"limit": 20}).json()
    assert body["items"]
    assert all("payload" in item for item in body["items"])


def test_events_redact_secrets_before_they_are_stored(authed):
    async def scenario() -> None:
        await bus.emit("test.secret", api_key="sk-abcdefghij1234567890", note="should be masked")

    asyncio.run(scenario())
    body = authed.get("/api/events", params={"kind": "test.secret", "limit": 5}).json()
    assert body["items"], "the event must be recorded"
    assert "sk-abcdefghij1234567890" not in str(body)
    assert "REDACTED" in str(body["items"][-1]["payload"])


# --------------------------------------------------------------------------- #
# websocket
# --------------------------------------------------------------------------- #
def test_websocket_rejects_a_bad_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws?token=wrong"):
            pass


def test_websocket_streams_live_events(client):
    token = current_token()
    with client.websocket_connect(f"/ws?token={token}") as socket:
        first = socket.receive_json()
        assert first["kind"] == "ws.connected"
        assert "last_id" in first["payload"]

        socket.send_json({"type": "ping"})
        seen_pong = False
        for _ in range(20):
            message = socket.receive_json()
            if message["kind"] == "ws.pong":
                seen_pong = True
                break
        assert seen_pong

        socket.send_json({"type": "replay", "since": 0})
        assert socket.receive_json()["kind"]


def test_websocket_reports_a_malformed_frame(client):
    """Its own connection, so no backlog can hide the reply."""
    token = current_token()
    with client.websocket_connect(f"/ws?token={token}") as socket:
        assert socket.receive_json()["kind"] == "ws.connected"
        socket.send_text("this is not json")
        message = socket.receive_json()
        assert message["kind"] == "ws.error"
        assert message["payload"]["message"] == "invalid JSON"


def test_websocket_delivers_an_event_emitted_after_subscription(client):
    token = current_token()
    with client.websocket_connect(f"/ws?token={token}") as socket:
        assert socket.receive_json()["kind"] == "ws.connected"
        bus.emit_threadsafe("ws.probe", detail="hello from a test")
        kinds = []
        for _ in range(30):
            message = socket.receive_json()
            kinds.append(message["kind"])
            if message["kind"] == "ws.probe":
                assert message["payload"]["detail"] == "hello from a test"
                break
        assert "ws.probe" in kinds
