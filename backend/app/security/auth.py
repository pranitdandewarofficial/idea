"""Local-first authentication.

The API is protected by a single bearer token (generated on first launch and
stored in ``.data/api_token`` with mode 0600).  The token may be supplied as an
``Authorization: Bearer`` header or as a ``token`` query parameter, which is how
the browser ``WebSocket`` handshake authenticates.
"""

from __future__ import annotations

import hmac

from fastapi import Request

from ..api.errors import ApiError
from ..config import settings


def current_token() -> str:
    return settings.ensure_api_token()


def token_matches(candidate: str | None) -> bool:
    if not candidate:
        return False
    return hmac.compare_digest(candidate.strip(), current_token())


def extract_token(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.query_params.get("token")


async def require_auth(request: Request) -> str:
    """FastAPI dependency guarding every non-public route."""
    if not settings.auth_enabled:
        return "auth-disabled"
    token = extract_token(request)
    if not token_matches(token):
        raise ApiError(
            code="unauthorized",
            message="Missing or invalid API token. Copy the token printed by the backend "
            "(or .data/api_token) into the frontend Settings screen.",
            status=401,
        )
    return "bearer"


def ws_token_ok(token: str | None) -> bool:
    if not settings.auth_enabled:
        return True
    return token_matches(token)
