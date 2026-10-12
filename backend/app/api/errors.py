"""Uniform error envelope.

Every error response has the same shape::

    {"error": {"code", "message", "context", "request_id"}}

Codes are machine-readable strings; messages never contain secrets.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status: int = 400,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.context = context or {}


def envelope(code: str, message: str, context: dict[str, Any] | None, request_id: str) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "context": context or {},
            "request_id": request_id,
        }
    }


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", None) or uuid.uuid4().hex[:12]


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=envelope(exc.code, exc.message, exc.context, _request_id(request)),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=envelope(
                "validation_error",
                "Request body did not match the expected schema.",
                {"issues": [{"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()][:20]},
                _request_id(request),
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict"}.get(
            exc.status_code, "http_error"
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=envelope(code, str(exc.detail), None, _request_id(request)),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        from ..security.redact import redact_text

        return JSONResponse(
            status_code=500,
            content=envelope(
                "internal_error",
                redact_text(f"{type(exc).__name__}: {exc}"),
                None,
                _request_id(request),
            ),
        )
