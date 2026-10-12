"""Pydantic contracts for the HTTP API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# objectives / plans / tasks
# --------------------------------------------------------------------------- #
class ObjectiveIn(BaseModel):
    objective: str = Field(min_length=3, max_length=8000)
    project_name: str | None = Field(default=None, max_length=80)
    spend_authorized: bool = False
    auto_start: bool = True


class ObjectiveOut(BaseModel):
    project_id: str
    plan_id: str
    state: str
    task_count: int = 0
    workspace: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    validation: dict[str, Any] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)


class TaskOut(ORMModel):
    id: str
    external_id: str
    plan_id: str
    project_id: str
    title: str
    description: str
    agent_id: str | None
    status: str
    depends_on: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)
    done_criteria: list[str] = Field(default_factory=list)
    verify_commands: list[str] = Field(default_factory=list)
    priority: int
    effort: int
    order_index: int
    retries: int
    summary: str | None = None
    error: str | None = None
    files_changed: list[str] = Field(default_factory=list)
    verification: dict[str, Any] = Field(default_factory=dict)
    tokens_used: int = 0
    created_at: Any = None
    updated_at: Any = None


class PlanOut(ORMModel):
    id: str
    project_id: str
    objective: str
    state: str
    requirements: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    clarifying_questions: list[str] = Field(default_factory=list)
    heuristic: bool = False
    validation: dict[str, Any] = Field(default_factory=dict)
    progress: float = 0.0
    weight_done: int = 0
    weight_total: int = 0
    tokens_used: int = 0
    cost_estimate: float = 0.0
    spend_authorized: bool = False
    failure_reason: str | None = None
    started_at: Any = None
    finished_at: Any = None


class ProjectOut(ORMModel):
    id: str
    name: str
    objective: str
    workspace_path: str
    status: str
    preview_url: str | None = None
    preview_port: int | None = None
    git_branch: str | None = None
    created_at: Any = None


# --------------------------------------------------------------------------- #
# agents
# --------------------------------------------------------------------------- #
class AgentOut(ORMModel):
    id: str
    name: str
    role: str
    department: str
    personality: str = ""
    responsibilities: list[str] = Field(default_factory=list)
    prohibited: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    model_role: str = "coding"
    provider_id: str | None = None
    model: str | None = None
    memory_namespace: str = ""
    max_parallel_tasks: int = 1
    temperature: float = 0.3
    max_tokens: int = 2500
    is_enabled: bool = True
    status: str = "idle"
    current_task_id: str | None = None
    avatar_seed: str = ""
    city_x: float = 0.0
    city_y: float = 0.0
    home_x: float = 0.0
    home_y: float = 0.0
    is_decision_agent: bool = False


class AgentPatch(BaseModel):
    provider_id: str | None = None
    model: str | None = None
    is_enabled: bool | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=128, le=32768)
    max_parallel_tasks: int | None = Field(default=None, ge=1, le=4)
    tools: list[str] | None = None


# --------------------------------------------------------------------------- #
# providers
# --------------------------------------------------------------------------- #
ProviderKind = Literal[
    "openai", "openai_compatible", "openrouter", "lmstudio", "vllm",
    "anthropic", "gemini", "google", "ollama", "mock",
]


class ProviderIn(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    kind: ProviderKind
    base_url: str = ""
    api_key: str | None = Field(default=None, max_length=512)
    organization_id: str | None = None
    default_model: str | None = None
    fallback_model: str | None = None
    is_paid: bool = True
    is_enabled: bool = True
    requests_per_minute: int = Field(default=120, ge=1, le=10000)
    max_concurrent: int = Field(default=2, ge=1, le=32)
    timeout_seconds: float = Field(default=120.0, ge=5.0, le=900.0)
    max_retries: int = Field(default=2, ge=0, le=8)
    extra_headers: dict[str, str] = Field(default_factory=dict)
    role_models: dict[str, str] = Field(default_factory=dict)


class ProviderPatch(BaseModel):
    label: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    organization_id: str | None = None
    default_model: str | None = None
    fallback_model: str | None = None
    is_paid: bool | None = None
    is_enabled: bool | None = None
    requests_per_minute: int | None = Field(default=None, ge=1, le=10000)
    max_concurrent: int | None = Field(default=None, ge=1, le=32)
    timeout_seconds: float | None = Field(default=None, ge=5.0, le=900.0)
    max_retries: int | None = Field(default=None, ge=0, le=8)
    extra_headers: dict[str, str] | None = None
    role_models: dict[str, str] | None = None


class ProviderOut(ORMModel):
    id: str
    label: str
    kind: str
    base_url: str
    organization_id: str | None = None
    default_model: str | None = None
    fallback_model: str | None = None
    is_paid: bool
    is_enabled: bool
    requests_per_minute: int
    max_concurrent: int
    timeout_seconds: float
    max_retries: int
    extra_headers: dict[str, str] = Field(default_factory=dict)
    role_models: dict[str, str] = Field(default_factory=dict)
    models_discovered: list[str] = Field(default_factory=list)
    last_test_at: Any = None
    last_test_ok: bool | None = None
    last_test_message: str | None = None
    last_test_latency_ms: float | None = None
    has_key: bool = False
    key_fingerprint: str = ""


class SpendAuthorization(BaseModel):
    plan_id: str
    authorized: bool = True
    note: str = ""


# --------------------------------------------------------------------------- #
# knowledge, approvals, settings
# --------------------------------------------------------------------------- #
class KnowledgeOut(ORMModel):
    id: str
    name: str
    kind: str
    size_bytes: int
    checksum: str
    tags: list[str] = Field(default_factory=list)
    index_status: str
    chunk_count: int
    error: str | None = None
    created_at: Any = None


class ApprovalDecision(BaseModel):
    approved: bool
    note: str = ""


class ApprovalOut(ORMModel):
    id: str
    plan_id: str | None = None
    task_id: str | None = None
    requested_by: str
    action: str
    detail: dict[str, Any] = Field(default_factory=dict)
    risk: str
    risk_score: float
    status: str
    decided_at: Any = None
    decision_note: str | None = None
    created_at: Any = None


class SettingsPatch(BaseModel):
    zero_spend: bool | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=16)
    max_tasks_per_agent: int | None = Field(default=None, ge=1, le=8)
    task_timeout_seconds: int | None = Field(default=None, ge=10, le=7200)
    shell_timeout_seconds: int | None = Field(default=None, ge=5, le=3600)
    max_repairs: int | None = Field(default=None, ge=0, le=8)
    sandbox_tier: int | None = Field(default=None, ge=1, le=2)
    decision_confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    decision_mode: Literal["auto", "laya", "laya_mnn", "laya_hosted", "local", "llm"] | None = None
    decisions_enabled: bool | None = None
    guardrail_sensitivity: Literal["low", "medium", "high"] | None = None
    auto_approve_low_risk: bool | None = None
    low_risk_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    compact_mode: bool | None = None
    default_provider_id: str | None = None
    fallback_provider_id: str | None = None
    plan_token_budget: int | None = Field(default=None, ge=1000)
    global_token_budget: int | None = Field(default=None, ge=1000)
    approval_timeout_seconds: int | None = Field(default=None, ge=0, le=86400)


class DecisionProbe(BaseModel):
    decision_type: str = "routing"
    state: dict[str, Any] = Field(default_factory=dict)
    questions: dict[str, dict[str, Any]] = Field(default_factory=dict)
