"""Tool execution context."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ToolContext:
    root: Path
    project_id: str | None = None
    plan_id: str | None = None
    task_id: str | None = None
    agent_id: str | None = None
    sandbox_tier: int = 1
    timeout_seconds: int = 120
    docker_image: str = "python:3.12-slim"
    changed_files: set[str] = field(default_factory=set)
    extra: dict[str, Any] = field(default_factory=dict)

    def rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.root.resolve()).as_posix()
        except ValueError:  # pragma: no cover - guarded elsewhere
            return path.as_posix()
