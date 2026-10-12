"""Secret redaction.

Applied to tool-call arguments, error messages, event payloads and log lines
before they are persisted or broadcast.  Redaction is deliberately aggressive:
a false positive costs readability, a false negative leaks a credential.
"""

from __future__ import annotations

import re
from typing import Any

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-[A-Za-z0-9_\-]{12,}"), "[REDACTED_KEY]"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{12,}"), "[REDACTED_KEY]"),
    (re.compile(r"sk-or-v1-[A-Za-z0-9_\-]{12,}"), "[REDACTED_KEY]"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{20,}"), "[REDACTED_KEY]"),
    (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "[REDACTED_KEY]"),
    (re.compile(r"gho_[A-Za-z0-9]{20,}"), "[REDACTED_KEY]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "[REDACTED_KEY]"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"), "[REDACTED_KEY]"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED_KEY]"),
    (re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}"), "[REDACTED_JWT]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED_PEM]"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{10,}"), "Bearer [REDACTED]"),
    (
        re.compile(
            r"(?i)\b(api[_-]?key|apikey|secret|token|password|passwd|authorization|access[_-]?key)\b"
            r"(\s*[:=]\s*)(['\"]?)([^\s'\",;]{6,})(\3)"
        ),
        r"\1\2\3[REDACTED]\3",
    ),
]

SENSITIVE_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "api_key_enc",
        "secret",
        "secret_key",
        "password",
        "token",
        "access_token",
        "authorization",
        "key",
    }
)


def redact_text(text: str) -> str:
    if not text:
        return text
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def redact_value(value: Any, *, _depth: int = 0) -> Any:
    """Recursively redact a JSON-ish structure."""
    if _depth > 12:
        return "[TRUNCATED]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {
            k: ("[REDACTED]" if str(k).lower() in SENSITIVE_KEYS and v else redact_value(v, _depth=_depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_value(v, _depth=_depth + 1) for v in value]
    return value


def contains_secret(text: str) -> bool:
    """Cheap heuristic used by the guardrail layer."""
    if not text:
        return False
    for pattern, _ in _PATTERNS:
        if pattern.search(text):
            return True
    return False


def truncate(text: str, limit: int = 4000) -> str:
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - 20] + f"\n…[truncated {len(text) - limit + 20} chars]"
