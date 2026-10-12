"""Persistence models.

Every entity carries ``id`` / ``created_at`` / ``updated_at`` where meaningful.
JSON columns are used for structured lists and dicts so the schema stays
portable between SQLite (default) and PostgreSQL.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def uid() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #
class Provider(TimestampMixin, Base):
    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    label: Mapped[str] = mapped_column(String, default="")
    kind: Mapped[str] = mapped_column(String, default="openai_compatible")
    base_url: Mapped[str] = mapped_column(String, default="")
    api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    organization_id: Mapped[str | None] = mapped_column(String, nullable=True)
    default_model: Mapped[str | None] = mapped_column(String, nullable=True)
    fallback_model: Mapped[str | None] = mapped_column(String, nullable=True)
    is_paid: Mapped[bool] = mapped_column(Boolean, default=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    requests_per_minute: Mapped[int] = mapped_column(Integer, default=120)
    max_concurrent: Mapped[int] = mapped_column(Integer, default=2)
    timeout_seconds: Mapped[float] = mapped_column(Float, default=120.0)
    max_retries: Mapped[int] = mapped_column(Integer, default=2)
    extra_headers: Mapped[dict] = mapped_column(JSON, default=dict)
    # logical role -> concrete model name
    role_models: Mapped[dict] = mapped_column(JSON, default=dict)
    models_discovered: Mapped[list] = mapped_column(JSON, default=list)
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_test_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_test_latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)


class UsageRecord(TimestampMixin, Base):
    __tablename__ = "usage_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    provider_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    task_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    purpose: Mapped[str] = mapped_column(String, default="generation")
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    mocked: Mapped[bool] = mapped_column(Boolean, default=False)


# --------------------------------------------------------------------------- #
# Agents
# --------------------------------------------------------------------------- #
class Agent(TimestampMixin, Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, default="")
    role: Mapped[str] = mapped_column(String, default="")
    department: Mapped[str] = mapped_column(String, default="")
    personality: Mapped[str] = mapped_column(Text, default="")
    responsibilities: Mapped[list] = mapped_column(JSON, default=list)
    prohibited: Mapped[list] = mapped_column(JSON, default=list)
    skills: Mapped[list] = mapped_column(JSON, default=list)
    tools: Mapped[list] = mapped_column(JSON, default=list)
    model_role: Mapped[str] = mapped_column(String, default="coding")
    provider_id: Mapped[str | None] = mapped_column(String, nullable=True)
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    memory_namespace: Mapped[str] = mapped_column(String, default="")
    max_parallel_tasks: Mapped[int] = mapped_column(Integer, default=1)
    temperature: Mapped[float] = mapped_column(Float, default=0.3)
    max_tokens: Mapped[int] = mapped_column(Integer, default=2500)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # live runtime state
    status: Mapped[str] = mapped_column(String, default="idle", index=True)
    current_task_id: Mapped[str | None] = mapped_column(String, nullable=True)
    avatar_seed: Mapped[str] = mapped_column(String, default=uid)
    city_x: Mapped[float] = mapped_column(Float, default=0.0)
    city_y: Mapped[float] = mapped_column(Float, default=0.0)
    home_x: Mapped[float] = mapped_column(Float, default=0.0)
    home_y: Mapped[float] = mapped_column(Float, default=0.0)


# --------------------------------------------------------------------------- #
# Projects, plans, tasks
# --------------------------------------------------------------------------- #
class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String, default="")
    objective: Mapped[str] = mapped_column(Text, default="")
    workspace_path: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, default="created", index=True)
    preview_url: Mapped[str | None] = mapped_column(String, nullable=True)
    preview_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    report: Mapped[dict] = mapped_column(JSON, default=dict)
    git_branch: Mapped[str | None] = mapped_column(String, nullable=True)


class Plan(TimestampMixin, Base):
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String, ForeignKey("projects.id"), index=True)
    objective: Mapped[str] = mapped_column(Text, default="")
    requirements: Mapped[list] = mapped_column(JSON, default=list)
    acceptance_criteria: Mapped[list] = mapped_column(JSON, default=list)
    assumptions: Mapped[list] = mapped_column(JSON, default=list)
    clarifying_questions: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String, default="draft", index=True)
    dag: Mapped[dict] = mapped_column(JSON, default=dict)
    produced_by: Mapped[str] = mapped_column(String, default="ceo")
    heuristic: Mapped[bool] = mapped_column(Boolean, default=False)
    validation: Mapped[dict] = mapped_column(JSON, default=dict)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    weight_total: Mapped[int] = mapped_column(Integer, default=0)
    weight_done: Mapped[int] = mapped_column(Integer, default=0)
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0)
    spend_authorized: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    plan_id: Mapped[str] = mapped_column(String, ForeignKey("plans.id"), index=True)
    project_id: Mapped[str] = mapped_column(String, ForeignKey("projects.id"), index=True)
    external_id: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    agent_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)
    depends_on: Mapped[list] = mapped_column(JSON, default=list)
    outputs: Mapped[list] = mapped_column(JSON, default=list)
    done_criteria: Mapped[list] = mapped_column(JSON, default=list)
    verify_commands: Mapped[list] = mapped_column(JSON, default=list)
    priority: Mapped[int] = mapped_column(Integer, default=3)
    effort: Mapped[int] = mapped_column(Integer, default=1)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    budget_tokens: Mapped[int] = mapped_column(Integer, default=8000)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=600)
    retries: Mapped[int] = mapped_column(Integer, default=0)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    files_changed: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    verification: Mapped[dict] = mapped_column(JSON, default=dict)
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ToolCall(TimestampMixin, Base):
    __tablename__ = "tool_calls"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    task_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    agent_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    tool: Mapped[str] = mapped_column(String, default="")
    args: Mapped[dict] = mapped_column(JSON, default=dict)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    denied: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[float] = mapped_column(Float, default=0.0)
    workspace_hash_before: Mapped[str | None] = mapped_column(String, nullable=True)
    workspace_hash_after: Mapped[str | None] = mapped_column(String, nullable=True)


# --------------------------------------------------------------------------- #
# Events, audit, checkpoints
# --------------------------------------------------------------------------- #
class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String, index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    priority: Mapped[str] = mapped_column(String, default="normal", index=True)
    notify: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class AuditRecord(Base):
    __tablename__ = "audit_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(String, default="system", index=True)
    action: Mapped[str] = mapped_column(String, index=True)
    target: Mapped[str | None] = mapped_column(String, nullable=True)
    result: Mapped[str] = mapped_column(String, default="ok")
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class Checkpoint(TimestampMixin, Base):
    __tablename__ = "checkpoints"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    plan_id: Mapped[str] = mapped_column(String, index=True)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    reason: Mapped[str] = mapped_column(String, default="task_completed")


# --------------------------------------------------------------------------- #
# Approvals
# --------------------------------------------------------------------------- #
class Approval(TimestampMixin, Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    plan_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    task_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    requested_by: Mapped[str] = mapped_column(String, default="orchestrator")
    action: Mapped[str] = mapped_column(String, default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    risk: Mapped[str] = mapped_column(String, default="medium")
    risk_score: Mapped[float] = mapped_column(Float, default=0.5)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decision_note: Mapped[str | None] = mapped_column(Text, nullable=True)


# --------------------------------------------------------------------------- #
# Conversations & memory
# --------------------------------------------------------------------------- #
class Message(TimestampMixin, Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    agent_id: Mapped[str] = mapped_column(String, index=True)
    task_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    project_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    role: Mapped[str] = mapped_column(String, default="assistant")
    content: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)


class MemoryItem(TimestampMixin, Base):
    __tablename__ = "memory_items"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    namespace: Mapped[str] = mapped_column(String, index=True)
    scope: Mapped[str] = mapped_column(String, default="agent")  # agent | project | company
    scope_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    key: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String, default="episodic")
    weight: Mapped[float] = mapped_column(Float, default=1.0)


# --------------------------------------------------------------------------- #
# Knowledge base
# --------------------------------------------------------------------------- #
class KnowledgeSource(TimestampMixin, Base):
    __tablename__ = "knowledge_sources"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String, default="")
    kind: Mapped[str] = mapped_column(String, default="text")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    checksum: Mapped[str] = mapped_column(String, default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    index_status: Mapped[str] = mapped_column(String, default="pending")
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    storage_path: Mapped[str | None] = mapped_column(String, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    source_id: Mapped[str] = mapped_column(String, index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text, default="")
    tokens: Mapped[list] = mapped_column(JSON, default=list)


# --------------------------------------------------------------------------- #
# Decisions (System 1)
# --------------------------------------------------------------------------- #
class DecisionRecord(TimestampMixin, Base):
    __tablename__ = "decision_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    plan_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    task_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    decision_type: Mapped[str] = mapped_column(String, default="", index=True)
    engine: Mapped[str] = mapped_column(String, default="local")
    state_hash: Mapped[str] = mapped_column(String, default="", index=True)
    questions: Mapped[dict] = mapped_column(JSON, default=dict)
    answers: Mapped[dict] = mapped_column(JSON, default=dict)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    #: "auto" when System 1 cleared its gate, "escalate" when it did not.
    action: Mapped[str] = mapped_column(String, default="auto")
    fallback_used: Mapped[bool] = mapped_column(Boolean, default=False)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)


# --------------------------------------------------------------------------- #
# Settings (runtime-editable)
# --------------------------------------------------------------------------- #
class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, default=None)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


SETTING_KEYS: dict[str, Any] = {
    "zero_spend": True,
    "max_concurrency": 4,
    "task_timeout_seconds": 600,
    "shell_timeout_seconds": 120,
    "max_repairs": 2,
    "sandbox_tier": 1,
    "decision_confidence_threshold": 0.85,
    "decision_mode": "auto",
    "decisions_enabled": True,
    "guardrail_sensitivity": "medium",
    "auto_approve_low_risk": True,
    "compact_mode": False,
    "default_provider_id": "",
    "fallback_provider_id": "",
    "plan_token_budget": 400_000,
    "global_token_budget": 2_000_000,
}


def get_setting(key: str, default: Any = None) -> Any:
    from .db import session_scope

    with session_scope() as s:
        row = s.get(AppSetting, key)
        if row is not None:
            return row.value
    return SETTING_KEYS.get(key, default)


def set_setting(key: str, value: Any) -> None:
    from .db import session_scope

    with session_scope() as s:
        row = s.get(AppSetting, key)
        if row is None:
            s.add(AppSetting(key=key, value=value))
        else:
            row.value = value


def all_settings() -> dict[str, Any]:
    from .db import session_scope

    merged = dict(SETTING_KEYS)
    with session_scope() as s:
        for row in s.query(AppSetting).all():
            merged[row.key] = row.value
    return merged
