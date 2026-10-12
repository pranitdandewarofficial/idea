"""Offline mock provider.

Used **only** for automated tests and for the explicitly-labelled offline demo
mode.  A run that used the mock provider is never reported as a real delivery:
``CompletionResult.mocked`` propagates into usage records, events and the final
report, and the UI shows a persistent banner.

The mock is deterministic: same prompt in, same text out.  It produces real tool
calls, so even in mock mode agents really write files to the workspace and the
verifier really executes the test suite.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..agents.profiles import WORKER_IDS
from ..planning import heuristic_plan
from ..protocol import (
    agent_marker,
    extract_json,
    is_decision_prompt,
    is_planner_prompt,
    parse_agent_marker,
)
from .base import Capabilities, CompletionResult, ProviderAdapter

PATH_RE = re.compile(
    r"(?<![\w/])([A-Za-z0-9_.\-/]+\.(?:md|py|txt|html|sh|json|css|js|ts|tsx|toml|ya?ml|cfg|example))(?![\w])"
)
OBJECTIVE_RE = re.compile(r"Objective:\s*(.+?)(?:\n\n|\Z)", re.DOTALL)

AGENT_IDS = WORKER_IDS  # single source of truth for the worker roster

#: noul questions where "true" means something is *wrong*.  A stub that answered
#: true to everything would report injection and hallucination on every run.
NEGATIVE_NOUL_QUESTIONS = frozenset({
    "contains_injection", "requests_destructive_action", "leaks_secrets", "outside_workspace",
    "hallucination_risk", "approval_required",
})


class MockAdapter(ProviderAdapter):
    kind = "mock"
    capabilities = Capabilities(
        supports_system_prompt=True,
        supports_json_mode=True,
        supports_tools=True,
        supports_streaming=False,
        supports_cancellation=True,
        max_context_tokens=8192,
        model_discovery=True,
    )

    async def test(self) -> tuple[bool, str, float]:
        return (
            True,
            "Offline mock provider responded locally (0 network calls, 0 cost). "
            "Runs using it are marked as mock and are never reported as real deliveries.",
            0.1,
        )

    async def list_models(self) -> list[str]:
        return ["mock-planner", "mock-agent"]

    async def complete(
        self,
        *,
        model: str | None,
        system: str,
        user: str,
        max_tokens: int = 1024,
        temperature: float = 0.3,
        timeout: float | None = None,
    ) -> CompletionResult:
        text = self._respond(system, user)
        return CompletionResult(
            text=text,
            model=model or "mock-agent",
            tokens_in=len(user) // 4,
            tokens_out=len(text) // 4,
            latency_ms=0.5,
            finish_reason="stop",
            raw={"mock": True},
            mocked=True,
            provider_id=self.provider_id,
            provider_kind=self.kind,
        )

    # -- response generation ------------------------------------------------ #
    def _respond(self, system: str, user: str) -> str:
        if is_planner_prompt(system):
            return self._plan_response(user)
        if is_decision_prompt(system):
            return self._decision_response(user)
        agent_id = parse_agent_marker(system) or "docs"
        return self._agent_response(agent_id, user)

    def _plan_response(self, user: str) -> str:
        match = OBJECTIVE_RE.search(user)
        objective = match.group(1).strip() if match else user.strip()
        plan = heuristic_plan(objective, AGENT_IDS)
        return json.dumps(plan, indent=2)

    def _decision_response(self, user: str) -> str:
        payload = extract_json(user) or {}
        questions = payload.get("questions") if isinstance(payload, dict) else {}
        answers: dict[str, Any] = {}
        for qid, question in (questions or {}).items():
            qtype = question.get("type") if isinstance(question, dict) else "noul"
            if qtype == "choice":
                criteria = question.get("criteria") or {}
                labels = list(criteria.keys()) if isinstance(criteria, dict) else list(criteria)
                answers[qid] = labels[0] if labels else None
            elif qtype == "score":
                rubric = question.get("criteria") or []
                answers[qid] = rubric[min(2, len(rubric) - 1)] if rubric else None
            else:
                answers[qid] = qid not in NEGATIVE_NOUL_QUESTIONS
        return json.dumps({"answers": answers})

    def _agent_response(self, agent_id: str, user: str) -> str:
        rounds = user.count("Tool results:")
        title = _section(user, "Task") or "assigned work"
        description = _section(user, "Details") or ""
        listing = _section(user, "Tool results") or ""

        if agent_id == "qa":
            # The runtime replaces the conversation each round, so the round index
            # cannot be counted from the prompt.  Decide from what already happened:
            # no results yet -> look at the workspace; a test run already reported ->
            # summarise it; otherwise write the tests and run them.
            if "run_tests" in listing or "run_shell" in listing:
                return self._qa_final(title, listing)
            if not listing:
                return _tool_block("workspace_tree", {"path": "."})
            return self._qa_round_two(title, listing)

        if rounds == 0:
            paths = self._target_paths(agent_id, user, description)
            if not paths:
                return f"FINAL: {title} — no file output was required for this task."
            blocks = [_tool_block("write_file", {"path": p, "content": _content_for(p, title, description)})
                      for p in paths[:3]]
            return "\n\n".join(blocks)

        return (
            f"FINAL: Completed '{title}'. Files written to the workspace as requested; "
            f"outputs were created with the write_file tool and can be inspected in the project tree."
        )

    def _qa_round_two(self, title: str, listing: str) -> str:
        has_src = bool(re.search(r"src/app\.py|(?<![\w.])src/", listing)) or "'src'" in listing
        if has_src:
            test_code = (
                '"""Tests generated by the QA agent."""\n'
                "import pathlib\nimport sys\n\n"
                "ROOT = pathlib.Path(__file__).resolve().parents[1]\n"
                'sys.path.insert(0, str(ROOT / "src"))\n\n'
                "from app import add, health  # noqa: E402\n\n\n"
                "def test_health_reports_ok():\n"
                '    assert health()["status"] == "ok"\n\n\n'
                "def test_add_is_correct():\n"
                "    assert add(2, 3) == 5\n"
                "    assert add(-1, 1) == 0\n"
            )
            paths = {"tests/test_app.py": test_code}
        else:
            test_code = (
                '"""Workspace structure tests generated by the QA agent."""\n'
                "import pathlib\n\n"
                "ROOT = pathlib.Path(__file__).resolve().parents[1]\n\n\n"
                "def test_workspace_is_not_empty():\n"
                "    entries = [p for p in ROOT.iterdir() if p.name not in {'.git', '__pycache__'}]\n"
                "    assert entries, 'workspace is empty'\n\n\n"
                "def test_some_documentation_exists():\n"
                "    docs = list(ROOT.rglob('*.md'))\n"
                "    assert docs, 'no markdown documentation was produced'\n"
            )
            paths = {"tests/test_workspace.py": test_code}

        writes = "\n\n".join(_tool_block("write_file", {"path": p, "content": c}) for p, c in paths.items())
        return writes + "\n\n" + _tool_block("run_shell", {"command": "python -m pytest -q"})

    def _qa_final(self, title: str, listing: str) -> str:
        """Quote the pytest output that was really produced in the previous round."""
        ran = "run_tests" in listing or "run_shell" in listing
        passed = bool(re.search(r"run_(?:tests|shell) \[ok\]", listing)) and "'code': 0" in listing
        if not ran:
            passed = False
        raw = (listing or "(no command output was captured)").strip()[:1500]
        return (
            f"FINAL: {title}\n"
            f"passed: {'true' if passed else 'false'}\n"
            "Executed `python -m pytest -q` inside the project workspace with the run_shell tool.\n"
            "raw_output:\n"
            f"```\n{raw}\n```\n"
            + (
                "Findings: every executed test passed; the summary line above is the evidence."
                if passed
                else "Findings: the suite did not pass - the raw output above shows the failures."
            )
        )

    def _target_paths(self, agent_id: str, user: str, description: str) -> list[str]:
        found: list[str] = []
        for source in (_section(user, "Expected outputs"), description, user):
            for match in PATH_RE.findall(source or ""):
                cleaned = match.strip("./")
                if cleaned and cleaned not in found and not cleaned.startswith("/"):
                    found.append(cleaned)
            if found:
                break
        if found:
            return [p for p in found if not p.endswith("/")][:3]
        fallback = {
            "pm": "docs/requirements.md",
            "architect": "docs/architecture.md",
            "designer": "docs/design.md",
            "backend": "src/app.py",
            "frontend": "web/index.html",
            "security": "docs/security-review.md",
            "devops": "scripts/run.sh",
            "docs": "README.md",
            "research": "docs/research.md",
        }
        return [fallback[agent_id]] if agent_id in fallback else []


def _tool_block(tool: str, args: dict[str, Any]) -> str:
    return "```tool\n" + json.dumps({"tool": tool, "args": args}, ensure_ascii=False) + "\n```"


def _section(text: str, label: str) -> str:
    pattern = re.compile(rf"^{re.escape(label)}:\s*(.*?)(?=\n[A-Z][A-Za-z ]+:\s|\Z)", re.DOTALL | re.MULTILINE)
    match = pattern.search(text or "")
    return match.group(1).strip() if match else ""


def _content_for(path: str, title: str, description: str) -> str:
    lowered = path.lower()
    if lowered.endswith(".py") and "test" not in lowered:
        module = _module_docstring(path)
        return (
            f'"""{module} — generated for: {title}."""\n\n\n'
            "def health() -> dict:\n"
            '    """Liveness probe."""\n'
            f'    return {{"status": "ok", "module": "{module}"}}\n\n\n'
            "def add(left: float, right: float) -> float:\n"
            '    """Return the sum of two numbers."""\n'
            "    return left + right\n"
        )
    if lowered.endswith(".html"):
        return (
            "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n"
            f"<title>{title}</title>\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n"
            "</head>\n<body>\n<main>\n"
            f"<h1>{title}</h1>\n<p>Generated by PRANIT AI CITY.</p>\n"
            "</main>\n</body>\n</html>\n"
        )
    if lowered.endswith(".sh"):
        return (
            "#!/usr/bin/env bash\nset -euo pipefail\n"
            f"# {title}\ncd \"$(dirname \"$0\")/..\"\n"
            'python -m pytest -q\n'
        )
    if lowered.endswith(".example"):
        return (
            f"# {title}\n# Copy to .env and fill in real values. Never commit the real file.\n"
            "APP_ENV=local\nAPP_SECRET_KEY=change-me\n"
        )
    if lowered.endswith((".txt", ".toml", ".cfg")):
        return f"# {title}\n# Generated dependency manifest.\n"
    if lowered.endswith(".json"):
        return json.dumps({"name": path, "generated_by": "pranit-ai-city", "task": title}, indent=2) + "\n"
    return (
        f"# {title}\n\n"
        f"{description or 'Generated by PRANIT AI CITY.'}\n\n"
        "## Summary\n\n"
        "- Produced by the assigned agent through the sandboxed `write_file` tool.\n"
        "- Inspect the file tree in the Projects area to see the real artifact.\n\n"
        "## Status\n\n"
        "This file exists on disk in the project workspace.\n"
    )


def _module_docstring(path: str) -> str:
    return path.rsplit("/", 1)[-1].replace(".py", "").replace("-", "_")


def make_marker(agent_id: str) -> str:  # pragma: no cover - convenience re-export
    return agent_marker(agent_id)
