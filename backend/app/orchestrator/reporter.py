"""Final delivery report — links to real artifacts and honest limitations."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..db import session_scope
from ..models import DecisionRecord, Plan, Project, Task, ToolCall, UsageRecord
from ..tools import fs


def _file_list(root: Path, limit: int = 200) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    import os

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in fs.IGNORED_DIRS]
        for name in sorted(filenames):
            full = Path(dirpath) / name
            try:
                entries.append({"path": full.relative_to(root).as_posix(), "size": full.stat().st_size})
            except (OSError, ValueError):
                continue
            if len(entries) >= limit:
                return entries
    return entries


def build_report(
    *,
    project: dict[str, Any],
    plan: dict[str, Any],
    tasks: list[dict[str, Any]],
    verification: dict[str, Any],
    acceptance: list[dict[str, Any]],
    budget: dict[str, Any],
    root: Path,
    preview: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with session_scope() as s:
        decisions = (
            s.query(DecisionRecord).filter(DecisionRecord.plan_id == plan.get("id")).count()
        )
        decision_rows = s.query(DecisionRecord).filter(DecisionRecord.plan_id == plan.get("id")).all()
        tool_calls = s.query(ToolCall).filter(ToolCall.task_id.in_([t["id"] for t in tasks] or ["-"])).all()
        usage = s.query(UsageRecord).filter(UsageRecord.project_id == project.get("id")).all()

    engines: dict[str, int] = {}
    for row in decision_rows:
        engines[row.engine] = engines.get(row.engine, 0) + 1
    escalated = sum(1 for row in decision_rows if row.fallback_used)

    counts = {"completed": 0, "failed": 0, "cancelled": 0, "blocked": 0, "other": 0}
    for task in tasks:
        key = task["status"] if task["status"] in counts else "other"
        counts[key] += 1

    used_mock = any(u.mocked for u in usage) or bool(plan.get("heuristic"))
    files = _file_list(root)
    secret_findings = verification.get("secret_findings", [])

    limitations: list[str] = []
    if plan.get("heuristic"):
        limitations.append(
            "The plan was produced by the deterministic rule-based planner, not a language model "
            "(no provider was usable at planning time)."
        )
    if used_mock:
        limitations.append(
            "At least one step used the offline mock provider. This run is a dry run and is NOT a real "
            "delivery — re-run with a configured AI provider."
        )
    if counts["failed"] or counts["blocked"]:
        limitations.append(
            f"{counts['failed']} task(s) failed and {counts['blocked']} are blocked; the deliverable is partial."
        )
    manual = [row for row in acceptance if row["status"] == "manual"]
    if manual:
        limitations.append(
            f"{len(manual)} acceptance criterion/criteria could not be checked automatically and need "
            "human confirmation."
        )
    failed_criteria = [row for row in acceptance if row["status"] == "fail"]
    if failed_criteria:
        limitations.append(
            "These acceptance criteria FAILED verification: "
            + "; ".join(row["criterion"][:80] for row in failed_criteria[:5])
        )
    if secret_findings:
        limitations.append(
            f"The workspace secret scan found {len(secret_findings)} suspicious value(s) — review before sharing."
        )
    unverified = [t for t in tasks if not (t.get("verification") or {}).get("verified")]
    if unverified:
        limitations.append(
            f"{len(unverified)} task(s) had no automated verification command, so their outputs were "
            "accepted on the output-contract check alone."
        )
    if not limitations:
        limitations.append("None recorded. Every declared criterion has automated evidence.")

    return {
        "project": {"id": project.get("id"), "name": project.get("name"),
                    "workspace": project.get("workspace_path")},
        "objective": plan.get("objective"),
        "state": plan.get("state"),
        "delivered": bool(verification.get("ok")) and counts["failed"] == 0 and not failed_criteria
                     and not used_mock,
        "summary": _summary(plan, tasks, counts, verification),
        "requirements": plan.get("requirements", []),
        "acceptance_criteria": acceptance,
        "tasks": [
            {
                "id": t.get("external_id") or t["id"],
                "title": t["title"],
                "agent_id": t.get("agent_id"),
                "status": t["status"],
                "retries": t.get("retries", 0),
                "files_changed": t.get("files_changed", []),
                "verified": (t.get("verification") or {}).get("verified"),
                "summary": (t.get("summary") or "")[:600],
            }
            for t in tasks
        ],
        "verification": verification,
        "artifacts": {"files": files, "file_count": len(files),
                      "workspace_hash": fs.workspace_hash(root)},
        "metrics": {
            "task_counts": counts,
            "tool_calls": len(tool_calls),
            "tool_calls_denied": sum(1 for c in tool_calls if c.denied),
            "decisions": decisions,
            "decision_engines": engines,
            "decisions_escalated_to_llm": escalated,
            "tokens_in": sum(u.tokens_in for u in usage),
            "tokens_out": sum(u.tokens_out for u in usage),
            "cost_estimate": round(sum(u.cost_estimate for u in usage), 6),
            "mocked_calls": sum(1 for u in usage if u.mocked),
            **budget,
        },
        "preview": preview or {},
        "limitations": limitations,
        "used_mock_provider": used_mock,
    }


def _summary(plan: dict, tasks: list[dict], counts: dict[str, int], verification: dict) -> str:
    total = len(tasks)
    state = plan.get("state")
    verified = verification.get("ok")
    if state == "complete" and verified:
        return (
            f"All {total} tasks completed and verification passed. The workspace contains real files "
            f"and the executed checks exited 0."
        )
    if state == "complete":
        return (
            f"{counts['completed']}/{total} tasks completed. Verification did not fully pass: "
            f"{verification.get('reason', 'see the verification section')}."
        )
    if state == "failed":
        return f"The run stopped: {plan.get('failure_reason') or 'unrecoverable failure'}."
    if state == "blocked":
        return "The run is waiting on a human decision before it can continue."
    return f"Run state: {state}. {counts['completed']}/{total} tasks completed."
