"""Ollama adapter (local inference, ``/api/chat`` + ``/api/tags``)."""

from __future__ import annotations

import time

import httpx

from .base import Capabilities, CompletionResult, ProviderAdapter
from .http import map_transport_error, raise_for_status


class OllamaAdapter(ProviderAdapter):
    kind = "ollama"
    capabilities = Capabilities(
        supports_system_prompt=True,
        supports_json_mode=True,
        supports_tools=False,
        supports_streaming=True,
        supports_cancellation=True,
        max_context_tokens=32_768,
        model_discovery=True,
    )

    async def test(self) -> tuple[bool, str, float]:
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout, 10)) as client:
                response = await client.get(f"{self.base_url}/api/tags")
            latency = (time.perf_counter() - started) * 1000
            raise_for_status(response, kind=self.kind)
            models = (response.json() or {}).get("models", [])
            if not models:
                return (
                    False,
                    "Ollama is reachable but has no models pulled yet. Run `ollama pull <model>` and retry.",
                    latency,
                )
            names = ", ".join(str(m.get("name")) for m in models[:5])
            return True, f"reachable — {len(models)} model(s): {names} ({latency:.0f} ms)", latency
        except Exception as exc:
            latency = (time.perf_counter() - started) * 1000
            error = map_transport_error(exc, kind=self.kind)
            message = error.message
            if "Could not reach" in message:
                message += " Start Ollama with `ollama serve` (default http://127.0.0.1:11434)."
            return False, message, latency

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=min(self.timeout, 10)) as client:
            response = await client.get(f"{self.base_url}/api/tags")
        raise_for_status(response, kind=self.kind)
        models = (response.json() or {}).get("models", [])
        return sorted({str(m.get("name")) for m in models if m.get("name")})

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
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout or max(self.timeout, 300)) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
            raise_for_status(response, kind=self.kind)
            data = response.json()
        except Exception as exc:
            raise map_transport_error(exc, kind=self.kind) from exc

        latency = (time.perf_counter() - started) * 1000
        message = data.get("message") or {}
        return CompletionResult(
            text=message.get("content") or data.get("response") or "",
            model=data.get("model", chosen),
            tokens_in=int(data.get("prompt_eval_count") or 0),
            tokens_out=int(data.get("eval_count") or 0),
            latency_ms=round(latency, 2),
            finish_reason=message.get("role") if message.get("done") else None,
            raw=data,
            provider_id=self.provider_id,
            provider_kind=self.kind,
        )
