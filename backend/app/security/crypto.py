"""At-rest encryption for provider API keys.

The Fernet key is derived from ``PRANIT_SECRET_KEY`` (or a generated key file in
``.data/``).  Plaintext keys are decrypted only inside the provider adapter and
are never returned by the API, written to logs, or included in events.
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        digest = hashlib.sha256(settings.ensure_secret_key().encode("utf-8")).digest()
        _fernet = Fernet(base64.urlsafe_b64encode(digest))
    return _fernet


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    return _get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        return _get_fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:  # pragma: no cover - depends on key rotation
        raise ValueError(
            "Stored credential could not be decrypted. PRANIT_SECRET_KEY changed since it "
            "was saved - re-enter the provider API key."
        ) from exc


def fingerprint(plaintext: str) -> str:
    """Short, non-reversible hint used for UI display (never the key itself)."""
    if not plaintext:
        return ""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()[:8]
