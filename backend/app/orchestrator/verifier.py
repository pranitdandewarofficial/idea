"""Verification — evidence only.

A task is verified only when its ``verify_commands`` actually exit 0.  A plan is
delivered only when every automatically-checkable acceptance criterion has real
evidence; criteria that cannot be checked by code are reported as ``manual`` and
never silently marked as passed.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

from ..security.paths import WorkspaceViolation, resolve_in_workspace
from ..security.redact import truncate
from ..tools import shell
from ..tools.context import ToolContext

log = logging.getLogger("pranit.verifier")

SECRET_PATTERNS = (
    (re.compile(r"sk-[A-Za-z0-9_\-]{20,}"), "openai-style api key"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "anthropic api key"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{25,}"), "google api key"),
    (re.compile(r"ghp_[A-Za-z0-9]{30,}"), "github personal access token"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws access key id"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key block"),
)
SCAN_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
SCAN_MAX_BYTES = 1_500_000


async def verify_task(ctx: ToolContext, task: dict[str, Any]) -> dict[str, Any]:
    """Run the task's verify_commands and report raw evidence."""
    commands = [str(c) for c in (task.get("verify_commands") or []) if str(c).strip()]
    if not commands:
        return {
            "verified": None,
            "checks": [],
            "reason": "This task declared no verify_commands, so no automated evidence was collected. "
                      "Acceptance rests on the output contract check.",
        }

    checks: list[dict[str, Any]] = []
    for command in commands:
        try:
            result = await shell.run_shell(ctx, command, timeout=ctx.timeout_seconds)
            checks.append(
                {
                    "command": command,
                    "code": result.get("code"),
                    "passed": result.get("code") == 0,
                    "stdout": truncate(result.get("stdout", ""), 3000),
                    "stderr": truncate(result.get("stderr", ""), 3000),
                    "timed_out": bool(result.get("timed_out")),
                    "sandbox": result.get("sandbox"),
                    "duration_ms": result.get("duration_ms"),
                }
            )
        except PermissionError as exc:
            checks.append({"command": command, "code": None, "passed": False,
                           "stdout": "", "stderr": f"BLOCKED BY POLICY: {exc}", "policy_denied": True})
        except Exception as exc:  # noqa: BLE001
            checks.append({"command": command, "code": None, "passed": False,
                           "stdout": "", "stderr": f"{type(exc).__name__}: {exc}"})

    passed = all(c["passed"] for c in checks)
    failed = [c for c in checks if not c["passed"]]
    return {
        "verified": passed,
        "checks": checks,
        "reason": "" if passed else "; ".join(
            f"`{c['command']}` exited {c['code']}: {(c['stderr'] or c['stdout'] or '')[:300]}"
            for c in failed
        )[:1500],
    }


def scan_for_secrets(root: Path, limit: int = 25) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SCAN_SKIP_DIRS]
        for name in filenames:
            full = Path(dirpath) / name
            try:
                if full.stat().st_size > SCAN_MAX_BYTES:
                    continue
                text = full.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for pattern, label in SECRET_PATTERNS:
                match = pattern.search(text)
                if match:
                    try:
                        rel = full.resolve().relative_to(root.resolve()).as_posix()
                    except (ValueError, WorkspaceViolation):
                        rel = full.name
                    findings.append({"file": rel, "kind": label, "excerpt": "[REDACTED]"})
                    if len(findings) >= limit:
                        return findings
    return findings


_PATH_IN_TEXT = re.compile(r"[A-Za-z0-9_./\-]+\.(?:md|py|txt|html|sh|json|css|js|ts|toml|ya?ml|example)")


async def verify_acceptance(
    ctx: ToolContext,
    acceptance_criteria: list[str],
    *,
    tasks: list[dict[str, Any]],
    plan_verification: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Map every acceptance criterion to real evidence, or label it manual."""
    rows: list[dict[str, Any]] = []
    secret_findings = scan_for_secrets(ctx.root)
    tests_passed = None
    test_evidence = ""
    for check in (plan_verification or {}).get("checks", []):
        if "pytest" in str(check.get("command", "")) or "npm test" in str(check.get("command", "")):
            tests_passed = bool(check.get("passed"))
            test_evidence = f"`{check['command']}` exit {check['code']}"
            break

    for criterion in acceptance_criteria:
        lowered = criterion.lower()
        status = "manual"
        evidence = "No automated check applies to this criterion; a human must confirm it."

        mentioned = [p for p in _PATH_IN_TEXT.findall(criterion) if p]
        existing = []
        for path in mentioned:
            try:
                target = resolve_in_workspace(ctx.root, path)
            except WorkspaceViolation:
                continue
            if target.exists():
                existing.append(path)
            elif path.endswith("/") and target.is_dir():
                existing.append(path)

        if "secret" in lowered or "credential" in lowered or "api key" in lowered:
            status = "pass" if not secret_findings else "fail"
            evidence = (
                "Workspace secret scan found nothing."
                if not secret_findings
                else f"Secret scan found {len(secret_findings)} hit(s): "
                + ", ".join(f"{f['file']} ({f['kind']})" for f in secret_findings[:5])
            )
        elif "pytest" in lowered or ("test" in lowered and ("pass" in lowered or "exit" in lowered)):
            if tests_passed is None:
                status, evidence = "manual", "No test command was executed during verification."
            else:
                status = "pass" if tests_passed else "fail"
                evidence = test_evidence or "test run recorded"
        elif "readme" in lowered:
            readme = ctx.root / "README.md"
            status = "pass" if readme.exists() else "fail"
            evidence = f"README.md {'exists' if readme.exists() else 'is missing'} ({readme.stat().st_size if readme.exists() else 0} bytes)."
        elif existing:
            status = "pass" if len(existing) == len(mentioned) else "partial"
            evidence = f"Found on disk: {', '.join(existing)}" + (
                "" if status == "pass" else f"; missing: {', '.join(p for p in mentioned if p not in existing)}"
            )
        elif "file" in lowered or "directory" in lowered or "workspace" in lowered:
            entries = [p for p in ctx.root.rglob("*") if p.is_file()][:1]
            status = "pass" if entries else "fail"
            evidence = (
                f"Workspace contains {sum(1 for _ in ctx.root.rglob('*') if _.is_file())} file(s)."
                if entries
                else "Workspace is empty."
            )

        rows.append({"criterion": criterion, "status": status, "evidence": evidence})
    return rows


def summarise(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"pass": 0, "fail": 0, "partial": 0, "manual": 0}
    for row in rows:
        counts[row.get("status", "manual")] = counts.get(row.get("status", "manual"), 0) + 1
    return counts
