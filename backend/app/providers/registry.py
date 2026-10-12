"""Provider registry: adapter construction, spend gating, rate limiting, retries.

This is the only place in the codebase that decrypts an API key.  Keys never
leave this module: adapters are built here, used here, and dropped here.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass

from ..config import settings
from ..db import session_scope
from ..models import Provider, UsageRecord, get_setting
from ..security.crypto import decrypt
from .anthropic import AnthropicAdapter
from .base import (
    ROLES,
    CompletionResult,
    ProviderAdapter,
    ProviderError,
    ProviderNotFoundError,
    SpendBlockedError,
)
from .gemini import GeminiAdapter
from .mock import MockAdapter
from .ollama import OllamaAdapter
from .openai_compat import OpenAICompatAdapter

log = logging.getLogger("pranit.providers")

ADAPTERS: dict[str, type[ProviderAdapter]] = {
    "openai": OpenAICompatAdapter,
    "openai_compatible": OpenAICompatAdapter,
    "openrouter": OpenAICompatAdapter,
    "lmstudio": OpenAICompatAdapter,
    "vllm": OpenAICompatAdapter,
    "anthropic": AnthropicAdapter,
    "gemini": GeminiAdapter,
    "google": GeminiAdapter,
    "ollama": OllamaAdapter,
    "mock": MockAdapter,
}

DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "openai_compatible": "http://127.0.0.1:8080/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "anthropic": "https://api.anthropic.com",
    "gemini": "https://generativelanguage.googleapis.com",
    "google": "https://generativelanguage.googleapis.com",
    "ollama": "http://127.0.0.1:11434",
    "mock": "mock://local",
}

#: rough public per-million-token prices used for cost estimates only
PRICE_PER_MILLION: dict[str, tuple[float, float]] = {
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1": (2.00, 8.00),
    "claude-sonnet": (3.00, 15.00),
    "claude-haiku": (0.80, 4.00),
    "claude-opus": (15.00, 75.00),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-flash": (0.30, 2.50),
}
FREE_PREFIXES = ("llama", "qwen", "mistral", "phi", "gemma", "deepseek-r1", "mock", "nomic", "codellama")


@dataclass
class ProviderSnapshot:
    id: str
    label: str
    kind: str
    base_url: str
    default_model: str | None
    fallback_model: str | None
    is_paid: bool
    is_enabled: bool
    role_models: dict
    requests_per_minute: int
    max_concurrent: int
    timeout_seconds: float
    max_retries: int
    extra_headers: dict
    organization_id: str | None


def estimate_cost(model: str | None, tokens_in: int, tokens_out: int) -> float:
    if not model:
        return 0.0
    lowered = model.lower()
    if any(lowered.startswith(p) for p in FREE_PREFIXES):
        return 0.0
    for key, (pin, pout) in PRICE_PER_MILLION.items():
        if key in lowered:
            return round((tokens_in / 1_000_000) * pin + (tokens_out / 1_000_000) * pout, 6)
    # Unknown paid model: assume a mid-range price so the budget guard is not blind.
    return round((tokens_in / 1_000_000) * 2.0 + (tokens_out / 1_000_000) * 8.0, 6)


def _snapshot(row: Provider) -> ProviderSnapshot:
    return ProviderSnapshot(
        id=row.id,
        label=row.label,
        kind=row.kind,
        base_url=row.base_url or DEFAULT_BASE_URLS.get(row.kind, ""),
        default_model=row.default_model,
        fallback_model=row.fallback_model,
        is_paid=bool(row.is_paid),
        is_enabled=bool(row.is_enabled),
        role_models=dict(row.role_models or {}),
        requests_per_minute=int(row.requests_per_minute or 120),
        max_concurrent=int(row.max_concurrent or 2),
        timeout_seconds=float(row.timeout_seconds or settings.provider_request_timeout),
        max_retries=int(row.max_retries or 2),
        extra_headers=dict(row.extra_headers or {}),
        organization_id=row.organization_id,
    )


def build_adapter(snapshot: ProviderSnapshot) -> ProviderAdapter:
    cls = ADAPTERS.get(snapshot.kind)
    if cls is None:
        raise ProviderNotFoundError(
            f"Unsupported provider kind '{snapshot.kind}'. Supported: {', '.join(sorted(ADAPTERS))}"
        )
    return cls(
        provider_id=snapshot.id,
        base_url=snapshot.base_url,
        api_key=None,  # injected below, only for adapters that need it
        default_model=snapshot.default_model,
        timeout=snapshot.timeout_seconds,
        extra_headers=snapshot.extra_headers,
        organization_id=snapshot.organization_id,
    )


class ProviderService:
    def __init__(self) -> None:
        self._adapters: dict[str, ProviderAdapter] = {}
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._windows: dict[str, deque[float]] = {}
        self._lock = asyncio.Lock()

    # -- cache -------------------------------------------------------------- #
    def invalidate(self, provider_id: str | None = None) -> None:
        if provider_id is None:
            self._adapters.clear()
        else:
            self._adapters.pop(provider_id, None)

    def snapshot(self, provider_id: str) -> ProviderSnapshot:
        with session_scope() as s:
            row = s.get(Provider, provider_id)
            if row is None:
                raise ProviderNotFoundError(f"Provider '{provider_id}' does not exist.")
            return _snapshot(row)

    def all_snapshots(self, *, enabled_only: bool = False) -> list[ProviderSnapshot]:
        with session_scope() as s:
            query = s.query(Provider)
            if enabled_only:
                query = query.filter(Provider.is_enabled.is_(True))
            return [_snapshot(row) for row in query.all()]

    def adapter(self, provider_id: str) -> ProviderAdapter:
        cached = self._adapters.get(provider_id)
        if cached is not None:
            return cached
        snapshot = self.snapshot(provider_id)
        adapter = build_adapter(snapshot)
        if snapshot.kind != "mock":
            with session_scope() as s:
                row = s.get(Provider, provider_id)
                adapter.api_key = decrypt(row.api_key_enc) if row and row.api_key_enc else None
        self._adapters[provider_id] = adapter
        return adapter

    def _semaphore(self, snapshot: ProviderSnapshot) -> asyncio.Semaphore:
        sem = self._semaphores.get(snapshot.id)
        if sem is None or sem._value != snapshot.max_concurrent:  # noqa: SLF001 - deliberate resize check
            sem = asyncio.Semaphore(max(1, snapshot.max_concurrent))
            self._semaphores[snapshot.id] = sem
        return sem

    async def _rate_gate(self, snapshot: ProviderSnapshot) -> None:
        window = self._windows.setdefault(snapshot.id, deque())
        limit = max(1, snapshot.requests_per_minute)
        while True:
            cutoff = time.monotonic() - 60.0
            while window and window[0] < cutoff:
                window.popleft()
            if len(window) < limit:
                window.append(time.monotonic())
                return
            wait = 60.0 - (time.monotonic() - window[0]) + 0.05
            await asyncio.sleep(max(0.05, min(wait, 5.0)))

    # -- selection ---------------------------------------------------------- #
    def zero_spend_active(self) -> bool:
        try:
            return bool(get_setting("zero_spend", settings.zero_spend))
        except Exception:  # pragma: no cover - db not ready
            return settings.zero_spend

    def pick(
        self,
        *,
        role: str = "coding",
        preferred_provider_id: str | None = None,
        preferred_model: str | None = None,
        spend_authorized: bool = False,
    ) -> tuple[str, str | None]:
        """Resolve ``(provider_id, model)`` honouring zero-spend and role mapping."""
        candidates = [s for s in self.all_snapshots(enabled_only=True)]
        if not candidates:
            raise ProviderNotFoundError(
                "No AI provider is configured. Open the Providers area and add one "
                "(Ollama for local/free, or the offline mock provider for a dry run)."
            )

        allow_paid = spend_authorized or not self.zero_spend_active()
        pool = candidates if allow_paid else [c for c in candidates if not c.is_paid]
        if not pool:
            raise SpendBlockedError(
                "Zero-spend mode is ON and every configured provider is marked as paid. "
                "Either add a free/local provider (Ollama or the offline mock) or authorise spend "
                "for this run from the Command Center."
            )

        default_id = str(get_setting("default_provider_id", settings.default_provider_id) or "")
        fallback_id = str(get_setting("fallback_provider_id", settings.fallback_provider_id) or "")

        ordered: list[ProviderSnapshot] = []
        for pid in (preferred_provider_id, default_id, fallback_id):
            for snapshot in pool:
                if pid and snapshot.id == pid and snapshot not in ordered:
                    ordered.append(snapshot)
        # local/free providers first, then the rest
        ordered.extend(sorted((s for s in pool if s not in ordered), key=lambda s: (s.is_paid, s.label)))

        chosen = ordered[0]
        model = (
            preferred_model
            or chosen.role_models.get(role)
            or chosen.default_model
            or chosen.fallback_model
        )
        return chosen.id, model

    def fallback_for(self, provider_id: str, *, spend_authorized: bool = False) -> tuple[str, str | None] | None:
        try:
            for snapshot in self.all_snapshots(enabled_only=True):
                if snapshot.id == provider_id:
                    continue
                if snapshot.is_paid and not spend_authorized and self.zero_spend_active():
                    continue
                return snapshot.id, snapshot.default_model
        except Exception:  # pragma: no cover - defensive
            return None
        return None

    # -- operations --------------------------------------------------------- #
    async def test(self, provider_id: str) -> dict:
        snapshot = self.snapshot(provider_id)
        adapter = self.adapter(provider_id)
        try:
            ok, message, latency = await adapter.test()
        except Exception as exc:
            ok, message, latency = False, f"{type(exc).__name__}: {exc}", 0.0
        with session_scope() as s:
            row = s.get(Provider, provider_id)
            if row is not None:
                from ..models import now as _now

                row.last_test_ok = ok
                row.last_test_message = message[:2000]
                row.last_test_latency_ms = latency
                row.last_test_at = _now()
        return {
            "ok": ok,
            "message": message,
            "latency_ms": round(latency, 2),
            "kind": snapshot.kind,
            "is_paid": snapshot.is_paid,
            # The UI must be able to tell a real provider from the offline mock.
            "mocked": snapshot.kind == "mock",
            "model": snapshot.default_model,
        }

    async def list_models(self, provider_id: str) -> list[str]:
        adapter = self.adapter(provider_id)
        models = await adapter.list_models()
        with session_scope() as s:
            row = s.get(Provider, provider_id)
            if row is not None:
                row.models_discovered = models
        return models

    async def complete(
        self,
        *,
        provider_id: str,
        model: str | None,
        system: str,
        user: str,
        max_tokens: int = 1024,
        temperature: float = 0.3,
        purpose: str = "generation",
        task_id: str | None = None,
        project_id: str | None = None,
        spend_authorized: bool = False,
        timeout: float | None = None,
    ) -> CompletionResult:
        snapshot = self.snapshot(provider_id)
        if snapshot.is_paid and not spend_authorized and self.zero_spend_active():
            raise SpendBlockedError(
                f"Zero-spend mode blocked a paid call to '{snapshot.label}'. Authorise spend for this "
                "run or switch to a free/local provider."
            )
        if not snapshot.is_enabled:
            raise ProviderError(f"Provider '{snapshot.label}' is disabled.")

        adapter = self.adapter(provider_id)
        sem = self._semaphore(snapshot)
        attempts = 0
        last_error: ProviderError | None = None

        async with sem:
            while attempts <= snapshot.max_retries:
                attempts += 1
                await self._rate_gate(snapshot)
                try:
                    result = await adapter.complete(
                        model=model,
                        system=system,
                        user=user,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        timeout=timeout,
                    )
                    self._record_usage(snapshot, result, purpose=purpose, task_id=task_id,
                                       project_id=project_id)
                    return result
                except ProviderError as exc:
                    last_error = exc
                    if not exc.retryable or attempts > snapshot.max_retries:
                        break
                    backoff = min(2 ** (attempts - 1) * 0.8, 8.0)
                    log.warning(
                        "provider %s attempt %d failed (%s); retrying in %.1fs",
                        snapshot.label, attempts, exc.code, backoff,
                    )
                    await asyncio.sleep(backoff)
                except Exception as exc:
                    last_error = ProviderError(f"{type(exc).__name__}: {exc}")
                    break

        assert last_error is not None
        raise last_error

    def _record_usage(
        self,
        snapshot: ProviderSnapshot,
        result: CompletionResult,
        *,
        purpose: str,
        task_id: str | None,
        project_id: str | None,
    ) -> None:
        cost = 0.0 if (snapshot.is_paid is False or result.mocked) else estimate_cost(
            result.model, result.tokens_in, result.tokens_out
        )
        try:
            with session_scope() as s:
                s.add(
                    UsageRecord(
                        provider_id=snapshot.id,
                        model=result.model,
                        task_id=task_id,
                        project_id=project_id,
                        purpose=purpose,
                        tokens_in=result.tokens_in,
                        tokens_out=result.tokens_out,
                        cost_estimate=cost,
                        latency_ms=result.latency_ms,
                        mocked=result.mocked,
                    )
                )
        except Exception as exc:  # pragma: no cover - bookkeeping must never break a run
            log.warning("could not record usage: %s", exc)

    def usage_summary(self, provider_id: str | None = None) -> dict:
        with session_scope() as s:
            query = s.query(UsageRecord)
            if provider_id:
                query = query.filter(UsageRecord.provider_id == provider_id)
            rows = query.all()
        return {
            "calls": len(rows),
            "tokens_in": sum(r.tokens_in for r in rows),
            "tokens_out": sum(r.tokens_out for r in rows),
            "tokens_total": sum(r.tokens_in + r.tokens_out for r in rows),
            "cost_estimate": round(sum(r.cost_estimate for r in rows), 6),
            "mocked_calls": sum(1 for r in rows if r.mocked),
            "avg_latency_ms": round(sum(r.latency_ms for r in rows) / len(rows), 2) if rows else 0.0,
        }

    def global_usage(self) -> dict:
        return self.usage_summary(None)


providers = ProviderService()

__all__ = ["ADAPTERS", "DEFAULT_BASE_URLS", "ROLES", "ProviderService", "providers", "estimate_cost"]
