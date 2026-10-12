"""Shared HTTP error mapping for provider adapters."""

from __future__ import annotations

from typing import Any

import httpx

from .base import (
    ModelNotFoundError,
    ProviderAuthError,
    ProviderError,
    ProviderNotFoundError,
    ProviderRateLimitError,
    ProviderServerError,
    ProviderTimeoutError,
)


def _snippet(response: httpx.Response, limit: int = 600) -> str:
    try:
        body = response.text
    except Exception:  # pragma: no cover - defensive
        return "<unreadable response body>"
    return body[:limit]


def _detail(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict):
                return {"message": err.get("message"), "type": err.get("type"), "code": err.get("code")}
            if isinstance(err, str):
                return {"message": err}
    except Exception:
        pass
    return {"body": _snippet(response)}


def raise_for_status(response: httpx.Response, *, kind: str) -> None:
    if response.status_code < 400:
        return
    detail = _detail(response)
    message = detail.get("message") or detail.get("body") or response.reason_phrase or "request failed"
    code = response.status_code

    if code in (401, 403):
        raise ProviderAuthError(
            f"{kind} rejected the credential (HTTP {code}): {message}", detail=detail
        )
    if code == 404:
        if "model" in str(message).lower():
            raise ModelNotFoundError(f"{kind}: {message}", detail=detail)
        raise ProviderNotFoundError(f"{kind}: endpoint not found (HTTP 404): {message}", detail=detail)
    if code == 429:
        raise ProviderRateLimitError(f"{kind} rate limit reached (HTTP 429): {message}", detail=detail)
    if 500 <= code < 600:
        raise ProviderServerError(f"{kind} server error (HTTP {code}): {message}", detail=detail)
    raise ProviderError(f"{kind} request failed (HTTP {code}): {message}", detail=detail)


def map_transport_error(exc: Exception, *, kind: str) -> ProviderError:
    if isinstance(exc, httpx.TimeoutException):
        return ProviderTimeoutError(f"{kind} request timed out: {exc}")
    if isinstance(exc, httpx.ConnectError):
        return ProviderError(
            f"Could not reach {kind} at the configured base URL. Is the service running and is the URL "
            f"correct? ({exc})"
        )
    if isinstance(exc, ProviderError):
        return exc
    return ProviderError(f"{kind} request failed: {type(exc).__name__}: {exc}")
