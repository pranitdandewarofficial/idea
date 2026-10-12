"""Deterministic plan heuristics.

Used in two places, and both are clearly labelled in the UI:

1. ``providers.mock`` — the offline test provider used by the automated suite.
2. ``orchestrator.planner`` — the *fallback* planner used when no AI provider is
   configured, so the product still does real work instead of failing closed.

A plan produced here is flagged ``heuristic=True`` and the run report states
that no language model was involved.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

BACKEND_HINTS = ("api", "backend", "server", "fastapi", "flask", "django", "rest", "database", "sql",
                 "endpoint", "crud", "auth", "authentication", "microservice", "python")
FRONTEND_HINTS = ("frontend", "front-end", "ui", "web app", "website", "react", "next", "vue", "svelte",
                  "dashboard", "landing", "page", "component", "html", "css", "tailwind", "client")
CLI_HINTS = ("cli", "command line", "script", "tool", "automation", "parser", "converter")
DATA_HINTS = ("etl", "pipeline", "scrape", "scraper", "dataset", "analytics", "report generator")

ALL_AGENTS = ("pm", "architect", "designer", "frontend", "backend", "qa", "security", "devops", "docs",
              "research")


def detect_surface(objective: str) -> dict[str, bool]:
    text = (objective or "").lower()
    return {
        "backend": any(h in text for h in BACKEND_HINTS),
        "frontend": any(h in text for h in FRONTEND_HINTS),
        "cli": any(h in text for h in CLI_HINTS),
        "data": any(h in text for h in DATA_HINTS),
    }


def _task(
    task_id: str,
    title: str,
    agent_id: str,
    description: str,
    *,
    depends_on: list[str] | None = None,
    outputs: list[str] | None = None,
    done_criteria: list[str] | None = None,
    verify_commands: list[str] | None = None,
    priority: int = 3,
    effort: int = 1,
) -> dict[str, Any]:
    return {
        "id": task_id,
        "title": title,
        "agent_id": agent_id,
        "description": description,
        "depends_on": depends_on or [],
        "outputs": outputs or [],
        "done_criteria": done_criteria or [],
        "verify_commands": verify_commands or [],
        "priority": priority,
        "effort": effort,
    }


def heuristic_plan(objective: str, available_agents: Iterable[str] | None = None) -> dict[str, Any]:
    """Build a dependency-aware plan from the objective using plain rules."""
    agents = set(available_agents or ALL_AGENTS)
    surface = detect_surface(objective)
    wants_backend = surface["backend"] or surface["data"] or surface["cli"]
    wants_frontend = surface["frontend"]
    if not wants_backend and not wants_frontend:
        # Nothing recognisable: default to a small full-stack slice.
        wants_backend = True
        wants_frontend = True

    name_hint = _project_name(objective)
    requirements = [
        f"Deliver a working {name_hint} that satisfies: {objective.strip()[:400]}",
        "Every file must be written to the project workspace by a tool call (no prose-only output).",
        "Automated tests must exist and must actually pass before delivery.",
        "A README must describe how to install, run and test the result.",
    ]
    acceptance = [
        "The project directory contains the implementation files listed in the plan outputs.",
        "`python -m pytest -q` (or the stack's equivalent) exits with code 0.",
        "README.md exists and its setup steps are accurate for a clean machine.",
        "No secrets are present in any generated file.",
    ]
    assumptions = [
        "Target runtime is Python 3.11+ unless the objective names another stack.",
        "Local-first delivery: no cloud deployment, no external accounts.",
        "Tests use pytest for Python projects.",
    ]

    tasks: list[dict[str, Any]] = []
    deps_of_impl: list[str] = []

    if "pm" in agents:
        tasks.append(_task(
            "t1", "Write requirements and acceptance criteria", "pm",
            "Turn the objective into a numbered requirement list with testable acceptance criteria. "
            "Write it to docs/requirements.md using the write_file tool.",
            outputs=["docs/requirements.md"],
            done_criteria=["docs/requirements.md exists", "it lists numbered requirements",
                           "it lists testable acceptance criteria"],
            verify_commands=["ls docs/requirements.md"],
            priority=1,
        ))
        deps_of_impl.append("t1")

    if "architect" in agents:
        tasks.append(_task(
            "t2", "Define architecture and module interfaces", "architect",
            "Choose the module layout, data models and interfaces. Write docs/architecture.md with the "
            "module list, the public functions/classes and their signatures, and the dependency choices.",
            depends_on=[d for d in deps_of_impl],
            outputs=["docs/architecture.md"],
            done_criteria=["docs/architecture.md exists", "it names every module to be implemented",
                           "it states the public interface of each module"],
            verify_commands=["ls docs/architecture.md"],
            priority=1,
        ))
        deps_of_impl = ["t2"]

    if wants_backend and "backend" in agents:
        tasks.append(_task(
            "t3", f"Implement the {name_hint} backend", "backend",
            "Implement the modules described in docs/architecture.md as real, importable Python files. "
            "Write the entry module to src/app.py with small, importable pure functions. "
            "Keep dependencies to the standard library so the project runs anywhere. "
            "Every file must be created with the write_file tool.",
            depends_on=list(deps_of_impl),
            outputs=["src/app.py"],
            done_criteria=["at least one importable module exists", "no syntax errors",
                           "public functions behave as documented"],
            verify_commands=["python -m compileall -q src"],
            priority=2, effort=3,
        ))
    if wants_frontend and "frontend" in agents:
        tasks.append(_task(
            "t4", f"Implement the {name_hint} frontend", "frontend",
            "Implement the client-side files described in docs/architecture.md. Plain HTML/CSS/JS is "
            "acceptable when no framework is requested. Every file must be created with the write_file tool.",
            depends_on=list(deps_of_impl),
            outputs=["web/index.html"],
            done_criteria=["web/index.html exists", "it is valid, self-contained HTML"],
            verify_commands=["ls web/index.html"],
            priority=3, effort=2,
        ))

    impl_ids = [t["id"] for t in tasks if t["agent_id"] in ("backend", "frontend")]

    if "qa" in agents:
        tasks.append(_task(
            "t5", "Write and run the test suite", "qa",
            "Write pytest tests to tests/test_app.py that import and exercise the implemented module "
            "(src/app.py), then run them with `python -m pytest -q` using the run_shell tool and report "
            "the raw output. Never claim a pass you did not observe.",
            depends_on=impl_ids or list(deps_of_impl),
            outputs=["tests/test_app.py"],
            done_criteria=["tests/ contains at least one test file",
                           "`python -m pytest -q` exits 0"],
            verify_commands=["python -m pytest -q"],
            priority=1, effort=2,
        ))

    if "security" in agents:
        tasks.append(_task(
            "t6", "Security review of the delivered code", "security",
            "Review the workspace for hardcoded secrets, injection risks, unsafe path handling and "
            "dangerous defaults. Write docs/security-review.md with findings ranked by severity.",
            depends_on=impl_ids or list(deps_of_impl),
            outputs=["docs/security-review.md"],
            done_criteria=["docs/security-review.md exists",
                           "no CRITICAL finding is left unaddressed"],
            verify_commands=["ls docs/security-review.md"],
            priority=2,
        ))

    if "devops" in agents:
        tasks.append(_task(
            "t7", "Provide reproducible run instructions", "devops",
            "Create the files needed to run the project locally: requirements.txt (or package manifest), "
            "a .env.example with no real secrets, and scripts/run.sh.",
            depends_on=impl_ids or list(deps_of_impl),
            outputs=["requirements.txt", ".env.example", "scripts/run.sh"],
            done_criteria=[".env.example exists and contains no real secret",
                           "the manifest lists every third-party import"],
            priority=3,
        ))

    if "docs" in agents:
        tasks.append(_task(
            "t8", "Write the README", "docs",
            "Write README.md covering what the project does, how to install, how to run, how to test, and "
            "the known limitations. Only describe features that actually exist in the workspace.",
            depends_on=impl_ids or list(deps_of_impl),
            outputs=["README.md"],
            done_criteria=["README.md exists", "it contains install, run and test sections"],
            verify_commands=["ls README.md"],
            priority=3,
        ))

    tail = [t["id"] for t in tasks if t["agent_id"] in ("qa", "security", "devops", "docs")]
    if "qa" in agents and tail:
        tasks.append(_task(
            "t9", "Final verification against acceptance criteria", "qa",
            "Re-run the full test suite and check every acceptance criterion one by one. Produce "
            "docs/verification.md mapping each criterion to the evidence (command + raw output) that "
            "proves it. Report honestly if any criterion is unmet.",
            depends_on=sorted(set(tail)),
            outputs=["docs/verification.md"],
            done_criteria=["docs/verification.md exists", "every acceptance criterion has evidence"],
            verify_commands=["python -m pytest -q"],
            priority=1, effort=2,
        ))

    return {
        "requirements": requirements,
        "acceptance_criteria": acceptance,
        "assumptions": assumptions,
        "tasks": tasks,
        "heuristic": True,
    }


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _project_name(objective: str) -> str:
    text = (objective or "").lower()
    for pattern in (r"build (?:a|an) ([a-z0-9 \-]{3,40})", r"create (?:a|an) ([a-z0-9 \-]{3,40})",
                    r"make (?:a|an) ([a-z0-9 \-]{3,40})"):
        match = re.search(pattern, text)
        if match:
            slug = _SLUG_RE.sub("-", match.group(1)).strip("-")
            if slug:
                return slug.split("-")[0] or "project"
    if any(h in text for h in ("api", "backend", "server")):
        return "api service"
    if any(h in text for h in ("site", "website", "landing", "dashboard")):
        return "web app"
    if any(h in text for h in ("cli", "script", "tool")):
        return "command line tool"
    return "project"
