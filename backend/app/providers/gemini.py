"""Native Google Gemini adapter (``generativelanguage.googleapis.com``)."""

from __future__ import annotations

import time

import httpx

from .base import Capabilities, CompletionResult, ProviderAdapter
from .http import map_transport_error, raise_for_status

API_VERSION = "v1beta"


class GeminiAdapter(ProviderAdapter):
    kind = "gemini"
    capabilities = Capabilities(
        supports_system_prompt=True,
        supports_json_mode=True,
        supports_tools=False,
        supports_streaming=True,
        supports_cancellation=True,
        max_context_tokens=1_000_000,
        model_discovery=True,
    )

    def _key_params(self) -> dict[str, str]:
        return {"key": self.api_key} if self.api_key else {}

    def headers(self) -> dict[str, str]:
        merged = {"content-type": "application/json", **self.extra_headers}
        if self.api_key:
            merged["x-goog-api-key"] = self.api_key
        return merged

    async def test(self) -> tuple[bool, str, float]:
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout, 20)) as client:
                response = await client.get(
                    f"{self.base_url}/{API_VERSION}/models",
                    params=self._key_params(),
                    headers=self.headers(),
                )
            latency = (time.perf_counter() - started) * 1000
            raise_for_status(response, kind=self.kind)
            data = response.json()
            rows = data.get("models", []) if isinstance(data, dict) else []
            return True, f"reachable — {len(rows)} model(s) discovered in {latency:.0f} ms", latency
        except Exception as exc:
            latency = (time.perf_counter() - started) * 1000
            return False, map_transport_error(exc, kind=self.kind).message, latency

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=min(self.timeout, 20)) as client:
            response = await client.get(
                f"{self.base_url}/{API_VERSION}/models", params=self._key_params(), headers=self.headers()
            )
        raise_for_status(response, kind=self.kind)
        data = response.json()
        rows = data.get("models", []) if isinstance(data, dict) else []
        names = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name", ""))
            actions = row.get("supportedGenerationMethods") or []
            if actions and "generateContent" not in actions:
                continue
            names.append(name.split("/")[-1])
        return sorted(set(names))

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
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
                "responseMimeType": "text/plain",
            },
        }
        url = f"{self.base_url}/{API_VERSION}/models/{chosen}:generateContent"
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
                response = await client.post(
                    url, params=self._key_params(), json=payload, headers=self.headers()
                )
            raise_for_status(response, kind=self.kind)
            data = response.json()
        except Exception as exc:
            raise map_transport_error(exc, kind=self.kind) from exc

        latency = (time.perf_counter() - started) * 1000
        candidates = data.get("candidates") or []
        text = ""
        finish = None
        if candidates:
            parts = (candidates[0].get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
            finish = candidates[0].get("finishReason")
        usage = data.get("usageMetadata") or {}
        return CompletionResult(
            text=text,
            model=chosen,
            tokens_in=int(usage.get("promptTokenCount") or 0),
            tokens_out=int(usage.get("candidatesTokenCount") or 0),
            latency_ms=round(latency, 2),
            finish_reason=finish,
            raw=data,
            provider_id=self.provider_id,
            provider_kind=self.kind,
        )
