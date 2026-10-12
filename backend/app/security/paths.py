"""Workspace path guards.

Every filesystem operation performed by an agent is funnelled through
``resolve_in_workspace``.  The check is enforced in code, not in prompts:

1. the candidate path is joined to the workspace root and fully resolved
   (symlinks followed),
2. the resolved path must be the root itself or live underneath it,
3. an unconditional deny-list is applied even when the prefix check passes.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..config import settings

#: Path fragments that may never be read or written by an agent, even inside a
#: workspace (defence in depth against symlink tricks and committed secrets).
DENY_FRAGMENTS: tuple[str, ...] = (
    "/.git/",
    "/.ssh/",
    "/.aws/",
    "/.gnupg/",
    "/etc/",
    "/proc/",
    "/sys/",
    "/dev/",
    "/root/",
    "/.data/",
)

DENY_NAMES: frozenset[str] = frozenset(
    {
        ".env",
        ".env.local",
        ".env.production",
        "id_rsa",
        "id_ed25519",
        "credentials",
        ".netrc",
        ".git-credentials",
        "pranit.db",
        "secret_key",
        "api_token",
    }
)


class WorkspaceViolation(PermissionError):
    """Raised when an agent attempts to touch something outside its sandbox."""


def workspace_root(project_path: str | Path) -> Path:
    root = Path(project_path).expanduser()
    if not root.is_absolute():
        root = (settings.workspaces_dir / root).resolve()
    return root.resolve()


def is_within(root: Path, candidate: Path) -> bool:
    root = root.resolve()
    candidate = candidate.resolve()
    return candidate == root or root in candidate.parents


def _deny_check(resolved: Path) -> None:
    as_posix = resolved.as_posix()
    lowered = f"/{as_posix.lower()}/"
    for fragment in DENY_FRAGMENTS:
        if fragment in lowered:
            raise WorkspaceViolation(f"Path touches a protected location: {fragment.strip('/')}")
    if resolved.name in DENY_NAMES:
        raise WorkspaceViolation(f"Path targets a protected file name: {resolved.name}")


def resolve_in_workspace(root: str | Path, relative: str | os.PathLike[str]) -> Path:
    """Return a safe absolute path inside ``root`` or raise ``WorkspaceViolation``."""
    if not isinstance(relative, (str, Path)):
        raise WorkspaceViolation("Path must be a string")
    rel = str(relative).strip()
    if not rel:
        raise WorkspaceViolation("Empty path")
    if "\x00" in rel:
        raise WorkspaceViolation("Path contains a null byte")

    root_path = Path(root).expanduser().resolve()
    candidate = Path(rel)
    if candidate.is_absolute():
        # Absolute paths are only accepted when they already point inside the root.
        resolved = candidate.resolve()
    else:
        resolved = (root_path / candidate).resolve()

    if not is_within(root_path, resolved):
        raise WorkspaceViolation(
            f"Path escapes the project workspace: {rel!r} resolved to {resolved.as_posix()}"
        )
    _deny_check(resolved)
    return resolved


def relative_to_workspace(root: str | Path, path: str | Path) -> str:
    root_path = Path(root).expanduser().resolve()
    return Path(path).resolve().relative_to(root_path).as_posix()


def assert_within_workspaces(path: str | Path) -> Path:
    """Guard for operations that take a whole project directory."""
    resolved = Path(path).expanduser().resolve()
    base = settings.workspaces_dir.expanduser().resolve()
    if not is_within(base, resolved):
        raise WorkspaceViolation(f"Directory is outside the managed workspaces root: {resolved}")
    return resolved
