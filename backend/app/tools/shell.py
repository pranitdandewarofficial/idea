"""Command execution with sandboxing, resource limits and an allowlist.

Two sandbox tiers are implemented:

* **tier 1** (default) — a subprocess rooted in the project workspace, with a
  wall-clock timeout, POSIX resource limits, a scrubbed environment and the
  policy allowlist applied before spawn.
* **tier 2** — the same command inside a throw-away Docker container with the
  workspace bind-mounted, no network, and CPU/memory caps.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import sys
import time
from pathlib import Path

from ..config import settings
from .context import ToolContext
from .policy import classify_shell

SENSITIVE_ENV_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")

MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
FILE_LIMIT_BYTES = 256 * 1024 * 1024
PROCESS_LIMIT = 512
MAX_OUTPUT_CHARS = 40_000


def _scrubbed_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not any(m in k.upper() for m in SENSITIVE_ENV_MARKERS)}
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "0"
    env["CI"] = "1"
    env["TERM"] = "dumb"
    env.pop("PYTHONPATH", None)
    return env


def _preexec() -> None:  # pragma: no cover - runs in the child process
    try:
        os.setsid()
    except OSError:
        pass
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT_BYTES, FILE_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (PROCESS_LIMIT, PROCESS_LIMIT))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ImportError, ValueError, OSError):
        pass


def resolve_argv(argv: list[str]) -> list[str]:
    """Point interpreters at the interpreter that is actually running the backend.

    Without this, a generated project's ``python -m pytest`` would use whatever
    ``python`` happens to be first on PATH, which usually has no pytest.
    """
    if not argv:
        return argv
    head = argv[0].split("/")[-1]
    rest = argv[1:]
    if head in ("python", "python3", sys.executable.split("/")[-1]):
        return [sys.executable, *rest]
    if head == "pytest":
        return [sys.executable, "-m", "pytest", *rest]
    if head in ("pip", "pip3"):
        return [sys.executable, "-m", "pip", *rest]
    if head in ("ruff", "mypy", "black", "prettier", "eslint", "tsc"):
        found = shutil.which(head)
        if found:
            return [found, *rest]
        return [sys.executable, "-m", head, *rest]
    found = shutil.which(head)
    return [found or head, *rest]


def docker_available() -> bool:
    return shutil.which("docker") is not None


async def _run_docker(ctx: ToolContext, argv: list[str], timeout: int) -> dict:
    command = [
        "docker", "run", "--rm",
        "--network", "none",
        "--memory", "1g",
        "--cpus", "1",
        "--pids-limit", "256",
        "-v", f"{ctx.root.resolve()}:/work",
        "-w", "/work",
        ctx.docker_image,
        *argv,
    ]
    return await _spawn(command, cwd=ctx.root, timeout=timeout, env={"PATH": "/usr/local/bin:/usr/bin:/bin"})


async def _spawn(command: list[str], *, cwd: Path, timeout: int, env: dict[str, str]) -> dict:
    started = time.perf_counter()
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(cwd),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            preexec_fn=_preexec if os.name == "posix" else None,
        )
    except FileNotFoundError as exc:
        return {
            "code": 127,
            "stdout": "",
            "stderr": f"executable not found: {command[0]} ({exc})",
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            "timed_out": False,
            "command": " ".join(command),
        }

    timed_out = False
    try:
        stdout_b, stderr_b = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        stdout_b, stderr_b = b"", b""
        _kill_tree(process)
        try:
            stdout_b, stderr_b = await asyncio.wait_for(process.communicate(), timeout=5)
        except Exception:
            pass

    stdout = (stdout_b or b"").decode("utf-8", errors="replace")
    stderr = (stderr_b or b"").decode("utf-8", errors="replace")
    truncated = len(stdout) + len(stderr) > MAX_OUTPUT_CHARS
    return {
        "code": process.returncode if process.returncode is not None else -1,
        "stdout": stdout[:MAX_OUTPUT_CHARS],
        "stderr": stderr[:MAX_OUTPUT_CHARS],
        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
        "timed_out": timed_out,
        "command": " ".join(command),
        "truncated": truncated,
    }


def _kill_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        else:  # pragma: no cover - windows
            process.terminate()
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.terminate()
        except Exception:
            pass


async def run_shell(ctx: ToolContext, command: str, timeout: int | None = None) -> dict:
    decision = classify_shell(command)
    if not decision.allowed:
        raise PermissionError(decision.reason)
    if decision.requires_approval:
        raise PermissionError(f"This command needs human approval: {decision.reason}")

    limit = int(timeout or ctx.timeout_seconds or settings.shell_timeout_seconds)
    argv = decision.argv
    if argv is None:
        # compound command: execute each segment sequentially, stop on failure
        import re as _re
        import shlex as _shlex

        segments = [s.strip() for s in _re.split(r"&&|;", command) if s.strip()]
        outputs: list[dict] = []
        for segment in segments:
            sub = classify_shell(segment)
            if not sub.allowed or sub.requires_approval or not sub.argv:
                raise PermissionError(f"Segment rejected: {sub.reason}")
            result = await _execute(ctx, sub.argv, limit)
            outputs.append(result)
            if result["code"] != 0:
                break
        combined = {
            "code": outputs[-1]["code"] if outputs else 1,
            "stdout": "\n".join(o["stdout"] for o in outputs),
            "stderr": "\n".join(o["stderr"] for o in outputs),
            "duration_ms": sum(o["duration_ms"] for o in outputs),
            "timed_out": any(o["timed_out"] for o in outputs),
            "command": command,
            "segments": len(outputs),
        }
        return combined

    return await _execute(ctx, argv, limit)


async def _execute(ctx: ToolContext, argv: list[str], limit: int) -> dict:
    resolved = resolve_argv(argv)
    tier = ctx.sandbox_tier
    if tier >= 2 and docker_available():
        result = await _run_docker(ctx, argv, limit)
        result["sandbox"] = f"docker:{ctx.docker_image}"
        return result
    result = await _spawn(resolved, cwd=ctx.root, timeout=limit, env=_scrubbed_env())
    result["sandbox"] = "subprocess"
    return result


def detect_test_command(root: Path) -> list[str] | None:
    package_json = root / "package.json"
    if package_json.exists():
        try:
            data = json.loads(package_json.read_text(encoding="utf-8"))
            scripts = data.get("scripts") or {}
            if "test" in scripts:
                return ["npm", "test", "--", "--run"] if "vitest" in str(scripts.get("test", "")) else ["npm", "test"]
        except (OSError, json.JSONDecodeError):
            pass
    if (root / "pytest.ini").exists() or (root / "tests").is_dir() or list(root.rglob("test_*.py"))[:1]:
        return ["python", "-m", "pytest", "-q"]
    if list(root.glob("*.py")) or (root / "src").is_dir():
        return ["python", "-m", "compileall", "-q", "."]
    return None


async def run_tests(ctx: ToolContext, command: str | None = None) -> dict:
    argv = None
    if command:
        decision = classify_shell(command)
        if not decision.allowed or decision.requires_approval:
            raise PermissionError(decision.reason or "test command not permitted")
        argv = decision.argv or command.split()
    if argv is None:
        argv = detect_test_command(ctx.root)
    if argv is None:
        return {
            "code": -1,
            "stdout": "",
            "stderr": "No test runner was detected in this workspace (no package.json test script, "
                      "no pytest.ini/tests directory).",
            "duration_ms": 0.0,
            "timed_out": False,
            "command": "",
            "detected": False,
        }
    result = await _execute(ctx, argv, ctx.timeout_seconds)
    result["detected"] = True
    result["passed"] = result["code"] == 0
    return result


async def run_lint(ctx: ToolContext) -> dict:
    if shutil.which("ruff") or _module_available("ruff"):
        return await _execute(ctx, ["ruff", "check", "."], ctx.timeout_seconds)
    return await _execute(ctx, ["python", "-m", "compileall", "-q", "."], ctx.timeout_seconds)


async def run_typecheck(ctx: ToolContext) -> dict:
    if (ctx.root / "package.json").exists() and shutil.which("npx"):
        return await _execute(ctx, ["npx", "tsc", "--noEmit"], ctx.timeout_seconds)
    if _module_available("mypy"):
        return await _execute(ctx, ["mypy", "."], ctx.timeout_seconds)
    return {
        "code": -1,
        "stdout": "",
        "stderr": "No type checker available for this workspace.",
        "duration_ms": 0.0,
        "timed_out": False,
        "command": "",
    }


def _module_available(module: str) -> bool:
    try:
        import importlib.util

        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False
