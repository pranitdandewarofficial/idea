"""PRANIT AI CITY — FastAPI application entry point."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import (
    routes_agents,
    routes_audit,
    routes_city,
    routes_decisions,
    routes_events,
    routes_health,
    routes_knowledge,
    routes_plans,
    routes_projects,
    routes_providers,
    routes_settings,
)
from .api.errors import install_error_handlers
from .config import settings
from .db import init_db
from .decisions import presets
from .decisions.laya_adapter import laya
from .decisions.router import router as decision_router
from .decisions.service import service as decisions
from .events import bus, set_triage_hook
from .orchestrator import checkpoints
from .orchestrator.orchestrator import orchestrator
from .providers.registry import providers
from .security.auth import current_token
from .tools.servers import servers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("pranit")


async def _triage_hook(kind: str, payload: dict, priority: str, notify: bool) -> tuple[str, bool]:
    """System-1 override for high-stakes event triage."""
    result = await decisions.decide(presets.event_triage(kind, payload))
    if result.action != "auto" or not result.answers:
        return priority, notify
    new_priority = str(result.value("priority", priority))
    new_notify = bool(result.value("requires_notification", notify))
    if new_priority not in ("critical", "high", "normal", "low"):
        new_priority = priority
    return new_priority, new_notify


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    settings.ensure_secret_key()
    init_db()
    bus.bind_loop(asyncio.get_running_loop())
    set_triage_hook(_triage_hook)
    orchestrator.wire()
    await orchestrator.ensure_agents()

    token = current_token() if settings.auth_enabled else None
    log.info("PRANIT AI CITY backend starting on %s:%s", settings.host, settings.port)
    if token:
        log.info("API token (put this in the frontend Settings screen): %s", token)
    log.info("Workspaces: %s", settings.workspaces_dir)
    log.info("Zero-spend mode: %s", "ON" if providers.zero_spend_active() else "OFF")

    restored = await checkpoints.restore_interrupted()
    if restored["tasks_reset"] or restored["plans_paused"]:
        log.info("Recovered from an unclean shutdown: %s", restored)

    warmup = asyncio.create_task(_warm_decision_layer())
    app.state.decision_warmup = warmup

    try:
        yield
    finally:
        warmup.cancel()
        await servers.stop_all()
        for handle in list(orchestrator.runs.values()):
            handle.cancel_event.set()
            if handle.task is not None:
                handle.task.cancel()
        log.info("PRANIT AI CITY backend stopped")


async def _warm_decision_layer() -> None:
    try:
        status = await laya.warmup()
        if status.available:
            log.info("System-1 decision engine ready: %s (%s)", status.mode, status.reason)
        else:
            log.info("System-1 decision engine: %s", status.reason)
        decision_router.register_llm_fallback  # noqa: B018 - attribute exists check
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("decision layer warmup failed: %s", exc)


app = FastAPI(
    title="PRANIT AI CITY",
    version="1.0.0",
    description=(
        "Local-first autonomous AI company: one orchestrator, specialised agents, real tools, "
        "a System-1 decision layer and a 2D city that reflects actual backend state."
    ),
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-Id"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    response.headers["X-Duration-Ms"] = f"{(time.perf_counter() - started) * 1000:.1f}"
    return response


install_error_handlers(app)

for module in (
    routes_health,
    routes_city,
    routes_agents,
    routes_plans,
    routes_projects,
    routes_providers,
    routes_knowledge,
    routes_decisions,
    routes_settings,
    routes_audit,
    routes_events,
):
    app.include_router(module.router)


@app.get("/", include_in_schema=False)
def root() -> JSONResponse:
    return JSONResponse(
        {
            "name": "PRANIT AI CITY",
            "version": "1.0.0",
            "docs": "/api/docs",
            "health": "/api/health",
            "events": "/api/events",
            "websocket": "/ws",
            "zero_spend": providers.zero_spend_active(),
            "decision_engine": laya.status.mode if laya.status.available else "local",
        }
    )
