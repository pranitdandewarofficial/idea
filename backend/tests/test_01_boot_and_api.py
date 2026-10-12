"""Acceptance tests: boot, seeded company, city read model, auth, error envelope."""

from __future__ import annotations

from app.agents.profiles import PROFILES
from app.security.auth import current_token

EXPECTED_AGENTS = {p.id for p in PROFILES}


def test_health_is_unauthenticated_and_reports_real_state(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["zero_spend"] is True
    assert body["auth_enabled"] is True
    assert body["counts"]["agents"] == len(PROFILES)
    assert body["python"].startswith("3.")


def test_setup_status_returns_the_local_api_token(client):
    response = client.get("/api/setup/status")
    assert response.status_code == 200
    body = response.json()
    assert body["api_token"] == current_token()
    assert body["zero_spend"] is True
    assert body["decision_layer"]["enabled"] is True
    assert body["decision_layer"]["threshold"] == 0.85


def test_auth_is_enforced_without_a_token(client):
    response = client.get("/api/agents")
    assert response.status_code == 401
    envelope = response.json()
    assert set(envelope) == {"error"}
    assert envelope["error"]["code"] == "unauthorized"
    assert envelope["error"]["request_id"]


def test_auth_rejects_a_wrong_token(client):
    response = client.get("/api/agents", headers={"Authorization": "Bearer not-the-token"})
    assert response.status_code == 401


def test_every_agent_profile_is_seeded(authed):
    response = authed.get("/api/agents")
    assert response.status_code == 200
    payload = response.json()
    agents = payload["items"]
    assert payload["count"] == len(agents) == len(PROFILES)
    assert {a["id"] for a in agents} == EXPECTED_AGENTS
    # The eleven people from the brief, by name.
    names = {a["id"]: a["name"] for a in agents}
    assert names["ceo"] == "Pranit"
    assert names["pm"] == "Mira"
    assert names["architect"] == "Karan"
    assert names["research"] == "Anya"
    assert names["designer"] == "Reva"
    assert names["frontend"] == "Ishaan"
    assert names["backend"] == "Dev"
    assert names["qa"] == "Rhea"
    assert names["security"] == "Vikram"
    assert names["devops"] == "Noor"
    assert names["docs"] == "Tara"
    assert names["laya"] == "Laya"


def test_agent_detail_exposes_tools_and_output_contract(authed):
    response = authed.get("/api/agents/backend")
    assert response.status_code == 200
    agent = response.json()
    assert "write_file" in agent["tools"]
    assert agent["output_contract"]["type"] == "diff_summary"
    assert agent["status"] in {"idle", "working", "collaborating", "blocked", "waiting", "offline"}
    assert agent["load"] == 0


def test_agent_tools_cannot_be_widened_beyond_the_profile(authed):
    response = authed.patch("/api/agents/docs", json={"tools": ["read_file", "run_shell"]})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "tool_not_permitted"


def test_agent_tool_policy_reports_authorised_versus_granted(authed):
    """The UI whitelist editor reads this: granted can only ever shrink."""
    from app.agents.profiles import PROFILE_MAP

    response = authed.get("/api/agents/qa/tools")
    assert response.status_code == 200
    body = response.json()
    profile = PROFILE_MAP["qa"]

    assert body["agent_id"] == "qa"
    assert {tool["name"] for tool in body["authorised"]} == set(profile.tools)
    assert body["granted"] == sorted(profile.tools)
    assert body["revoked"] == []
    assert body["catalogue_size"] > len(profile.tools), "the catalogue is wider than any one agent"
    for tool in body["authorised"]:
        assert tool["description"], "every tool must explain itself to the founder"
        assert tool["category"]
        assert isinstance(tool["gated"], bool)
        assert 0.0 <= tool["risk"] <= 1.0


def test_agent_tool_policy_marks_approval_gated_tools(authed):
    body = authed.get("/api/agents/devops/tools").json()
    by_name = {tool["name"]: tool for tool in body["authorised"]}
    # run_shell is gated on the policy decision, delete_file is never auto-approved
    assert by_name["run_shell"]["gated"] is True
    assert by_name["read_file"]["gated"] is False
    assert by_name["run_shell"]["risk"] > by_name["read_file"]["risk"]


def test_agent_tool_policy_reflects_a_narrowed_whitelist(authed):
    narrowed = authed.patch("/api/agents/docs", json={"tools": ["read_file"]})
    assert narrowed.status_code == 200, narrowed.text
    try:
        body = authed.get("/api/agents/docs/tools").json()
        assert body["granted"] == ["read_file"]
        assert "write_file" in body["revoked"]
        assert {tool["name"] for tool in body["authorised"]} > {"read_file"}
    finally:
        from app.agents.profiles import PROFILE_MAP

        authed.patch("/api/agents/docs", json={"tools": sorted(PROFILE_MAP["docs"].tools)})


def test_agent_tool_policy_404s_for_an_unknown_agent(authed):
    response = authed.get("/api/agents/nobody/tools")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_unknown_agent_returns_the_error_envelope(authed):
    response = authed.get("/api/agents/does-not-exist")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_city_layout_is_server_authoritative(authed):
    response = authed.get("/api/city")
    assert response.status_code == 200
    city = response.json()
    assert city["world"]["width"] > 0 and city["world"]["height"] > 0
    assert len(city["buildings"]) >= 11
    assert len(city["roads"]) >= 1
    building_ids = {b["id"] for b in city["buildings"]}
    for agent in city["agents"]:
        assert agent["building_id"] in building_ids
        assert 0 <= agent["home_x"] <= city["world"]["width"]
        assert 0 <= agent["home_y"] <= city["world"]["height"]
    assert city["zero_spend"] is True
    assert isinstance(city["pending_approvals"], int)
    assert city["task_markers"] == []
    assert set(city["buildings_state"]) <= building_ids


def test_city_building_detail(authed):
    city = authed.get("/api/city").json()
    building_id = city["buildings"][0]["id"]
    response = authed.get(f"/api/city/buildings/{building_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["building"]["id"] == building_id
    assert "state" in body and "agents" in body

    missing = authed.get("/api/city/buildings/nope")
    assert missing.status_code == 404


def test_error_envelope_shape_on_validation_failure(authed):
    response = authed.post("/api/objectives", json={"objective": "x"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["request_id"]
    assert body["error"]["context"]["issues"]


def test_request_id_and_duration_headers(authed):
    response = authed.get("/api/health")
    assert response.headers.get("x-request-id")
    assert float(response.headers["x-duration-ms"]) >= 0.0


def test_no_secret_material_leaks_from_health_or_setup(client):
    for path in ("/api/health", "/api/setup/status"):
        body = client.get(path).json()
        assert "secret_key" not in str(body).lower()
