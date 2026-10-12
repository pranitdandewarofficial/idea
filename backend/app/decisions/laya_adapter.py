"""Laya runtime adapter (Convai Innovations' non-autoregressive decision model).

Three deployment modes are supported:

``laya``        local PyTorch runtime (``pip install laya``)
``laya_mnn``    local MNN runtime (``pip install laya-mnn``) - no GPU, no API key
``laya_hosted`` HTTP endpoint configured via ``PRANIT_LAYA_BASE_URL``

The adapter is deliberately defensive: Laya ships large weights that are fetched
from a model hub on first use, which may be unavailable in a locked-down
environment.  When the runtime cannot be loaded the adapter reports
``available=False`` with the **exact** reason, and :mod:`app.decisions.router`
falls back to the deterministic local engine.  Nothing here ever pretends a
decision came from Laya when it did not.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..config import settings
from .schemas import Answer, Question

log = logging.getLogger("pranit.decisions.laya")


class LayaUnavailable(RuntimeError):
    pass


@dataclass
class LayaStatus:
    mode: str = "unavailable"
    available: bool = False
    reason: str = "not detected"
    version: str | None = None
    latency_ms: float | None = None
    checked_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "available": self.available,
            "reason": self.reason,
            "version": self.version,
            "latency_ms": self.latency_ms,
            "checked_at": self.checked_at,
        }


def _module_present(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


class LayaAdapter:
    """Loads (lazily) and invokes a Laya runtime."""

    def __init__(self) -> None:
        self._runtime: Any = None
        self._status: LayaStatus = LayaStatus()
        self._lock = asyncio.Lock()

    # -- detection ---------------------------------------------------------- #
    def detect(self, force: bool = False) -> LayaStatus:
        if self._status.available and not force:
            return self._status
        mode = (settings.decision_mode or "auto").lower()

        if mode == "laya_hosted" or (mode == "auto" and settings.laya_base_url):
            if settings.laya_base_url:
                self._status = LayaStatus(mode="laya_hosted", available=True,
                                          reason=f"hosted endpoint {settings.laya_base_url}")
                return self._status
            self._status = LayaStatus(mode="laya_hosted", available=False,
                                      reason="PRANIT_LAYA_BASE_URL is not set")
            return self._status

        candidates = ["laya_mnn", "laya"]
        if mode in ("laya", "laya_mnn"):
            candidates = [mode]
        elif mode == "local":
            self._status = LayaStatus(mode="local", available=False,
                                      reason="decision mode forced to local engine")
            return self._status

        for name in candidates:
            if not _module_present(name):
                continue
            try:
                module = importlib.import_module(name)
                self._status = LayaStatus(
                    mode=name,
                    available=True,
                    reason=f"python package '{name}' importable",
                    version=str(getattr(module, "__version__", "unknown")),
                )
                return self._status
            except Exception as exc:  # pragma: no cover - environment specific
                self._status = LayaStatus(mode=name, available=False,
                                          reason=f"import '{name}' failed: {type(exc).__name__}: {exc}")
                return self._status

        self._status = LayaStatus(
            mode="local",
            available=False,
            reason="Laya runtime not installed (pip install laya-mnn) and no hosted endpoint configured; "
                   "using the deterministic local decision engine",
        )
        return self._status

    @property
    def status(self) -> LayaStatus:
        return self._status

    # -- warmup ------------------------------------------------------------- #
    async def warmup(self) -> LayaStatus:
        status = self.detect(force=True)
        if not status.available or status.mode == "laya_hosted":
            return status
        started = time.perf_counter()
        try:
            await self.predict(
                {"text": "warmup: is this a warmup?"},
                {"warm": Question(id="warm", type="noul", instructions="Is this a warmup call?")},
            )
            status.latency_ms = round((time.perf_counter() - started) * 1000, 2)
        except Exception as exc:
            status.available = False
            status.reason = f"warmup failed: {type(exc).__name__}: {exc}"
            log.warning("Laya warmup failed: %s", status.reason)
        return status

    async def health(self) -> bool:
        return self.detect().available

    # -- inference ---------------------------------------------------------- #
    async def predict(self, state: dict[str, Any] | str, questions: dict[str, Question]) -> dict[str, Answer]:
        status = self.detect()
        if not status.available:
            raise LayaUnavailable(status.reason)
        if status.mode == "laya_hosted":
            return await self._predict_hosted(state, questions)
        async with self._lock:
            return await asyncio.to_thread(self._predict_local, state, questions)

    def _predict_local(self, state: dict[str, Any] | str, questions: dict[str, Question]) -> dict[str, Answer]:
        from .schemas import state_to_text  # local import keeps module import cheap

        text = state if isinstance(state, str) else state_to_text(state)
        runtime = self._load_runtime()
        payload = {
            qid: {
                "type": q.type,
                "instructions": q.instructions,
                "criteria": q.criteria,
            }
            for qid, q in questions.items()
        }
        raw = self._call_runtime(runtime, text, payload)
        return _normalise(raw, questions)

    def _load_runtime(self) -> Any:
        if self._runtime is not None:
            return self._runtime
        status = self.detect()
        module = importlib.import_module(status.mode)
        # Laya exposes a small surface; resolve whatever entry point exists.
        for factory in ("Laya", "LayaModel", "DecisionModel", "load", "from_pretrained", "load_model"):
            candidate = getattr(module, factory, None)
            if candidate is None:
                continue
            try:
                self._runtime = candidate(settings.laya_model) if callable(candidate) and factory != "Laya" \
                    else candidate()
                return self._runtime
            except TypeError:
                try:
                    self._runtime = candidate()
                    return self._runtime
                except Exception:
                    continue
            except Exception as exc:  # pragma: no cover - environment specific
                raise LayaUnavailable(f"could not construct Laya runtime: {exc}") from exc
        raise LayaUnavailable(
            f"package '{status.mode}' is installed but exposes no recognisable entry point "
            "(expected one of Laya/LayaModel/DecisionModel/load/from_pretrained/load_model)"
        )

    def _call_runtime(self, runtime: Any, text: str, payload: dict[str, Any]) -> Any:
        for method in ("decide", "predict", "answer", "__call__", "run"):
            fn = getattr(runtime, method, None)
            if fn is None and method != "__call__":
                continue
            if fn is None:
                continue
            try:
                return fn(text, payload)
            except TypeError:
                try:
                    return fn({"state": text, "questions": payload})
                except Exception:
                    continue
            except Exception:
                continue
        raise LayaUnavailable("Laya runtime exposes no callable decide/predict/answer method")

    async def _predict_hosted(self, state: dict[str, Any] | str,
                              questions: dict[str, Question]) -> dict[str, Answer]:
        payload = {
            "model": settings.laya_model,
            "state": state,
            "questions": {qid: q.model_dump(exclude_none=True) for qid, q in questions.items()},
        }
        headers = {"content-type": "application/json"}
        if settings.laya_api_key:
            headers["authorization"] = f"Bearer {settings.laya_api_key}"
        url = settings.laya_base_url.rstrip("/") + "/decisions"
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return _normalise(response.json(), questions)


def _normalise(raw: Any, questions: dict[str, Question]) -> dict[str, Answer]:
    """Map a Laya response (dict of answers) onto our ``Answer`` schema."""
    if isinstance(raw, str):
        raw = json.loads(raw)
    data = raw.get("answers", raw) if isinstance(raw, dict) else {}
    out: dict[str, Answer] = {}
    for qid, question in questions.items():
        item = data.get(qid) if isinstance(data, dict) else None
        if item is None:
            raise LayaUnavailable(f"Laya response missing answer for '{qid}'")
        if not isinstance(item, dict):
            item = {"value": item}
        value = item.get("value", item.get("answer", item.get("label")))
        prob = float(item.get("probability", item.get("p_true", item.get("confidence", 0.0))) or 0.0)
        probs = item.get("probabilities")
        conf = float(item.get("confidence", prob) or prob)
        if question.type == "noul":
            value = bool(value) if not isinstance(value, (int, float)) else bool(value >= 0.5)
        out[qid] = Answer(
            question_id=qid,
            type=question.type,
            value=value,
            probability=round(prob, 4),
            probabilities=probs,
            confidence=round(min(max(conf, 0.0), 1.0), 4),
        )
    return out


laya = LayaAdapter()
