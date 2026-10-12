"""Providers, zero-spend policy, secret storage, knowledge base, verification."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.config import settings
from app.db import session_scope
from app.knowledge import ingest
from app.memory import store as memory
from app.models import KnowledgeChunk, KnowledgeSource, Provider
from app.orchestrator import verifier
from app.providers.base import ProviderError, SpendBlockedError
from app.providers.registry import providers
from app.security.crypto import decrypt
from app.tools.context import ToolContext

SECRET = "sk-test-1234567890abcdefghijklmnopqrstuvwxyz"


def _create(authed, **overrides) -> dict:
    payload = {"label": "Test provider", "kind": "mock", "is_paid": False, **overrides}
    response = authed.post("/api/providers", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# provider CRUD and secret handling
# --------------------------------------------------------------------------- #
def test_provider_creation_never_echoes_the_api_key(authed):
    body = _create(authed, label="Local Ollama", kind="ollama", base_url="http://127.0.0.1:11434",
                   api_key=SECRET, default_model="llama3.2")
    assert "api_key" not in body
    assert SECRET not in str(body)
    assert body["has_key"] is True
    assert body["key_fingerprint"]
    assert SECRET not in body["key_fingerprint"]


def test_api_key_is_encrypted_at_rest(authed):
    body = _create(authed, label="Encrypted check", kind="openai", api_key=SECRET)
    with session_scope() as s:
        row = s.get(Provider, body["id"])
        assert row.api_key_enc != SECRET
        assert SECRET not in (row.api_key_enc or "")
        assert decrypt(row.api_key_enc) == SECRET
    # the whole database file must not contain the plaintext either
    db_path = Path(settings.resolved_db_url().replace("sqlite:///", ""))
    if db_path.exists():
        assert SECRET.encode() not in db_path.read_bytes()


def test_provider_list_hides_key_material(authed):
    _create(authed, label="Listed provider", kind="mock", api_key=SECRET)
    body = authed.get("/api/providers").json()
    assert SECRET not in str(body)
    assert all("api_key" not in item for item in body["items"])


def test_provider_patch_can_rotate_a_key(authed):
    body = _create(authed, label="Rotate me", kind="mock", api_key=SECRET)
    updated = authed.patch(f"/api/providers/{body['id']}", json={"api_key": "sk-rotated-9999999999"})
    assert updated.status_code == 200
    assert updated.json()["has_key"] is True
    assert "sk-rotated" not in str(updated.json())


def test_provider_kinds_are_listed(authed):
    kinds = authed.get("/api/providers/kinds").json()
    names = {item["kind"] if isinstance(item, dict) else item for item in kinds["items"]}
    assert {"openai", "anthropic", "gemini", "ollama", "openrouter", "lmstudio", "mock"} <= names


def test_mock_provider_connectivity_test_is_honest(authed):
    body = _create(authed, label="Mock connectivity", kind="mock")
    result = authed.post(f"/api/providers/{body['id']}/test").json()
    assert result["ok"] is True
    assert result["mocked"] is True
    assert "mock" in result["message"].lower()


def test_unreachable_provider_test_reports_failure_without_crashing(authed):
    body = _create(authed, label="Unreachable", kind="openai_compatible",
                   base_url="http://127.0.0.1:9/v1", api_key=SECRET, is_paid=False)
    result = authed.post(f"/api/providers/{body['id']}/test").json()
    assert result["ok"] is False
    assert result["message"]
    assert SECRET not in result["message"]


# --------------------------------------------------------------------------- #
# zero-spend
# --------------------------------------------------------------------------- #
def test_zero_spend_blocks_paid_providers(authed):
    body = _create(authed, label="Paid OpenAI", kind="openai", api_key=SECRET, is_paid=True)
    assert providers.zero_spend_active() is True
    with pytest.raises(SpendBlockedError):
        asyncio.run(providers.complete(
            provider_id=body["id"], model="gpt-4o-mini", system="s", user="u",
            spend_authorized=False, purpose="test",
        ))


def test_zero_spend_never_selects_a_paid_provider(authed):
    paid = _create(authed, label="Paid only", kind="openai", api_key=SECRET, is_paid=True)
    provider_id, _ = providers.pick(role="coding", spend_authorized=False)
    assert provider_id != paid["id"]
    assert providers.snapshot(provider_id).is_paid is False


def test_pick_raises_when_only_paid_providers_exist(authed):
    paid = _create(authed, label="Paid exclusive", kind="openai", api_key=SECRET, is_paid=True)
    disabled: list[str] = []
    try:
        for item in authed.get("/api/providers").json()["items"]:
            if item["id"] != paid["id"] and not item["is_paid"] and item["is_enabled"]:
                authed.patch(f"/api/providers/{item['id']}", json={"is_enabled": False})
                disabled.append(item["id"])
        providers.invalidate()
        with pytest.raises(SpendBlockedError):
            providers.pick(role="coding", spend_authorized=False)
    finally:
        for provider_id in disabled:
            authed.patch(f"/api/providers/{provider_id}", json={"is_enabled": True})
        providers.invalidate()


def test_a_preferred_free_provider_is_honoured(authed):
    free = _create(authed, label="Ollama local", kind="ollama", base_url="http://127.0.0.1:11434",
                   is_paid=False, default_model="llama3.2")
    provider_id, model = providers.pick(role="coding", preferred_provider_id=free["id"],
                                        spend_authorized=False)
    assert provider_id == free["id"]
    assert model == "llama3.2"


def test_spend_can_be_authorized_explicitly_and_is_audited(authed):
    paid = _create(authed, label="Paid with authorization", kind="mock", is_paid=True)
    response = authed.post("/api/settings/zero-spend", params={"enabled": "false"})
    assert response.status_code == 200
    assert response.json()["zero_spend"] is False
    try:
        assert providers.zero_spend_active() is False
        provider_id, _ = providers.pick(role="coding", preferred_provider_id=paid["id"], spend_authorized=True)
        assert provider_id == paid["id"]
    finally:
        authed.post("/api/settings/zero-spend", params={"enabled": "true"})
    assert providers.zero_spend_active() is True
    audit = authed.get("/api/audit", params={"limit": 50}).json()
    assert any(item["action"] == "zero_spend.changed" for item in audit["items"])


def test_mock_completion_is_flagged_as_mocked(authed):
    body = _create(authed, label="Mock completion", kind="mock", is_paid=False)
    result = asyncio.run(providers.complete(
        provider_id=body["id"], model="mock-agent", system="You are a test.", user="Say something.",
        spend_authorized=False, purpose="test",
    ))
    assert result.mocked is True
    assert result.text
    assert result.total_tokens > 0
    assert result.provider_kind == "mock"


def test_usage_is_recorded_per_call(authed):
    body = _create(authed, label="Usage meter", kind="mock", is_paid=False)
    before = authed.get("/api/providers/usage/global").json()
    asyncio.run(providers.complete(provider_id=body["id"], model="mock-agent", system="s", user="u",
                                   spend_authorized=False, purpose="test"))
    after = authed.get("/api/providers/usage/global").json()
    assert after["calls"] == before["calls"] + 1
    assert after["mocked_calls"] >= 1
    per_provider = authed.get(f"/api/providers/{body['id']}/usage").json()
    assert per_provider["calls"] >= 1


# --------------------------------------------------------------------------- #
# knowledge base
# --------------------------------------------------------------------------- #
def test_knowledge_upload_indexes_and_searches(authed):
    document = (
        "# Deployment runbook\n\n"
        "The staging environment is deployed with docker compose up -d.\n"
        "Rollback uses git revert followed by a redeploy of the previous tag.\n"
    )
    response = authed.post(
        "/api/knowledge/upload",
        files={"file": ("runbook.md", document.encode(), "text/markdown")},
        data={"tags": "ops,deploy"},
    )
    assert response.status_code == 200, response.text
    source = response.json()
    assert source["chunk_count"] > 0
    assert source["size_bytes"] == len(document.encode())
    assert source["index_status"] == "indexed"

    hits = authed.get("/api/knowledge/search", params={"q": "rollback redeploy previous tag"}).json()
    assert hits["results"], "the uploaded document must be retrievable"
    assert hits["results"][0]["source_id"] == source["id"]
    assert "revert" in hits["results"][0]["text"].lower()

    stats = authed.get("/api/knowledge/stats").json()
    assert stats["sources"] >= 1 and stats["chunks"] >= 1
    assert stats["engine"] == "keyword-bm25", "retrieval is lexical; the UI must not claim embeddings"
    assert source["checksum"], "the stored source must carry a real checksum"


def test_knowledge_rejects_a_disallowed_file_type(authed):
    response = authed.post("/api/knowledge/upload",
                           files={"file": ("payload.exe", b"MZ\x90\x00", "application/octet-stream")})
    assert response.status_code in (400, 415, 422)
    assert response.json()["error"]["code"]


def test_knowledge_reindex_is_real_not_destructive(authed):
    response = authed.post(
        "/api/knowledge/upload",
        files={"file": ("notes.txt", b"alpha beta gamma delta\n" * 40, "text/plain")},
    )
    source_id = response.json()["id"]
    before = authed.get("/api/knowledge/search", params={"q": "alpha beta gamma"}).json()["results"]
    reindexed = authed.post(f"/api/knowledge/{source_id}/reindex")
    assert reindexed.status_code == 200, reindexed.text
    assert reindexed.json()["chunk_count"] >= 1
    with session_scope() as s:
        assert s.get(KnowledgeSource, source_id) is not None
        assert s.query(KnowledgeChunk).filter(KnowledgeChunk.source_id == source_id).count() > 0
    after = authed.get("/api/knowledge/search", params={"q": "alpha beta gamma"}).json()["results"]
    assert len(after) >= len(before)


def test_knowledge_delete_removes_the_rows_and_the_stored_bytes(authed):
    response = authed.post("/api/knowledge/upload",
                           files={"file": ("temp.md", b"# Temporary\n\ncontent to delete\n", "text/markdown")})
    source_id = response.json()["id"]
    with session_scope() as s:
        storage = Path(s.get(KnowledgeSource, source_id).storage_path)
    assert storage.exists(), "the raw bytes must be persisted so reindex is possible"
    deleted = authed.delete(f"/api/knowledge/{source_id}")
    assert deleted.status_code == 200
    with session_scope() as s:
        assert s.get(KnowledgeSource, source_id) is None
        assert s.query(KnowledgeChunk).filter(KnowledgeChunk.source_id == source_id).count() == 0
    assert not storage.exists()


def test_ingest_rejects_an_oversized_or_hostile_filename(tmp_path):
    with pytest.raises(ValueError):
        ingest.index_source("../../etc/passwd", b"x" * (ingest.MAX_FILE_BYTES + 1), [])


# --------------------------------------------------------------------------- #
# verification and secret scanning
# --------------------------------------------------------------------------- #
def test_verify_task_runs_the_commands_and_reports_raw_evidence(workspace):
    ctx = ToolContext(root=workspace, timeout_seconds=30)
    (workspace / "README.md").write_text("# hello\n")
    result = asyncio.run(verifier.verify_task(ctx, {
        "id": "t1", "verify_commands": ["ls README.md", "ls missing-file.md"],
    }))
    assert result["verified"] is False
    assert len(result["checks"]) == 2
    assert result["checks"][0]["passed"] is True
    assert result["checks"][1]["passed"] is False
    assert result["checks"][1]["code"] != 0
    assert result["reason"]


def test_verify_task_passes_when_every_command_exits_zero(workspace):
    ctx = ToolContext(root=workspace, timeout_seconds=30)
    (workspace / "src").mkdir()
    (workspace / "src" / "app.py").write_text("VALUE = 41 + 1\n")
    result = asyncio.run(verifier.verify_task(ctx, {"id": "t1", "verify_commands": ["ls src/app.py"]}))
    assert result["verified"] is True
    assert result["reason"] == ""


def test_verify_task_is_honest_when_there_is_nothing_to_verify(workspace):
    ctx = ToolContext(root=workspace, timeout_seconds=30)
    result = asyncio.run(verifier.verify_task(ctx, {"id": "t1", "verify_commands": []}))
    assert result["verified"] is None
    assert "no verify_commands" in result["reason"]


def test_verify_task_reports_a_policy_denial_instead_of_running_it(workspace):
    ctx = ToolContext(root=workspace, timeout_seconds=30)
    result = asyncio.run(verifier.verify_task(ctx, {"id": "t1", "verify_commands": ["rm -rf /"]}))
    assert result["verified"] is False
    assert result["checks"][0]["policy_denied"] is True


def test_scan_for_secrets_finds_and_redacts(workspace):
    (workspace / ".env").write_text(f"OPENAI_API_KEY={SECRET}\n")
    (workspace / "clean.py").write_text("print('no secrets here')\n")
    findings = verifier.scan_for_secrets(workspace)
    assert findings, "a planted key must be found"
    assert findings[0]["file"] == ".env"
    assert findings[0]["excerpt"] == "[REDACTED]"
    assert SECRET not in str(findings)


# --------------------------------------------------------------------------- #
# memory
# --------------------------------------------------------------------------- #
def test_memory_recall_returns_what_was_remembered():
    memory.remember(namespace="backend", content="The billing API uses decimal amounts, never floats.",
                    scope="agent", scope_id="backend", kind="semantic")
    hits = memory.recall("decimal amounts billing", namespaces=("backend",))
    assert hits
    assert "decimal" in hits[0]["content"].lower()


def test_memory_recall_respects_namespaces():
    memory.remember(namespace="qa", content="Flaky test marker: retry twice before failing.", scope="agent")
    assert memory.recall("flaky test marker", namespaces=("qa",))
    assert memory.recall("flaky test marker", namespaces=("devops",)) == []
