"""Project workspaces: real files, diffs, git history, tests and previews."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

from ..api.errors import ApiError
from ..db import session_scope
from ..events import bus
from ..models import Plan, Project, Task
from ..security.auth import require_auth
from ..security.paths import WorkspaceViolation, assert_within_workspaces, resolve_in_workspace
from ..security.redact import truncate
from ..tools import fs, shell, vcs
from ..tools.context import ToolContext
from ..tools.servers import servers

router = APIRouter(prefix="/api/projects", tags=["projects"], dependencies=[Depends(require_auth)])


def _project_or_404(project_id: str) -> dict[str, Any]:
    with session_scope() as s:
        row = s.get(Project, project_id)
        if row is None:
            raise ApiError("not_found", f"Project '{project_id}' does not exist.", status=404)
        return {
            "id": row.id, "name": row.name, "objective": row.objective,
            "workspace_path": row.workspace_path, "status": row.status,
            "preview_url": row.preview_url, "preview_port": row.preview_port,
            "report": dict(row.report or {}),
        }


def _ctx(project: dict[str, Any]) -> ToolContext:
    root = assert_within_workspaces(project["workspace_path"])
    return ToolContext(root=root, project_id=project["id"])


@router.get("/{project_id}")
def get_project(project_id: str) -> dict[str, Any]:
    project = _project_or_404(project_id)
    with session_scope() as s:
        plans = s.query(Plan).filter(Plan.project_id == project_id).order_by(Plan.created_at.desc()).all()
        tasks = s.query(Task).filter(Task.project_id == project_id).order_by(Task.order_index).all()
    project["plans"] = [
        {"id": p.id, "state": p.state, "progress": p.progress, "heuristic": p.heuristic,
         "objective": p.objective, "failure_reason": p.failure_reason,
         "created_at": p.created_at.isoformat() if p.created_at else None}
        for p in plans
    ]
    project["tasks"] = [
        {"id": t.id, "external_id": t.external_id, "title": t.title, "status": t.status,
         "agent_id": t.agent_id, "files_changed": list(t.files_changed or []),
         "verification": dict(t.verification or {}), "error": t.error}
        for t in tasks
    ]
    project["preview"] = servers.status(project_id)
    return project


@router.get("/{project_id}/tree")
async def project_tree(project_id: str, path: str = ".") -> dict[str, Any]:
    project = _project_or_404(project_id)
    ctx = _ctx(project)
    try:
        return await fs.workspace_tree(ctx, path)
    except WorkspaceViolation as exc:
        raise ApiError("forbidden", str(exc), status=403)


@router.get("/{project_id}/file")
def project_file(project_id: str, path: str) -> dict[str, Any]:
    project = _project_or_404(project_id)
    root = assert_within_workspaces(project["workspace_path"])
    try:
        target = resolve_in_workspace(root, path)
    except WorkspaceViolation as exc:
        raise ApiError("forbidden", str(exc), status=403)
    if not target.exists():
        raise ApiError("not_found", f"'{path}' does not exist in this workspace.", status=404)
    if target.is_dir():
        raise ApiError("invalid_request", f"'{path}' is a directory; use /tree.", status=422)
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ApiError("read_error", str(exc), status=500)
    return {
        "path": target.relative_to(root).as_posix(),
        "content": truncate(content, 200_000),
        "size": target.stat().st_size,
        "truncated": target.stat().st_size > 200_000,
    }


@router.get("/{project_id}/diff")
async def project_diff(project_id: str, staged: bool = False, path: str | None = None) -> dict[str, Any]:
    project = _project_or_404(project_id)
    ctx = _ctx(project)
    result = await vcs.git_diff(ctx, staged=staged, path=path)
    if not result.get("repo"):
        raise ApiError("no_repository", "This workspace has no git repository yet.", status=409)
    return result


@router.get("/{project_id}/git/log")
async def project_git_log(project_id: str, limit: int = 50) -> dict[str, Any]:
    project = _project_or_404(project_id)
    ctx = _ctx(project)
    return await vcs.git_log(ctx, limit)


@router.get("/{project_id}/tests")
async def project_tests(project_id: str) -> dict[str, Any]:
    """Real, freshly-executed test results for this workspace."""
    project = _project_or_404(project_id)
    ctx = _ctx(project)
    result = await shell.run_tests(ctx)
    return {
        "command": result.get("command"),
        "code": result.get("code"),
        "passed": bool(result.get("passed")),
        "detected": bool(result.get("detected")),
        "stdout": truncate(result.get("stdout", ""), 20_000),
        "stderr": truncate(result.get("stderr", ""), 20_000),
        "duration_ms": result.get("duration_ms"),
        "sandbox": result.get("sandbox"),
        "timed_out": result.get("timed_out"),
    }


@router.post("/{project_id}/preview/start")
async def start_preview(project_id: str, command: str | None = None) -> dict[str, Any]:
    project = _project_or_404(project_id)
    ctx = _ctx(project)
    argv = command.split() if command else None
    if argv:
        from ..tools.policy import classify_shell

        decision = classify_shell(command or "")
        if not decision.allowed:
            raise ApiError("policy_denied", decision.reason, status=403)
    result = await servers.start(ctx, argv)
    if not result.get("started") and not result.get("already_running"):
        raise ApiError("preview_failed", result.get("reason", "could not start a preview server"),
                       status=409, context=result)
    with session_scope() as s:
        row = s.get(Project, project_id)
        if row is not None:
            row.preview_url = result.get("public_url") or result.get("local_url")
            row.preview_port = result.get("port")
    await bus.emit("preview.started", project_id=project_id, **{
        k: result.get(k) for k in ("port", "local_url", "public_url", "command")
    })
    return result


@router.post("/{project_id}/preview/stop")
async def stop_preview(project_id: str) -> dict[str, Any]:
    project = _project_or_404(project_id)
    ctx = _ctx(project)
    result = await servers.stop(ctx)
    with session_scope() as s:
        row = s.get(Project, project_id)
        if row is not None:
            row.preview_url = None
            row.preview_port = None
    await bus.emit("preview.stopped", project_id=project_id, **result)
    return result


@router.get("/{project_id}/preview")
def preview_status(project_id: str) -> dict[str, Any]:
    _project_or_404(project_id)
    return servers.status(project_id)


@router.get("/{project_id}/secrets-scan")
def secrets_scan(project_id: str) -> dict[str, Any]:
    from ..orchestrator.verifier import scan_for_secrets

    project = _project_or_404(project_id)
    root = Path(project["workspace_path"])
    findings = scan_for_secrets(root)
    return {"findings": findings, "count": len(findings), "clean": not findings}


@router.delete("/{project_id}")
def delete_project(project_id: str, remove_files: bool = False) -> dict[str, Any]:
    project = _project_or_404(project_id)
    root = Path(project["workspace_path"])
    removed_files = False
    if remove_files:
        try:
            assert_within_workspaces(root)
            import shutil

            shutil.rmtree(root, ignore_errors=True)
            removed_files = True
        except WorkspaceViolation as exc:
            raise ApiError("forbidden", str(exc), status=403)
    with session_scope() as s:
        s.query(Task).filter(Task.project_id == project_id).delete()
        s.query(Plan).filter(Plan.project_id == project_id).delete()
        row = s.get(Project, project_id)
        if row is not None:
            s.delete(row)
    from ..memory import store as memory
    from ..models import AuditRecord

    memory.forget(scope="project", scope_id=project_id)
    with session_scope() as s:
        s.add(AuditRecord(actor="founder", action="project.deleted", target=project_id,
                          result="ok", context={"removed_files": removed_files}))
    return {"deleted": True, "project_id": project_id, "files_removed": removed_files}


@router.get("")
def projects_root() -> dict[str, Any]:
    with session_scope() as s:
        rows = s.query(Project).order_by(Project.created_at.desc()).all()
        return {
            "items": [
                {"id": r.id, "name": r.name, "status": r.status,
                 "workspace_path": r.workspace_path, "objective": r.objective,
                 "preview_url": r.preview_url,
                 "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows
            ]
        }
