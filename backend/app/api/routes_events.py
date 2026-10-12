"""Activity stream: REST history, Server-Sent Events and the WebSocket bus."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from ..db import session_scope
from ..events import bus
from ..models import Event
from ..security.auth import require_auth, ws_token_ok

router = APIRouter(tags=["events"])
protected = APIRouter(tags=["events"], dependencies=[Depends(require_auth)])


@protected.get("/api/events")
def list_events(
    kind: str | None = None,
    agent: str | None = None,
    plan: str | None = None,
    project: str | None = None,
    since: int = 0,
    priority: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    limit = max(1, min(limit, 1000))
    with session_scope() as s:
        query = s.query(Event).filter(Event.id > since)
        if kind:
            query = query.filter(Event.kind.in_([k.strip() for k in kind.split(",") if k.strip()]))
        if priority:
            query = query.filter(Event.priority == priority)
        rows = query.order_by(Event.id.desc()).limit(5000).all()

    items = []
    for row in reversed(rows):
        payload = row.payload or {}
        if agent and payload.get("agent_id") != agent:
            continue
        if plan and payload.get("plan_id") != plan:
            continue
        if project and payload.get("project_id") != project:
            continue
        items.append(
            {
                "id": row.id,
                "kind": row.kind,
                "payload": payload,
                "priority": row.priority,
                "notify": row.notify,
                "ts": row.created_at.isoformat() if row.created_at else None,
            }
        )
        if len(items) >= limit:
            break
    return {"items": items, "count": len(items), "last_id": bus.last_id()}


@protected.get("/api/events/kinds")
def event_kinds() -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(Event.kind).distinct().all()
    return {"items": sorted({r[0] for r in rows})}


@protected.get("/api/events/export")
def export_events(limit: int = 5000) -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(Event).order_by(Event.id.desc()).limit(limit).all()
    return {
        "items": [
            {"id": r.id, "kind": r.kind, "payload": r.payload, "priority": r.priority,
             "ts": r.created_at.isoformat() if r.created_at else None}
            for r in reversed(rows)
        ]
    }


@protected.get("/api/events/stream")
async def event_stream(since: int = Query(default=0)) -> StreamingResponse:
    """Server-Sent Events alternative to the WebSocket."""
    queue = bus.subscribe()

    async def generator():
        try:
            for item in bus.since(since):
                yield f"id: {item['id']}\nevent: {item['kind']}\ndata: {json.dumps(item)}\n\n"
            yield ": connected\n\n"
            while True:
                item = await queue.get()
                yield f"id: {item['id']}\nevent: {item['kind']}\ndata: {json.dumps(item)}\n\n"
        except asyncio.CancelledError:  # pragma: no cover - client disconnect
            raise
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(generator(), media_type="text/event-stream",
                             headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if not ws_token_ok(token):
        await websocket.close(code=4401, reason="invalid or missing token")
        return
    await websocket.accept()
    queue = bus.subscribe()
    last_id = int(websocket.query_params.get("since") or 0)

    async def sender() -> None:
        try:
            if last_id:
                for item in bus.since(last_id):
                    await websocket.send_text(json.dumps(item))
            await websocket.send_text(json.dumps({"kind": "ws.connected",
                                                  "payload": {"last_id": bus.last_id()},
                                                  "ts": None, "id": 0, "priority": "low",
                                                  "notify": False}))
            while True:
                item = await queue.get()
                await websocket.send_text(json.dumps(item))
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            return

    task = asyncio.create_task(sender())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"kind": "ws.error",
                                                      "payload": {"message": "invalid JSON"}, "id": 0}))
                continue
            kind = message.get("type")
            if kind == "ping":
                await websocket.send_text(json.dumps({"kind": "ws.pong", "payload": {}, "id": 0}))
            elif kind == "replay":
                since_id = int(message.get("since") or 0)
                for item in bus.since(since_id):
                    await websocket.send_text(json.dumps(item))
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        bus.unsubscribe(queue)


router.include_router(protected)
