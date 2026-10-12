"""Provider adapter base classes and error taxonomy.

Adapters normalise every supported AI service onto one interface so the
orchestrator never branches on vendor.  Errors are typed so the recovery
playbook (Part 3.6 of the master plan) can react precisely instead of guessing.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

RoleName = Literal["reasoning", "coding", "review", "fast", "local"]

ROLES: tuple[str, ...] = ("reasoning", "coding", "review", "fast", "local")


class ProviderError(Exception):
    """Base class for every provider failure."""

    code = "provider_error"
    retryable = False
    status: int | None = None

    def __init__(self, message: str, *, detail: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail


class ProviderAuthError(ProviderError):
    code = "provider_auth_error"
    retryable = False
    status = 401


class ProviderRateLimitError(ProviderError):
    code = "provider_rate_limited"
    retryable = True
    status = 429


class ProviderServerError(ProviderError):
    code = "provider_server_error"
    retryable = True
    status = 500


class ProviderTimeoutError(ProviderError):
    code = "provider_timeout"
    retryable = True


class ProviderNotFoundError(ProviderError):
    code = "provider_not_found"
    retryable = False
    status = 404


class ModelNotFoundError(ProviderError):
    code = "model_not_found"
    retryable = False
    status = 404


class SpendBlockedError(ProviderError):
    """Raised when zero-spend mode refuses a paid call."""

    code = "zero_spend_blocked"
    retryable = False
    status = 403


class UnsupportedCapabilityError(ProviderError):
    code = "unsupported_capability"
    retryable = False


@dataclass
class Capabilities:
    supports_system_prompt: bool = True
    supports_json_mode: bool = False
    supports_tools: bool = False
    supports_streaming: bool = False
    supports_cancellation: bool = False
    max_context_tokens: int = 8192
    model_discovery: bool = True


@dataclass
class CompletionResult:
    text: str
    model: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: float = 0.0
    finish_reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    mocked: bool = False
    provider_id: str | None = None
    provider_kind: str | None = None

    @property
    def total_tokens(self) -> int:
        return self.tokens_in + self.tokens_out


class ProviderAdapter(ABC):
    kind = "generic"
    capabilities = Capabilities()

    def __init__(
        self,
        *,
        provider_id: str,
        base_url: str,
        api_key: str | None = None,
        default_model: str | None = None,
        timeout: float = 120.0,
        extra_headers: dict[str, str] | None = None,
        organization_id: str | None = None,
    ) -> None:
        self.provider_id = provider_id
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key
        self.default_model = default_model
        self.timeout = timeout
        self.extra_headers = extra_headers or {}
        self.organization_id = organization_id

    # -- contract ----------------------------------------------------------- #
    @abstractmethod
    async def test(self) -> tuple[bool, str, float]:
        """Return ``(ok, human_readable_message, latency_ms)`` from a real call."""

    @abstractmethod
    async def complete(
        self,
        *,
        model: str | None,
        system: str,
        user: str,
        max_tokens: int = 1024,
        temperature: float = 0.3,
        timeout: float | None = None,
    ) -> CompletionResult:
        """One non-streaming completion."""

    async def list_models(self) -> list[str]:
        if not self.capabilities.model_discovery:
            raise UnsupportedCapabilityError(
                f"{self.kind} does not expose a model discovery endpoint; enter the model name manually."
            )
        return []

    # -- helpers ------------------------------------------------------------ #
    def headers(self) -> dict[str, str]:
        merged = {"content-type": "application/json", **self.extra_headers}
        if self.api_key:
            merged["authorization"] = f"Bearer {self.api_key}"
        if self.organization_id:
            merged["openai-organization"] = self.organization_id
        return merged

    def resolve_model(self, model: str | None) -> str:
        chosen = model or self.default_model
        if not chosen:
            raise ModelNotFoundError(
                "No model was specified for this provider and it has no default model configured."
            )
        return chosen
