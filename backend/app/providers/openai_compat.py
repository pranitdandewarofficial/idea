"""OpenAI-compatible adapter.

Works with OpenAI, OpenRouter, Azure-style gateways, LM Studio, vLLM,
llama.cpp server, LiteLLM proxies and any endpoint exposing
``/models`` + ``/chat/completions``.
"""

from __future__ import annotations

import time

import httpx

from .base import Capabilities, CompletionResult, ProviderAdapter
from .http import map_transport_error, raise_for_status


class OpenAICompatAdapter(ProviderAdapter):
    kind = "openai_compatible"
    capabilities = Capabilities(
        supports_system_prompt=True,
        supports_json_mode=True,
        supports_tools=True,
        supports_streaming=True,
        supports_cancellation=True,
        max_context_tokens=128_000,
        model_discovery=True,
    )

    async def test(self) -> tuple[bool, str, float]:
        started = time.perf_counter()
        url = f"{self.base_url}/models"
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout, 20)) as client:
                response = await client.get(url, headers=self.headers())
            latency = (time.perf_counter() - started) * 1000
            raise_for_status(response, kind=self.kind)
            data = response.json()
            models = data.get("data") if isinstance(data, dict) else None
            count = len(models) if isinstance(models, list) else 0
            return True, f"reachable — {count} model(s) discovered in {latency:.0f} ms", latency
        except Exception as exc:
            latency = (time.perf_counter() - started) * 1000
            error = map_transport_error(exc, kind=self.kind)
            return False, error.message, latency

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=min(self.timeout, 20)) as client:
            response = await client.get(f"{self.base_url}/models", headers=self.headers())
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
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions", json=payload, headers=self.headers()
                )
            raise_for_status(response, kind=self.kind)
            data = response.json()
        except Exception as exc:
            raise map_transport_error(exc, kind=self.kind) from exc

        latency = (time.perf_counter() - started) * 1000
        choices = data.get("choices") or []
        text = ""
        finish = None
        if choices:
            message = choices[0].get("message") or {}
            text = message.get("content") or ""
            finish = choices[0].get("finish_reason")
        usage = data.get("usage") or {}
        return CompletionResult(
            text=text,
            model=data.get("model", chosen),
            tokens_in=int(usage.get("prompt_tokens") or 0),
            tokens_out=int(usage.get("completion_tokens") or 0),
            latency_ms=round(latency, 2),
            finish_reason=finish,
            raw=data,
            provider_id=self.provider_id,
            provider_kind=self.kind,
        )
