"""Native Anthropic adapter (``/v1/messages``)."""

from __future__ import annotations

import time

import httpx

from .base import Capabilities, CompletionResult, ProviderAdapter
from .http import map_transport_error, raise_for_status

ANTHROPIC_VERSION = "2023-06-01"


class AnthropicAdapter(ProviderAdapter):
    kind = "anthropic"
    capabilities = Capabilities(
        supports_system_prompt=True,
        supports_json_mode=False,
        supports_tools=True,
        supports_streaming=True,
        supports_cancellation=True,
        max_context_tokens=200_000,
        model_discovery=True,
    )

    def headers(self) -> dict[str, str]:
        merged = {"content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, **self.extra_headers}
        if self.api_key:
            merged["x-api-key"] = self.api_key
        return merged

    async def test(self) -> tuple[bool, str, float]:
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout, 20)) as client:
                response = await client.get(f"{self.base_url}/v1/models", headers=self.headers())
            latency = (time.perf_counter() - started) * 1000
            if response.status_code == 404:
                # Older gateways do not expose /v1/models — fall back to a 1-token call.
                return await self._probe_completion()
            raise_for_status(response, kind=self.kind)
            data = response.json()
            rows = data.get("data", []) if isinstance(data, dict) else []
            return True, f"reachable — {len(rows)} model(s) discovered in {latency:.0f} ms", latency
        except Exception as exc:
            latency = (time.perf_counter() - started) * 1000
            return False, map_transport_error(exc, kind=self.kind).message, latency

    async def _probe_completion(self) -> tuple[bool, str, float]:
        started = time.perf_counter()
        payload = {
            "model": self.resolve_model(None),
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout, 30)) as client:
                response = await client.post(f"{self.base_url}/v1/messages", json=payload, headers=self.headers())
            latency = (time.perf_counter() - started) * 1000
            raise_for_status(response, kind=self.kind)
            return True, f"reachable — completion probe succeeded in {latency:.0f} ms", latency
        except Exception as exc:
            latency = (time.perf_counter() - started) * 1000
            return False, map_transport_error(exc, kind=self.kind).message, latency

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=min(self.timeout, 20)) as client:
            response = await client.get(f"{self.base_url}/v1/models", headers=self.headers())
        raise_for_status(response, kind=self.kind)
        data = response.json()
        rows = data.get("data", []) if isinstance(data, dict) else []
        return sorted({str(r.get("id")) for r in rows if isinstance(r, dict) and r.get("id")})

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
        chosen = self.resolve_model(model)
        payload = {
            "model": chosen,
            "max_tokens": max(1, max_tokens),
            "temperature": temperature,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/v1/messages", json=payload, headers=self.headers()
                )
            raise_for_status(response, kind=self.kind)
            data = response.json()
        except Exception as exc:
            raise map_transport_error(exc, kind=self.kind) from exc

        latency = (time.perf_counter() - started) * 1000
        blocks = data.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        usage = data.get("usage") or {}
        return CompletionResult(
            text=text,
            model=data.get("model", chosen),
            tokens_in=int(usage.get("input_tokens") or 0),
            tokens_out=int(usage.get("output_tokens") or 0),
            latency_ms=round(latency, 2),
            finish_reason=data.get("stop_reason"),
            raw=data,
            provider_id=self.provider_id,
            provider_kind=self.kind,
        )
