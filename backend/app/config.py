"""Application configuration.

All settings are read from environment variables prefixed with ``PRANIT_``
(or from a local ``.env`` file).  Paths are resolved relative to the repository
root so the backend behaves identically no matter which directory it is started
from.
"""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> backend/app -> backend -> repository root
BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PRANIT_",
        env_file=(str(REPO_ROOT / ".env"), str(BACKEND_DIR / ".env")),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- server ---
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]
    )

    # --- auth ---
    # When empty, a token is generated on first launch and written to .data/api_token.
    api_token: str = ""
    auth_enabled: bool = True

    # --- storage ---
    data_dir: Path = REPO_ROOT / ".data"
    db_url: str = ""
    workspaces_dir: Path = REPO_ROOT / "workspaces"

    # --- secrets ---
    secret_key: str = ""

    # --- execution limits ---
    zero_spend: bool = True
    max_concurrency: int = 4
    max_tasks_per_agent: int = 1
    max_plan_tasks: int = 25
    task_timeout_seconds: int = 600
    shell_timeout_seconds: int = 120
    agent_tool_rounds: int = 6
    max_repairs: int = 2
    plan_token_budget: int = 400_000
    global_token_budget: int = 2_000_000
    sandbox_tier: int = 1  # 1 = subprocess, 2 = docker
    docker_image: str = "python:3.12-slim"

    # --- decision layer (System 1) ---
    decisions_enabled: bool = True
    decision_mode: str = "auto"  # auto | laya | laya_mnn | laya_hosted | local | llm
    decision_confidence_threshold: float = 0.85
    decision_fallback_to_llm: bool = True
    decision_max_state_chars: int = 6000
    laya_model: str = "convaiinnovations/laya"
    laya_base_url: str = ""  # hosted Laya-compatible decision endpoint (optional)
    laya_api_key: str = ""  # optional, for hosted mode only
    laya_precision: str = "fp16"
    laya_threads: int = 4

    # --- previews ---
    # Template used to build a browser-reachable preview URL for a project dev
    # server, e.g. "https://{port}-mysandbox.example.app". Empty = local URL only.
    public_url_template: str = ""
    approval_timeout_seconds: int = 0  # 0 = wait indefinitely for a human decision
    auto_approve_low_risk: bool = True
    low_risk_threshold: float = 0.4

    # --- providers ---
    default_provider_id: str = ""
    fallback_provider_id: str = ""
    provider_request_timeout: float = 120.0

    def resolved_db_url(self) -> str:
        if self.db_url:
            return self.db_url
        return f"sqlite:///{(self.data_dir / 'pranit.db').as_posix()}"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.workspaces_dir.mkdir(parents=True, exist_ok=True)

    def ensure_secret_key(self) -> str:
        """Return a stable secret key, generating and persisting one if absent."""
        if self.secret_key:
            return self.secret_key
        self.ensure_dirs()
        key_file = self.data_dir / "secret_key"
        if key_file.exists():
            self.secret_key = key_file.read_text(encoding="utf-8").strip()
            return self.secret_key
        generated = secrets.token_urlsafe(48)
        key_file.write_text(generated, encoding="utf-8")
        key_file.chmod(0o600)
        self.secret_key = generated
        return generated

    def ensure_api_token(self) -> str:
        """Return the bearer token protecting the API, generating one if needed."""
        if self.api_token:
            return self.api_token
        self.ensure_dirs()
        token_file = self.data_dir / "api_token"
        if token_file.exists():
            self.api_token = token_file.read_text(encoding="utf-8").strip()
            return self.api_token
        generated = secrets.token_urlsafe(32)
        token_file.write_text(generated, encoding="utf-8")
        token_file.chmod(0o600)
        self.api_token = generated
        return generated


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s


settings = get_settings()
