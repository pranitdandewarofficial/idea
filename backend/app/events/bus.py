"""The event bus.

Single source of real-time truth.  Events are **persisted before they are
broadcast**, so a client that reconnects can replay everything it missed via
``GET /api/events?since=<id>``.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..db import session_scope
from ..models import Event
from ..security.redact import redact_value
from . import triage

log = logging.getLogger("pranit.events")

TriageHook = Callable[[str, dict, str, bool], Awaitable[tuple[str, bool]]]


class EventBus:
    def __init__(self, buffer_size: int = 1000, queue_size: int = 500) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._buffer: deque[dict] = deque(maxlen=buffer_size)
        self._queue_size = queue_size
        self._triage_hook: TriageHook | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- wiring ------------------------------------------------------------- #
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def set_triage_hook(self, hook: TriageHook | None) -> None:
        self._triage_hook = hook

    # -- subscription ------------------------------------------------------- #
    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    # -- emission ----------------------------------------------------------- #
    async def emit(self, kind: str, /, **payload: Any) -> dict:
        safe_payload = redact_value(payload)
        priority, notify = triage.classify(kind, safe_payload)

        if self._triage_hook is not None and kind in triage.TRIAGE_DECISION_KINDS:
            try:
                priority, notify = await self._triage_hook(kind, safe_payload, priority, notify)
            except Exception as exc:  # never let triage break the run
                log.warning("triage hook failed for %s: %s", kind, exc)

        message = self._persist(kind, safe_payload, priority, notify)
        self._broadcast(message)
        return message

    def emit_threadsafe(self, kind: str, /, **payload: Any) -> None:
        """Emit from a non-async context (best effort)."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        asyncio.run_coroutine_threadsafe(self.emit(kind, **payload), loop)

    def _persist(self, kind: str, payload: dict, priority: str, notify: bool) -> dict:
        with session_scope() as s:
            row = Event(kind=kind, payload=payload, priority=priority, notify=notify)
            s.add(row)
            s.flush()
            event_id = row.id
            created_at = row.created_at
        ts = (created_at or datetime.now(timezone.utc).replace(tzinfo=None)).isoformat()
        message = {"id": event_id, "kind": kind, "payload": payload, "priority": priority,
                   "notify": notify, "ts": ts}
        self._buffer.append(message)
        return message

    def _broadcast(self, message: dict) -> None:
        slow: list[asyncio.Queue] = []
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                slow.append(queue)
                try:
                    queue.get_nowait()
                    queue.put_nowait(message)
                except Exception:  # pragma: no cover - defensive
                    pass
        if slow:
            log.warning("slow event consumer(s): dropped oldest events for %d client(s)", len(slow))

    # -- replay ------------------------------------------------------------- #
    def recent(self, limit: int = 100) -> list[dict]:
        return list(self._buffer)[-limit:]

    def since(self, last_id: int, limit: int = 500) -> list[dict]:
        with session_scope() as s:
            rows = (
                s.query(Event)
                .filter(Event.id > last_id)
                .order_by(Event.id.asc())
                .limit(limit)
                .all()
            )
            return [
                {
                    "id": r.id,
                    "kind": r.kind,
                    "payload": r.payload,
                    "priority": r.priority,
                    "notify": r.notify,
                    "ts": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ]

    def last_id(self) -> int:
        with session_scope() as s:
            row = s.query(Event.id).order_by(Event.id.desc()).first()
            return int(row[0]) if row else 0


bus = EventBus()


def set_triage_hook(hook: TriageHook | None) -> None:
    bus.set_triage_hook(hook)
