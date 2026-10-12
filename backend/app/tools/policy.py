"""Tool policy: command allowlist, deny patterns and approval rules.

Policy lives in code, not in prompts.  An agent cannot argue its way past it.
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass

#: Executables an agent may run at all (sandbox tier 1).
ALLOWED_EXECUTABLES: frozenset[str] = frozenset(
    {
        "python",
        "python3",
        "pytest",
        "pip",
        "pip3",
        "node",
        "npm",
        "npx",
        "pnpm",
        "yarn",
        "git",
        "ls",
        "cat",
        "head",
        "tail",
        "echo",
        "mkdir",
        "touch",
        "grep",
        "rg",
        "find",
        "wc",
        "sort",
        "uniq",
        "diff",
        "pwd",
        "which",
        "ruff",
        "mypy",
        "tsc",
        "eslint",
        "prettier",
        "bash",
        "sh",
    }
)

#: Substrings that never appear in an authorised command line.
DENY_SUBSTRINGS: tuple[str, ...] = (
    "rm -rf",
    "rm -fr",
    "rmdir",
    "sudo",
    "su -",
    "curl",
    "wget",
    "nc ",
    "netcat",
    "ssh ",
    "scp ",
    "rsync",
    "mkfs",
    "dd if=",
    ":(){",
    "chmod 777",
    "chown -r",
    "--no-preserve-root",
    "shutdown",
    "reboot",
    "systemctl",
    "iptables",
    ">/dev/sd",
    "| sh",
    "|sh",
    "| bash",
    "|bash",
    "eval ",
    "base64 -d",
    "history -c",
    "crontab",
    "kill -9 1",
    "/etc/passwd",
    "/etc/shadow",
    "~/.ssh",
    "$HOME/.ssh",
    "/root/",
    "id_rsa",
    ".aws/credentials",
)

#: Path fragments that may not appear anywhere in a command line.
DENY_PATH_FRAGMENTS: tuple[str, ...] = (
    "/etc/",
    "/proc/",
    "/sys/",
    "/dev/",
    "/boot/",
    "/usr/bin/",
    "/usr/sbin/",
    "/var/lib/",
)

GIT_SAFE_SUBCOMMANDS: frozenset[str] = frozenset(
    {"status", "diff", "log", "show", "add", "commit", "branch", "checkout", "switch", "rev-parse",
     "ls-files", "init", "config", "stash", "tag", "remote"}
)
GIT_APPROVAL_SUBCOMMANDS: frozenset[str] = frozenset({"push", "clean", "reset", "rebase", "filter-branch"})

PKG_SAFE_SUBCOMMANDS: frozenset[str] = frozenset(
    {"install", "ci", "run", "test", "build", "lint", "list", "ls", "outdated", "view", "typecheck",
     "format", "dev", "start"}
)
PKG_APPROVAL_SUBCOMMANDS: frozenset[str] = frozenset({"publish", "unpublish", "deprecate", "login", "adduser"})

PIP_SAFE_SUBCOMMANDS: frozenset[str] = frozenset(
    {"install", "list", "freeze", "show", "check", "download", "uninstall"}
)

#: Packages that may be installed without asking (very small, ubiquitous, safe).
TRUSTED_PACKAGES: frozenset[str] = frozenset(
    {"pytest", "ruff", "mypy", "black", "httpx", "pydantic", "fastapi", "uvicorn", "sqlalchemy",
     "cryptography", "python-multipart", "websockets", "pydantic-settings", "pytest-asyncio"}
)

SCRIPT_EXECUTABLES: frozenset[str] = frozenset({"bash", "sh"})


@dataclass
class PolicyDecision:
    allowed: bool
    requires_approval: bool = False
    reason: str = ""
    argv: list[str] | None = None
    risk: float = 0.0

    @property
    def denied(self) -> bool:
        return not self.allowed


def _lowered(command: str) -> str:
    return command.lower()


def find_deny_substring(command: str) -> str | None:
    lowered = _lowered(command)
    for needle in DENY_SUBSTRINGS:
        if needle in lowered:
            return needle
    return None


def find_deny_path(command: str) -> str | None:
    lowered = _lowered(command)
    for fragment in DENY_PATH_FRAGMENTS:
        if fragment in lowered:
            return fragment
    return None


def classify_shell(command: str) -> PolicyDecision:
    """Decide whether a shell command may run, and whether it needs approval."""
    if not command or not command.strip():
        return PolicyDecision(False, reason="Empty command")

    denied = find_deny_substring(command)
    if denied:
        return PolicyDecision(False, reason=f"Command contains a blocked pattern: '{denied}'", risk=1.0)
    denied_path = find_deny_path(command)
    if denied_path:
        return PolicyDecision(False, reason=f"Command references a protected path: '{denied_path}'", risk=1.0)
    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        return PolicyDecision(False, reason=f"Command could not be parsed: {exc}", risk=0.6)
    if not tokens:
        return PolicyDecision(False, reason="Empty command")

    # Shell operators only count when they are *unquoted* (shlex splits them into
    # their own tokens), so `python -c "a;b"` is a single command, not a chain.
    if any(token in ("&&", ";", "||") for token in tokens):
        segments = [s.strip() for s in re.split(r"&&|(?<!\|)\|\||;", command) if s.strip()]
        if len(segments) < 2:
            segments = [command]
        subs = [classify_shell(segment) for segment in segments]
        for sub in subs:
            if not sub.allowed:
                return PolicyDecision(False, reason=f"Compound command rejected: {sub.reason}", risk=1.0)
        return PolicyDecision(
            True,
            requires_approval=any(sub.requires_approval for sub in subs),
            reason="compound command",
            argv=None,
            risk=max((sub.risk for sub in subs), default=0.4),
        )
    if "|" in tokens:
        return PolicyDecision(False, reason="Shell pipes are not permitted; run one command at a time.",
                              risk=0.8)
    if "$(" in command or "`" in command:
        return PolicyDecision(False, reason="Command substitution is not permitted.", risk=0.9)

    argv = tokens

    executable = argv[0].split("/")[-1]
    if executable not in ALLOWED_EXECUTABLES:
        return PolicyDecision(
            False,
            reason=f"Executable '{executable}' is not on the allowlist. "
                   f"Allowed: {', '.join(sorted(ALLOWED_EXECUTABLES))}",
            risk=0.9,
        )

    args = argv[1:]
    risk = 0.1

    if executable in SCRIPT_EXECUTABLES:
        if not args or args[0] not in ("-c",):
            return PolicyDecision(False, reason="bash/sh may only be used as `bash -c <command>`", risk=0.7)
        inner = classify_shell(" ".join(args[1:]))
        if not inner.allowed:
            return PolicyDecision(False, reason=f"Inner command rejected: {inner.reason}", risk=1.0)
        return PolicyDecision(True, requires_approval=True, reason="shell script execution", argv=argv,
                              risk=0.7)

    if executable == "git":
        sub = args[0] if args else ""
        if sub in GIT_APPROVAL_SUBCOMMANDS:
            return PolicyDecision(True, requires_approval=True, reason=f"git {sub} is gated", argv=argv,
                                  risk=0.75)
        if sub not in GIT_SAFE_SUBCOMMANDS:
            return PolicyDecision(False, reason=f"git subcommand '{sub}' is not permitted", argv=argv,
                                  risk=0.6)
        if sub == "config" and any(a.startswith("--global") for a in args):
            return PolicyDecision(False, reason="global git config changes are not permitted", argv=argv,
                                  risk=0.8)
        return PolicyDecision(True, argv=argv, reason="git read/write-local", risk=0.15)

    if executable in ("npm", "pnpm", "yarn", "npx"):
        sub = args[0] if args else ""
        if sub in PKG_APPROVAL_SUBCOMMANDS:
            return PolicyDecision(True, requires_approval=True, reason=f"{executable} {sub} is gated",
                                  argv=argv, risk=0.8)
        if sub and sub not in PKG_SAFE_SUBCOMMANDS:
            return PolicyDecision(False, reason=f"{executable} subcommand '{sub}' is not permitted",
                                  argv=argv, risk=0.6)
        return PolicyDecision(True, argv=argv, reason="package manager", risk=0.3 if sub == "install" else 0.15)

    if executable in ("pip", "pip3"):
        sub = args[0] if args else ""
        if sub not in PIP_SAFE_SUBCOMMANDS:
            return PolicyDecision(False, reason=f"pip subcommand '{sub}' is not permitted", argv=argv,
                                  risk=0.6)
        if sub == "install":
            unknown = [a for a in args[1:] if not a.startswith("-") and a.split("==")[0] not in TRUSTED_PACKAGES]
            if unknown:
                return PolicyDecision(
                    True,
                    requires_approval=True,
                    reason=f"installing untrusted package(s): {', '.join(unknown)}",
                    argv=argv,
                    risk=0.7,
                )
        return PolicyDecision(True, argv=argv, reason="pip", risk=0.2)

    if executable in ("python", "python3"):
        joined = " ".join(args)
        if any(flag in joined for flag in ("-c", "-m")):
            return PolicyDecision(True, argv=argv, reason="python inline/module execution", risk=0.45)
        return PolicyDecision(True, argv=argv, reason="python script execution", risk=0.4)

    return PolicyDecision(True, argv=argv, reason="read-only utility", risk=0.05)


FILE_TOOLS_REQUIRING_APPROVAL: frozenset[str] = frozenset({"delete_file"})


def classify_file_tool(tool: str, args: dict) -> PolicyDecision:
    if tool in FILE_TOOLS_REQUIRING_APPROVAL:
        return PolicyDecision(True, requires_approval=True, reason=f"{tool} is destructive", risk=0.6)
    return PolicyDecision(True, risk=0.05)


RISK_BY_TOOL: dict[str, float] = {
    "read_file": 0.02,
    "list_dir": 0.02,
    "workspace_tree": 0.02,
    "search_in_workspace": 0.05,
    "write_file": 0.2,
    "edit_file": 0.25,
    "create_dir": 0.1,
    "delete_file": 0.7,
    "run_shell": 0.5,
    "run_tests": 0.3,
    "git_status": 0.05,
    "git_diff": 0.05,
    "git_log": 0.05,
    "git_commit": 0.3,
    "git_branch": 0.3,
    "git_push": 0.9,
    "start_dev_server": 0.6,
    "stop_dev_server": 0.2,
    "knowledge_search": 0.05,
    "request_subtask": 0.1,
    "request_approval": 0.1,
}


def tool_risk(tool: str, decision: PolicyDecision | None = None) -> float:
    if decision is not None and decision.risk:
        return decision.risk
    return RISK_BY_TOOL.get(tool, 0.3)
