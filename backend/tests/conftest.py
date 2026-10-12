"""Test fixtures.

Environment variables are set **before** any application module is imported so
the cached ``Settings`` object points at a throw-away data directory.  Nothing
here touches the developer's real database or workspaces.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

TEST_ROOT = Path(tempfile.mkdtemp(prefix="pranit-test-"))

os.environ.update(
    {
        "PRANIT_DATA_DIR": str(TEST_ROOT / "data"),
        "PRANIT_WORKSPACES_DIR": str(TEST_ROOT / "workspaces"),
        "PRANIT_DB_URL": f"sqlite:///{(TEST_ROOT / 'data' / 'test.db').as_posix()}",
        "PRANIT_SECRET_KEY": "test-secret-key-that-is-long-enough-to-be-safe-0000000000",
        "PRANIT_AUTH_ENABLED": "true",
        "PRANIT_ZERO_SPEND": "true",
        "PRANIT_MAX_CONCURRENCY": "2",
        "PRANIT_MAX_TASKS_PER_AGENT": "1",
        "PRANIT_AGENT_TOOL_ROUNDS": "5",
        "PRANIT_SHELL_TIMEOUT_SECONDS": "60",
        "PRANIT_TASK_TIMEOUT_SECONDS": "120",
        "PRANIT_APPROVAL_TIMEOUT_SECONDS": "3",
        "PRANIT_DECISION_MODE": "local",
        "PRANIT_SANDBOX_TIER": "1",
        "PRANIT_CORS_ORIGINS": '["http://localhost:5173"]',
    }
)

(TEST_ROOT / "data").mkdir(parents=True, exist_ok=True)
(TEST_ROOT / "workspaces").mkdir(parents=True, exist_ok=True)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.security.auth import current_token  # noqa: E402


@pytest.fixture(scope="session")
def client():
    init_db()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session", autouse=True)
def _bootstrap(client):
    """The app lifespan (db init, agent seeding, event bus) runs for every test."""
    yield client


@pytest.fixture(scope="session")
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {current_token()}"}


@pytest.fixture()
def authed(client, auth_headers):
    client.headers.update(auth_headers)
    yield client
    for key in list(auth_headers):
        client.headers.pop(key, None)


@pytest.fixture()
def workspace() -> Path:
    path = Path(tempfile.mkdtemp(prefix="ws-", dir=str(TEST_ROOT / "workspaces")))
    yield path
    shutil.rmtree(path, ignore_errors=True)


def pytest_sessionfinish(session, exitstatus):  # pragma: no cover - cleanup
    shutil.rmtree(TEST_ROOT, ignore_errors=True)
