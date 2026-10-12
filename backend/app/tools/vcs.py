"""Git tooling, scoped to the project workspace."""

from __future__ import annotations

from pathlib import Path

from .context import ToolContext
from .shell import _spawn, _scrubbed_env  # noqa: PLC2701 - internal helper reuse


async def _git(ctx: ToolContext, *args: str, timeout: int | None = None) -> dict:
    result = await _spawn(
        ["git", *args],
        cwd=ctx.root,
        timeout=int(timeout or ctx.timeout_seconds),
        env=_scrubbed_env(),
    )
    result["command"] = f"git {' '.join(args)}"
    return result


def is_repo(root: Path) -> bool:
    return (root / ".git").exists()


async def ensure_repo(ctx: ToolContext) -> dict:
    if is_repo(ctx.root):
        return {"initialized": False, "path": str(ctx.root)}
    result = await _git(ctx, "init", "-q")
    await _git(ctx, "config", "user.email", "orchestrator@pranit.local")
    await _git(ctx, "config", "user.name", "PRANIT AI CITY Orchestrator")
    await _git(ctx, "checkout", "-q", "-b", "main")
    return {"initialized": result["code"] == 0, "path": str(ctx.root), "detail": result}


async def git_status(ctx: ToolContext) -> dict:
    if not is_repo(ctx.root):
        return {"repo": False, "stdout": "", "stderr": "", "code": 0}
    result = await _git(ctx, "status", "--porcelain=v1", "-b")
    result["repo"] = True
    return result


async def git_diff(ctx: ToolContext, staged: bool = False, path: str | None = None) -> dict:
    if not is_repo(ctx.root):
        return {"repo": False, "diff": ""}
    args = ["diff", "--no-color"]
    if staged:
        args.append("--cached")
    if path:
        from ..security.paths import resolve_in_workspace

        target = resolve_in_workspace(ctx.root, path)
        args += ["--", str(target.relative_to(ctx.root))]
    result = await _git(ctx, *args)
    return {"repo": True, "diff": result["stdout"], "code": result["code"], "stderr": result["stderr"]}


async def git_log(ctx: ToolContext, limit: int = 50) -> dict:
    if not is_repo(ctx.root):
        return {"repo": False, "commits": []}
    result = await _git(ctx, "log", f"--max-count={int(limit)}", "--pretty=format:%H%x1f%an%x1f%ad%x1f%s",
                        "--date=iso")
    commits = []
    for line in result["stdout"].splitlines():
        parts = line.split("\x1f")
        if len(parts) == 4:
            commits.append({"hash": parts[0], "author": parts[1], "date": parts[2], "subject": parts[3]})
    return {"repo": True, "commits": commits, "count": len(commits)}


async def git_branch(ctx: ToolContext, name: str, checkout: bool = True) -> dict:
    await ensure_repo(ctx)
    safe = "".join(c for c in name if c.isalnum() or c in "-_/.").strip("/")
    if not safe:
        raise ValueError("Branch name must contain alphanumeric characters, '-', '_' or '/'.")
    if checkout:
        result = await _git(ctx, "checkout", "-q", "-B", safe)
    else:
        result = await _git(ctx, "branch", safe)
    return {"branch": safe, "code": result["code"], "stderr": result["stderr"], "checked_out": checkout}


async def git_commit(ctx: ToolContext, message: str) -> dict:
    await ensure_repo(ctx)
    await _git(ctx, "add", "-A")
    result = await _git(ctx, "commit", "-q", "-m", message[:500] or "chore: automated commit")
    if result["code"] != 0 and "nothing to commit" in (result["stdout"] + result["stderr"]):
        return {"committed": False, "reason": "nothing to commit", "code": 0}
    log = await _git(ctx, "log", "-1", "--pretty=format:%H")
    return {
        "committed": result["code"] == 0,
        "code": result["code"],
        "stderr": result["stderr"][:2000],
        "commit": log["stdout"].strip(),
    }


async def git_push(ctx: ToolContext, remote: str = "origin", branch: str = "main") -> dict:
    """Always approval-gated; the registry refuses to run it without a decision."""
    result = await _git(ctx, "push", remote, branch)
    return {"code": result["code"], "stdout": result["stdout"], "stderr": result["stderr"]}
