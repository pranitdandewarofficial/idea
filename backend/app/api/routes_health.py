"""Health, setup status and runtime facts."""

from __future__ import annotations

import platform
import sys
from typing import Any

from fastapi import APIRouter

from ..config import settings
from ..db import session_scope
from ..decisions.laya_adapter import laya
from ..decisions.service import service as decisions
from ..models import Agent, Plan, Project, Provider
from ..orchestrator.orchestrator import orchestrator
from ..providers.registry import providers
from ..security.auth import current_token
from ..tools.shell import docker_available

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health() -> dict[str, Any]:
    with session_scope() as s:
        counts = {
            "providers": s.query(Provider).count(),
            "agents": s.query(Agent).count(),
            "projects": s.query(Project).count(),
            "plans": s.query(Plan).count(),
        }
    return {
        "ok": True,
        "version": "1.0.0",
        "zero_spend": providers.zero_spend_active(),
        "auth_enabled": settings.auth_enabled,
        "sandbox_tier": int(settings.sandbox_tier),
        "docker_available": docker_available(),
        "decisions_enabled": decisions.enabled,
        "decision_engine": laya.status.mode if laya.status.available else "local",
        "counts": counts,
        "runs": orchestrator.status(),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
    }


@router.get("/setup/status")
def setup_status() -> dict[str, Any]:
    """Everything the first-run wizard needs, including the local API token."""
    with session_scope() as s:
        provider_rows = s.query(Provider).all()
        has_provider = len(provider_rows) > 0
        has_free = any(not p.is_paid and p.is_enabled for p in provider_rows)
        providers_out = [
            {
                "id": p.id,
                "label": p.label,
                "kind": p.kind,
                "is_paid": p.is_paid,
                "is_enabled": p.is_enabled,
                "default_model": p.default_model,
                "last_test_ok": p.last_test_ok,
                "last_test_message": p.last_test_message,
            }
            for p in provider_rows
        ]
    return {
        "complete": has_provider,
        "has_provider": has_provider,
        "has_free_provider": has_free,
        "providers": providers_out,
        "zero_spend": providers.zero_spend_active(),
        "api_token": current_token() if settings.auth_enabled else None,
        "api_base": f"http://{settings.host}:{settings.port}",
        "workspaces_dir": str(settings.workspaces_dir),
        "decision_layer": {
            "enabled": decisions.enabled,
            "engine": laya.status.mode if laya.status.available else "local",
            "laya_available": laya.status.available,
            "laya_reason": laya.status.reason,
            "threshold": decisions.threshold,
        },
        "sandbox": {"tier": int(settings.sandbox_tier), "docker_available": docker_available()},
    }
