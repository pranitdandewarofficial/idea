"""AI provider configuration: CRUD, real connectivity tests, model discovery, usage."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..api.errors import ApiError
from ..db import session_scope
from ..events import bus
from ..models import AuditRecord, Provider
from ..providers.base import ProviderError
from ..providers.registry import ADAPTERS, DEFAULT_BASE_URLS, providers
from ..schemas import ProviderIn, ProviderOut, ProviderPatch
from ..security.auth import require_auth
from ..security.crypto import decrypt, encrypt, fingerprint

router = APIRouter(prefix="/api/providers", tags=["providers"], dependencies=[Depends(require_auth)])


def _out(row: Provider) -> dict[str, Any]:
    data = ProviderOut.model_validate(row).model_dump()
    data["has_key"] = bool(row.api_key_enc)
    key = ""
    if row.api_key_enc:
        try:
            key = decrypt(row.api_key_enc)
        except ValueError:
            key = ""
    data["key_fingerprint"] = fingerprint(key)
    return data


@router.get("/kinds")
def provider_kinds() -> dict[str, Any]:
    return {
        "items": [
            {"kind": kind, "default_base_url": DEFAULT_BASE_URLS.get(kind, ""),
             "requires_key": kind not in ("ollama", "mock"),
             "is_paid_by_default": kind not in ("ollama", "mock", "lmstudio", "vllm")}
            for kind in sorted(ADAPTERS)
        ]
    }


@router.get("")
def list_providers() -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(Provider).order_by(Provider.created_at).all()
        items = [_out(row) for row in rows]
    for item in items:
        item["usage"] = providers.usage_summary(item["id"])
    return {"items": items, "count": len(items), "zero_spend": providers.zero_spend_active()}


@router.post("")
def add_provider(body: ProviderIn) -> dict[str, Any]:
    base_url = body.base_url.strip() or DEFAULT_BASE_URLS.get(body.kind, "")
    if body.kind != "mock" and not base_url:
        raise ApiError("invalid_base_url", "A base URL is required for this provider kind.", status=422)
    if body.kind not in ("ollama", "mock") and not body.api_key:
        raise ApiError(
            "missing_api_key",
            f"{body.kind} requires an API key. It is encrypted at rest and never returned by the API.",
            status=422,
        )
    with session_scope() as s:
        row = Provider(
            label=body.label.strip(),
            kind=body.kind,
            base_url=base_url,
            api_key_enc=encrypt(body.api_key) if body.api_key else None,
            organization_id=body.organization_id,
            default_model=body.default_model,
            fallback_model=body.fallback_model,
            is_paid=body.is_paid,
            is_enabled=body.is_enabled,
            requests_per_minute=body.requests_per_minute,
            max_concurrent=body.max_concurrent,
            timeout_seconds=body.timeout_seconds,
            max_retries=body.max_retries,
            extra_headers=body.extra_headers,
            role_models=body.role_models,
        )
        s.add(row)
        s.flush()
        s.add(AuditRecord(actor="founder", action="provider.created", target=row.id, result="ok",
                          context={"kind": row.kind, "label": row.label, "is_paid": row.is_paid}))
        data = _out(row)
    providers.invalidate(data["id"])
    return data


@router.patch("/{provider_id}")
def patch_provider(provider_id: str, body: ProviderPatch) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(Provider, provider_id)
        if row is None:
            raise ApiError("not_found", f"Provider '{provider_id}' does not exist.", status=404)
        updates = body.model_dump(exclude_unset=True)
        if "api_key" in updates:
            key = updates.pop("api_key")
            if key:
                row.api_key_enc = encrypt(key)
            else:
                row.api_key_enc = None
            s.add(AuditRecord(actor="founder", action="provider.key_changed", target=provider_id,
                              result="ok", context={"cleared": not bool(key)}))
        for key, value in updates.items():
            if value is not None:
                setattr(row, key, value)
        row.last_test_ok = None
        row.last_test_message = "Configuration changed; re-run the connectivity test."
        s.flush()
        data = _out(row)
    providers.invalidate(provider_id)
    return data


@router.delete("/{provider_id}")
def delete_provider(provider_id: str) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(Provider, provider_id)
        if row is None:
            raise ApiError("not_found", f"Provider '{provider_id}' does not exist.", status=404)
        s.delete(row)
        s.add(AuditRecord(actor="founder", action="provider.deleted", target=provider_id, result="ok"))
    providers.invalidate(provider_id)
    return {"deleted": True, "provider_id": provider_id}


@router.post("/{provider_id}/test")
async def test_provider(provider_id: str) -> dict[str, Any]:
    with session_scope() as s:
        if s.get(Provider, provider_id) is None:
            raise ApiError("not_found", f"Provider '{provider_id}' does not exist.", status=404)
    providers.invalidate(provider_id)
    result = await providers.test(provider_id)
    await bus.emit(
        "provider.test_succeeded" if result["ok"] else "provider.test_failed",
        provider_id=provider_id,
        message=result["message"],
        latency_ms=result["latency_ms"],
        provider_kind=result["kind"],
        mocked=result.get("mocked", False),
    )
    # 200 with ok=false: the test ran and reported a real failure.  That is a
    # result, not an HTTP error.
    return result


@router.get("/{provider_id}/models")
async def provider_models(provider_id: str, refresh: bool = True) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(Provider, provider_id)
        if row is None:
            raise ApiError("not_found", f"Provider '{provider_id}' does not exist.", status=404)
        cached = list(row.models_discovered or [])
    if not refresh and cached:
        return {"items": cached, "source": "cache", "count": len(cached)}
    try:
        providers.invalidate(provider_id)
        models = await providers.list_models(provider_id)
    except ProviderError as exc:
        raise ApiError(exc.code, exc.message, status=502, context={"provider_id": provider_id})
    return {"items": models, "source": "live", "count": len(models)}


@router.get("/{provider_id}/usage")
def provider_usage(provider_id: str) -> dict[str, Any]:
    with session_scope() as s:
        if s.get(Provider, provider_id) is None:
            raise ApiError("not_found", f"Provider '{provider_id}' does not exist.", status=404)
    return providers.usage_summary(provider_id)


@router.get("/usage/global")
def global_usage() -> dict[str, Any]:
    return providers.global_usage()
