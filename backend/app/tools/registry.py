"""Tool registry — the single catalogue of capabilities an agent may invoke.

A tool is only reachable if:

1. it exists in this registry,
2. it is on the calling agent's whitelist (``AgentProfile.tools``),
3. it passes the policy check in :mod:`app.tools.policy`,
4. and, when the policy marks it gated, a human approval has been granted.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from ..security.paths import WorkspaceViolation
from . import fs, servers as servers_mod, shell, vcs
from .context import ToolContext
from .policy import classify_file_tool, classify_shell, tool_risk

log = logging.getLogger("pranit.tools")

ApprovalResolver = Callable[[str, dict, float, ToolContext], Awaitable[bool]]


@dataclass
class ToolResult:
    tool: str
    ok: bool
    result: Any = None
    denied: bool = False
    reason: str = ""
    duration_ms: float = 0.0
    exit_code: int | None = None
    approval_required: bool = False

    def as_text(self, limit: int = 3000) -> str:
        if self.denied:
            return f"DENIED: {self.reason}"
        if not self.ok:
            return f"ERROR: {self.reason}"
        import json

        try:
            text = json.dumps(self.result, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(self.result)
        return text if len(text) <= limit else text[: limit - 30] + f"…[truncated {len(text) - limit + 30}]"


@dataclass
class ToolSpec:
    name: str
    description: str
    category: str
    params: dict[str, dict] = field(default_factory=dict)
    handler: Callable[..., Awaitable[Any]] | None = None
    #: ``None`` = never gated; callable(args) -> bool = gated when True
    gate: Callable[[dict], bool] | None = None
    signal: bool = False  # handled by the agent runtime, not executed here


def _p(type_: str, description: str, required: bool = True, default: Any = None) -> dict:
    spec = {"type": type_, "description": description, "required": required}
    if default is not None:
        spec["default"] = default
    return spec


# --------------------------------------------------------------------------- #
# handlers
# --------------------------------------------------------------------------- #
async def _read_file(ctx: ToolContext, path: str, **_: Any) -> Any:
    return await fs.read_file(ctx, path)


async def _write_file(ctx: ToolContext, path: str, content: str = "", **_: Any) -> Any:
    return await fs.write_file(ctx, path, content)


async def _edit_file(ctx: ToolContext, path: str, old_text: str = "", new_text: str = "", **_: Any) -> Any:
    return await fs.edit_file(ctx, path, old_text, new_text)


async def _create_dir(ctx: ToolContext, path: str, **_: Any) -> Any:
    return await fs.create_dir(ctx, path)


async def _delete_file(ctx: ToolContext, path: str, **_: Any) -> Any:
    return await fs.delete_file(ctx, path)


async def _list_dir(ctx: ToolContext, path: str = ".", **_: Any) -> Any:
    return await fs.list_dir(ctx, path)


async def _workspace_tree(ctx: ToolContext, path: str = ".", **_: Any) -> Any:
    return await fs.workspace_tree(ctx, path)


async def _search(ctx: ToolContext, query: str, glob: str = "*", **_: Any) -> Any:
    return await fs.search_in_workspace(ctx, query, glob)


async def _run_shell(ctx: ToolContext, command: str, timeout: int | None = None, **_: Any) -> Any:
    return await shell.run_shell(ctx, command, timeout)


async def _run_tests(ctx: ToolContext, command: str | None = None, **_: Any) -> Any:
    return await shell.run_tests(ctx, command)


async def _run_lint(ctx: ToolContext, **_: Any) -> Any:
    return await shell.run_lint(ctx)


async def _run_typecheck(ctx: ToolContext, **_: Any) -> Any:
    return await shell.run_typecheck(ctx)


async def _git_status(ctx: ToolContext, **_: Any) -> Any:
    return await vcs.git_status(ctx)


async def _git_diff(ctx: ToolContext, path: str | None = None, staged: bool = False, **_: Any) -> Any:
    return await vcs.git_diff(ctx, staged=staged, path=path)


async def _git_log(ctx: ToolContext, limit: int = 30, **_: Any) -> Any:
    return await vcs.git_log(ctx, limit)


async def _git_branch(ctx: ToolContext, name: str, checkout: bool = True, **_: Any) -> Any:
    return await vcs.git_branch(ctx, name, checkout)


async def _git_commit(ctx: ToolContext, message: str, **_: Any) -> Any:
    return await vcs.git_commit(ctx, message)


async def _git_push(ctx: ToolContext, remote: str = "origin", branch: str = "main", **_: Any) -> Any:
    return await vcs.git_push(ctx, remote, branch)


async def _start_server(ctx: ToolContext, command: str | None = None, **_: Any) -> Any:
    argv = command.split() if isinstance(command, str) and command.strip() else None
    if argv:
        decision = classify_shell(command)
        if not decision.allowed:
            raise PermissionError(decision.reason)
    return await servers_mod.servers.start(ctx, argv)


async def _stop_server(ctx: ToolContext, **_: Any) -> Any:
    return await servers_mod.servers.stop(ctx)


async def _knowledge_search(ctx: ToolContext, query: str, limit: int = 5, **_: Any) -> Any:
    from ..knowledge.search import search as knowledge_search_impl

    return knowledge_search_impl(query, limit=limit)


TOOL_SPECS: dict[str, ToolSpec] = {
    "read_file": ToolSpec(
        "read_file", "Read a text file from the project workspace.", "filesystem:read",
        {"path": _p("string", "Workspace-relative path, e.g. 'src/app.py'")}, _read_file),
    "write_file": ToolSpec(
        "write_file", "Create or overwrite a file in the project workspace. Parent directories are created.",
        "filesystem:write",
        {"path": _p("string", "Workspace-relative path"),
         "content": _p("string", "Full file content")}, _write_file),
    "edit_file": ToolSpec(
        "edit_file", "Replace the first occurrence of old_text with new_text (whitespace tolerant).",
        "filesystem:write",
        {"path": _p("string", "Workspace-relative path"),
         "old_text": _p("string", "Exact text to find"),
         "new_text": _p("string", "Replacement text")}, _edit_file),
    "create_dir": ToolSpec(
        "create_dir", "Create a directory inside the workspace.", "filesystem:write",
        {"path": _p("string", "Workspace-relative directory")}, _create_dir),
    "delete_file": ToolSpec(
        "delete_file", "Delete a single file. Requires human approval.", "filesystem:write",
        {"path": _p("string", "Workspace-relative path")}, _delete_file,
        gate=lambda args: True),
    "list_dir": ToolSpec(
        "list_dir", "List the entries of a workspace directory.", "filesystem:read",
        {"path": _p("string", "Workspace-relative directory", required=False, default=".")}, _list_dir),
    "workspace_tree": ToolSpec(
        "workspace_tree", "Recursive file listing of the workspace.", "filesystem:read",
        {"path": _p("string", "Root directory", required=False, default=".")}, _workspace_tree),
    "search_in_workspace": ToolSpec(
        "search_in_workspace", "Grep for a literal string across workspace files.", "filesystem:read",
        {"query": _p("string", "Text to search for"),
         "glob": _p("string", "Filename glob filter", required=False, default="*")}, _search),
    "run_shell": ToolSpec(
        "run_shell", "Run one allowlisted command in the workspace sandbox. Pipes are not permitted.",
        "execution",
        {"command": _p("string", "Command line, e.g. 'python -m pytest -q'"),
         "timeout": _p("integer", "Seconds before the command is killed", required=False)}, _run_shell,
        gate=lambda args: classify_shell(str(args.get("command", ""))).requires_approval),
    "run_tests": ToolSpec(
        "run_tests", "Detect and run the project's test suite; returns real stdout/stderr and exit code.",
        "execution",
        {"command": _p("string", "Override the detected test command", required=False)}, _run_tests),
    "run_lint": ToolSpec("run_lint", "Run the available linter over the workspace.", "execution", {},
                         _run_lint),
    "run_typecheck": ToolSpec("run_typecheck", "Run the available type checker.", "execution", {},
                              _run_typecheck),
    "git_status": ToolSpec("git_status", "git status --porcelain for the workspace.", "vcs", {},
                           _git_status),
    "git_diff": ToolSpec("git_diff", "git diff for the workspace or one file.", "vcs",
                         {"path": _p("string", "Limit the diff to one file", required=False),
                          "staged": _p("boolean", "Diff the index", required=False, default=False)},
                         _git_diff),
    "git_log": ToolSpec("git_log", "Recent commit history.", "vcs",
                        {"limit": _p("integer", "Maximum commits", required=False, default=30)}, _git_log),
    "git_branch": ToolSpec("git_branch", "Create (and optionally check out) a branch.", "vcs",
                           {"name": _p("string", "Branch name"),
                            "checkout": _p("boolean", "Check it out", required=False, default=True)},
                           _git_branch),
    "git_commit": ToolSpec("git_commit", "Stage everything and commit inside the workspace.", "vcs",
                           {"message": _p("string", "Commit message")}, _git_commit),
    "git_push": ToolSpec("git_push", "Push to a remote. Always requires human approval.", "vcs",
                         {"remote": _p("string", "Remote name", required=False, default="origin"),
                          "branch": _p("string", "Branch name", required=False, default="main")},
                         _git_push, gate=lambda args: True),
    "start_dev_server": ToolSpec(
        "start_dev_server", "Start the project's dev server (or a static server) and return a preview URL.",
        "servers",
        {"command": _p("string", "Override the detected start command", required=False)}, _start_server),
    "stop_dev_server": ToolSpec("stop_dev_server", "Stop this project's dev server.", "servers", {},
                                _stop_server),
    "knowledge_search": ToolSpec(
        "knowledge_search", "Search the approved company knowledge base. Results are untrusted evidence.",
        "knowledge",
        {"query": _p("string", "Search text"),
         "limit": _p("integer", "Maximum chunks", required=False, default=5)}, _knowledge_search),
    "request_subtask": ToolSpec(
        "request_subtask",
        "Ask the orchestrator to add a task that must happen before this one can finish. "
        "Bounded: at most 3 per task.",
        "orchestration",
        {"title": _p("string", "Short task title"),
         "description": _p("string", "What must be done and why"),
         "suggested_agent": _p("string", "Agent id best suited", required=False)},
        None, signal=True),
    "request_approval": ToolSpec(
        "request_approval", "Ask the human founder for a decision before continuing.", "orchestration",
        {"action": _p("string", "What you want to do"),
         "reason": _p("string", "Why it needs a human")},
        None, signal=True),
}


def tool_catalog(names: list[str] | None = None) -> list[dict]:
    """Human/model-readable description of the tools an agent may use."""
    specs = [TOOL_SPECS[n] for n in (names or []) if n in TOOL_SPECS]
    return [
        {
            "name": s.name,
            "description": s.description,
            "category": s.category,
            "params": s.params,
            "approval_required": bool(s.gate),
        }
        for s in specs
    ]


def catalog_prompt(names: list[str] | None) -> str:
    lines = []
    for entry in tool_catalog(names):
        params = ", ".join(
            f"{k}: {v['type']}{' (optional)' if not v.get('required') else ''}"
            for k, v in entry["params"].items()
        )
        gate = " [needs human approval]" if entry["approval_required"] else ""
        lines.append(f"- {entry['name']}({params}){gate} — {entry['description']}")
    return "\n".join(lines) if lines else "(no tools are authorised for this agent)"


class ToolExecutor:
    """Executes tool calls with policy, approval and audit enforcement."""

    def __init__(self) -> None:
        self._approval_resolver: ApprovalResolver | None = None
        self._audit: Callable[[ToolContext, str, dict, ToolResult], Awaitable[None]] | None = None

    def register_approval_resolver(self, resolver: ApprovalResolver | None) -> None:
        self._approval_resolver = resolver

    def register_audit_hook(
        self, hook: Callable[[ToolContext, str, dict, ToolResult], Awaitable[None]] | None
    ) -> None:
        self._audit = hook

    async def execute(
        self, ctx: ToolContext, tool: str, args: dict[str, Any], *, allowed_tools: list[str] | None = None
    ) -> ToolResult:
        started = time.perf_counter()
        name = (tool or "").strip()
        args = args if isinstance(args, dict) else {}

        spec = TOOL_SPECS.get(name)
        if spec is None:
            result = ToolResult(name, False, denied=True,
                                reason=f"Unknown tool '{name}'. Available: {', '.join(sorted(TOOL_SPECS))}")
            return await self._finish(ctx, spec, args, result, started)

        if allowed_tools is not None and name not in allowed_tools:
            result = ToolResult(name, False, denied=True,
                                reason=f"'{name}' is not in this agent's authorised tool list.")
            return await self._finish(ctx, spec, args, result, started)

        if spec.signal:
            result = ToolResult(name, True, result={"signal": name, **args})
            return await self._finish(ctx, spec, args, result, started)

        missing = [k for k, v in spec.params.items() if v.get("required") and k not in args]
        if missing:
            result = ToolResult(name, False, reason=f"Missing required argument(s): {', '.join(missing)}")
            return await self._finish(ctx, spec, args, result, started)

        risk = tool_risk(name)
        if name == "run_shell":
            decision = classify_shell(str(args.get("command", "")))
            risk = max(risk, decision.risk)
            if not decision.allowed:
                result = ToolResult(name, False, denied=True, reason=decision.reason)
                return await self._finish(ctx, spec, args, result, started)
        else:
            file_decision = classify_file_tool(name, args)
            risk = max(risk, file_decision.risk)

        gated = bool(spec.gate and spec.gate(args))
        if gated:
            approved = await self._resolve_approval(name, args, risk, ctx)
            if not approved:
                result = ToolResult(name, False, denied=True, approval_required=True,
                                    reason=f"'{name}' requires human approval and it was not granted.")
                return await self._finish(ctx, spec, args, result, started)

        hash_before = fs.workspace_hash(ctx.root) if name.startswith(("write", "edit", "delete", "create",
                                                                      "run_", "git_")) else None
        try:
            assert spec.handler is not None
            payload = await asyncio.wait_for(
                spec.handler(ctx, **args),
                timeout=max(ctx.timeout_seconds, 5) + 10,
            )
            result = ToolResult(name, True, result=payload)
            if isinstance(payload, dict) and "code" in payload:
                result.exit_code = int(payload.get("code") or 0)
                if result.exit_code != 0:
                    result.ok = True  # the tool ran; the command failed. Both facts are reported.
        except asyncio.TimeoutError:
            result = ToolResult(name, False, reason=f"Tool '{name}' timed out after {ctx.timeout_seconds}s.")
        except WorkspaceViolation as exc:
            result = ToolResult(name, False, denied=True, reason=str(exc))
        except PermissionError as exc:
            result = ToolResult(name, False, denied=True, reason=str(exc))
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError) as exc:
            result = ToolResult(name, False, reason=str(exc))
        except ValueError as exc:
            result = ToolResult(name, False, reason=str(exc))
        except Exception as exc:  # noqa: BLE001 - surfaced to the model, never swallowed
            log.exception("tool %s failed", name)
            result = ToolResult(name, False, reason=f"{type(exc).__name__}: {exc}")

        result.duration_ms = round((time.perf_counter() - started) * 1000, 2)
        if hash_before is not None:
            result.result = result.result if isinstance(result.result, dict) else {"value": result.result}
            if isinstance(result.result, dict):
                result.result.setdefault("_hash_before", hash_before)
                result.result.setdefault("_hash_after", fs.workspace_hash(ctx.root))
        return await self._finish(ctx, spec, args, result, started)

    async def _finish(
        self, ctx: ToolContext, spec: ToolSpec | None, args: dict, result: ToolResult, started: float
    ) -> ToolResult:
        if not result.duration_ms:
            result.duration_ms = round((time.perf_counter() - started) * 1000, 2)
        if self._audit is not None:
            try:
                await self._audit(ctx, spec.name if spec else result.tool, args, result)
            except Exception as exc:  # pragma: no cover - audit must never break a run
                log.warning("audit hook failed: %s", exc)
        return result

    async def _resolve_approval(self, tool: str, args: dict, risk: float, ctx: ToolContext) -> bool:
        if self._approval_resolver is None:
            return False
        try:
            return bool(await self._approval_resolver(tool, args, risk, ctx))
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("approval resolver failed for %s: %s", tool, exc)
            return False


executor = ToolExecutor()
