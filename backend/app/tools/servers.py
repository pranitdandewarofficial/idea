"""Development server management for real project previews."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..config import settings
from .context import ToolContext
from .shell import _scrubbed_env

log = logging.getLogger("pranit.servers")


@dataclass
class RunningServer:
    project_id: str
    port: int
    command: list[str]
    process: asyncio.subprocess.Process
    local_url: str
    public_url: str | None
    started_at: float = field(default_factory=time.time)
    log_tail: str = ""


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", 0))
        return int(sock.getsockname()[1])


def public_url_for(port: int) -> str | None:
    template = (settings.public_url_template or "").strip()
    if not template:
        return None
    try:
        return template.format(port=port)
    except (KeyError, IndexError):  # pragma: no cover - user supplied template
        return None


def detect_server_command(root: Path, port: int) -> list[str] | None:
    package_json = root / "package.json"
    if package_json.exists():
        try:
            data = json.loads(package_json.read_text(encoding="utf-8"))
            scripts = data.get("scripts") or {}
        except (OSError, json.JSONDecodeError):
            scripts = {}
        if "dev" in scripts:
            return ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", str(port)]
        if "start" in scripts:
            return ["npm", "start"]
    for static_root in ("web", "public", "dist", "static", "."):
        candidate = root / static_root
        if (candidate / "index.html").exists():
            return ["python", "-m", "http.server", str(port), "--bind", "0.0.0.0",
                    "--directory", str(candidate.resolve())]
    for entry in ("app.py", "main.py", "manage.py", "server.py"):
        if (root / entry).exists():
            return ["python", entry]
    return None


class ServerManager:
    def __init__(self) -> None:
        self._servers: dict[str, RunningServer] = {}
        self._lock = asyncio.Lock()

    async def start(self, ctx: ToolContext, command: list[str] | None = None) -> dict:
        project_id = ctx.project_id or str(ctx.root)
        async with self._lock:
            existing = self._servers.get(project_id)
            if existing is not None and existing.process.returncode is None:
                return {
                    "already_running": True,
                    "port": existing.port,
                    "local_url": existing.local_url,
                    "public_url": existing.public_url,
                    "command": " ".join(existing.command),
                }

            port = free_port()
            argv = command or detect_server_command(ctx.root, port)
            if not argv:
                return {
                    "started": False,
                    "reason": "No runnable entry point was found in this workspace "
                              "(no package.json dev script, no index.html, no app.py/main.py).",
                }
            from .shell import resolve_argv

            resolved = resolve_argv(argv)
            env = _scrubbed_env()
            env.update({"PORT": str(port), "HOST": "0.0.0.0"})
            try:
                process = await asyncio.create_subprocess_exec(
                    *resolved,
                    cwd=str(ctx.root),
                    env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except FileNotFoundError as exc:
                return {"started": False, "reason": f"executable not found: {resolved[0]} ({exc})"}

            server = RunningServer(
                project_id=project_id,
                port=port,
                command=resolved,
                process=process,
                local_url=f"http://127.0.0.1:{port}",
                public_url=public_url_for(port),
            )
            self._servers[project_id] = server

        # give the server a moment, then check it is still alive
        await asyncio.sleep(1.2)
        tail = await self._drain(server)
        if process.returncode is not None:
            self._servers.pop(project_id, None)
            return {
                "started": False,
                "reason": "the server process exited immediately",
                "exit_code": process.returncode,
                "log": tail,
            }
        return {
            "started": True,
            "port": port,
            "local_url": server.local_url,
            "public_url": server.public_url,
            "command": " ".join(resolved),
            "log": tail,
        }

    async def _drain(self, server: RunningServer) -> str:
        assert server.process.stdout is not None
        chunks: list[str] = []
        try:
            while True:
                line = await asyncio.wait_for(server.process.stdout.readline(), timeout=0.2)
                if not line:
                    break
                chunks.append(line.decode("utf-8", errors="replace"))
                if len(chunks) > 60:
                    break
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - readline on a live pipe
            pass
        server.log_tail = "".join(chunks)[-4000:]
        return server.log_tail

    async def stop(self, ctx: ToolContext) -> dict:
        project_id = ctx.project_id or str(ctx.root)
        async with self._lock:
            server = self._servers.pop(project_id, None)
        if server is None:
            return {"stopped": False, "reason": "no server is running for this project"}
        if server.process.returncode is None:
            server.process.terminate()
            try:
                await asyncio.wait_for(server.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                server.process.kill()
        return {"stopped": True, "port": server.port}

    async def stop_all(self) -> None:
        for project_id in list(self._servers):
            server = self._servers.pop(project_id, None)
            if server is not None and server.process.returncode is None:
                server.process.kill()

    def status(self, project_id: str) -> dict:
        server = self._servers.get(project_id)
        if server is None:
            return {"running": False}
        return {
            "running": server.process.returncode is None,
            "port": server.port,
            "local_url": server.local_url,
            "public_url": server.public_url,
            "command": " ".join(server.command),
            "exit_code": server.process.returncode,
            "log": server.log_tail[-2000:],
        }

    def all_status(self) -> list[dict]:
        return [{"project_id": pid, **self.status(pid)} for pid in self._servers]


servers = ServerManager()

__all__ = ["ServerManager", "servers", "detect_server_command", "free_port", "public_url_for"]
