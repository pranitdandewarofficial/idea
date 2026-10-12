"""The Orchestrator — exactly one authoritative coordination loop.

State machine (Part 3.1 of the master plan)::

    RECEIVED -> CLARIFYING -> PLANNING -> SCHEDULING -> EXECUTING
      EXECUTING -> REPAIRING -> EXECUTING
      EXECUTING -> VERIFYING -> INTEGRATING -> REVIEWING -> DELIVERING -> COMPLETE
      any -> BLOCKED / PAUSED / CANCELLED / FAILED

Agents never schedule work.  They may *request* a subtask; only this module can
add one, and only within a hard bound.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..agents.profiles import PROFILE_MAP, PROFILES, WORKER_IDS
from ..agents.runtime import run_task
from ..city import BUILDING_BY_DEPARTMENT, seat_for
from ..config import settings
from ..db import session_scope
from ..decisions import presets
from ..decisions.service import service as decisions
from ..events import bus
from ..memory import store as memory
from ..models import Agent, AuditRecord, Plan, Project, Task, UsageRecord, get_setting, now
from ..providers.base import ProviderError
from ..providers.registry import providers
from ..tools import vcs
from ..tools.context import ToolContext
from ..tools.registry import executor
from ..tools.servers import servers
from . import budget as budget_guard
from . import checkpoints, repair, reporter, scheduler
from .approvals import gate
from .planner import generate_plan, validate_plan
from .verifier import scan_for_secrets, summarise, verify_acceptance, verify_task

log = logging.getLogger("pranit.orchestrator")

MAX_NET_NEW_TASKS_PER_PLAN = 5
_SLUG = re.compile(r"[^a-z0-9]+")


@dataclass
class RunHandle:
    plan_id: str
    project_id: str
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    pause_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    inflight: dict[str, asyncio.Task] = field(default_factory=dict)
    net_new_tasks: int = 0
    started_at: float = field(default_factory=time.monotonic)


def _task_dict(row: Task) -> dict[str, Any]:
    return {
        "id": row.id,
        "external_id": row.external_id,
        "plan_id": row.plan_id,
        "project_id": row.project_id,
        "title": row.title,
        "description": row.description,
        "agent_id": row.agent_id,
        "status": row.status,
        "depends_on": list(row.depends_on or []),
        "outputs": list(row.outputs or []),
        "done_criteria": list(row.done_criteria or []),
        "verify_commands": list(row.verify_commands or []),
        "priority": row.priority,
        "effort": row.effort,
        "order_index": row.order_index,
        "budget_tokens": row.budget_tokens,
        "retries": row.retries,
        "result": row.result,
        "summary": row.summary,
        "files_changed": list(row.files_changed or []),
        "error": row.error,
        "verification": dict(row.verification or {}),
    }


def _agent_dict(row: Agent) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "role": row.role,
        "department": row.department,
        "personality": row.personality,
        "responsibilities": list(row.responsibilities or []),
        "status": row.status,
        "current_task_id": row.current_task_id,
        "model_role": row.model_role,
        "model": row.model,
        "provider_id": row.provider_id,
        "tools": list(row.tools or []),
        "skills": list(row.skills or []),
        "is_enabled": row.is_enabled,
        "max_parallel_tasks": row.max_parallel_tasks,
        "avatar_seed": row.avatar_seed,
        "city_x": row.city_x,
        "city_y": row.city_y,
        "home_x": row.home_x,
        "home_y": row.home_y,
    }


def slugify(name: str, fallback: str = "project") -> str:
    slug = _SLUG.sub("-", (name or "").lower()).strip("-")
    return (slug or fallback)[:48]


class Orchestrator:
    def __init__(self) -> None:
        self.runs: dict[str, RunHandle] = {}

    # ------------------------------------------------------------------ #
    # bootstrap
    # ------------------------------------------------------------------ #
    async def ensure_agents(self) -> list[dict[str, Any]]:
        seats_taken: dict[str, int] = {}
        with session_scope() as s:
            rows = {row.id: row for row in s.query(Agent).all()}
            for profile in PROFILES:
                building = BUILDING_BY_DEPARTMENT.get(profile.department)
                building_id = building.id if building else "collaboration-hub"
                index = seats_taken.get(building_id, 0)
                seats_taken[building_id] = index + 1
                home_x, home_y = seat_for(profile.id, profile.department, index)
                row = rows.get(profile.id)
                if row is None:
                    row = Agent(id=profile.id, avatar_seed=f"{profile.id}-{profile.name.lower()}")
                    s.add(row)
                row.name = profile.name
                row.role = profile.role
                row.department = profile.department
                row.personality = profile.personality
                row.responsibilities = list(profile.responsibilities)
                row.prohibited = list(profile.prohibited)
                row.skills = list(profile.skills)
                row.tools = list(profile.tools)
                row.model_role = profile.model_role
                row.memory_namespace = profile.memory_namespace
                row.max_parallel_tasks = profile.max_parallel_tasks
                row.temperature = profile.temperature
                row.max_tokens = profile.max_tokens
                row.home_x, row.home_y = home_x, home_y
                if row.status in ("", None):
                    row.status = "idle"
                if not row.city_x and not row.city_y:
                    row.city_x, row.city_y = home_x, home_y
            s.flush()
            return [_agent_dict(row) for row in s.query(Agent).all()]

    def wire(self) -> None:
        """Connect the approval gate, audit hook and event triage."""
        executor.register_approval_resolver(gate.resolve_tool_call)
        executor.register_audit_hook(_audit_tool_call)
        from ..decisions.router import router
        from ..decisions.llm_fallback import llm_fallback

        router.register_llm_fallback(llm_fallback)

    # ------------------------------------------------------------------ #
    # objective intake
    # ------------------------------------------------------------------ #
    async def submit_objective(
        self,
        objective: str,
        *,
        project_name: str | None = None,
        spend_authorized: bool = False,
        auto_start: bool = True,
    ) -> dict[str, Any]:
        objective = (objective or "").strip()
        if len(objective) < 3:
            raise ValueError("An objective needs at least 3 characters.")

        await self.ensure_agents()
        name = slugify(project_name or _derive_name(objective))
        root = _unique_workspace(name)
        root.mkdir(parents=True, exist_ok=True)

        with session_scope() as s:
            project = Project(name=root.name, objective=objective, workspace_path=str(root),
                              status="planning")
            s.add(project)
            s.flush()
            project_id = project.id

        await vcs.ensure_repo(ToolContext(root=root, project_id=project_id))
        await bus.emit("objective.received", objective=objective, project_id=project_id,
                       workspace=str(root))

        # --- sufficiency assessment (System 1) ----------------------------- #
        sufficiency = await decisions.decide(
            presets.plan_validation(
                {"objective": objective, "tasks": []},
                {"ok": True, "actionable_ratio": _specificity(objective), "coverage_ratio": 1.0,
                 "estimated_tokens": 0, "token_budget": 1},
            )
        )
        specific_enough = sufficiency.prob("all_tasks_actionable", 0.5) >= 0.5
        assumptions: list[str] = []
        clarifications: list[str] = []
        if not specific_enough:
            clarifications = _clarifying_questions(objective)
            assumptions = _default_assumptions(objective)
            await bus.emit(
                "objective.clarification_requested",
                project_id=project_id,
                questions=clarifications,
                assumptions=assumptions,
                detail="The objective is underspecified. Stated assumptions are recorded and the run "
                       "continues; correct them and re-submit for a different plan.",
            )
        if assumptions:
            await bus.emit("objective.assumptions_stated", project_id=project_id, assumptions=assumptions)

        # --- provider selection ------------------------------------------- #
        provider_id: str | None = None
        model: str | None = None
        provider_error = ""
        try:
            provider_id, model = providers.pick(role="reasoning", spend_authorized=spend_authorized)
        except ProviderError as exc:
            provider_error = exc.message
            await bus.emit("planner.no_provider", project_id=project_id, reason=exc.message)

        await bus.emit("plan.thinking", project_id=project_id, provider_id=provider_id)
        plan_data, meta = await generate_plan(
            objective,
            provider_id=provider_id,
            model=model,
            spend_authorized=spend_authorized,
            available_agents=_enabled_worker_ids(),
        )
        plan_data["assumptions"] = sorted(set((plan_data.get("assumptions") or []) + assumptions))
        plan_data["clarifying_questions"] = clarifications

        facts = validate_plan(plan_data)
        with session_scope() as s:
            plan = Plan(
                project_id=project_id,
                objective=objective,
                requirements=plan_data.get("requirements", []),
                acceptance_criteria=plan_data.get("acceptance_criteria", []),
                assumptions=plan_data.get("assumptions", []),
                clarifying_questions=clarifications,
                state="draft",
                dag={"tasks": plan_data["tasks"]},
                produced_by="ceo",
                heuristic=bool(meta.get("heuristic")),
                validation=facts,
                spend_authorized=bool(spend_authorized),
                weight_total=sum(int(t.get("effort") or 1) for t in plan_data["tasks"]),
            )
            s.add(plan)
            s.flush()
            plan_id = plan.id

            id_map: dict[str, str] = {}
            for index, item in enumerate(plan_data["tasks"]):
                task = Task(
                    plan_id=plan_id,
                    project_id=project_id,
                    external_id=item["id"],
                    title=item["title"],
                    description=item["description"],
                    agent_id=item["agent_id"],
                    status="pending",
                    depends_on=[],
                    outputs=item.get("outputs", []),
                    done_criteria=item.get("done_criteria", []),
                    verify_commands=item.get("verify_commands", []),
                    priority=int(item.get("priority") or 3),
                    effort=int(item.get("effort") or 1),
                    order_index=index,
                    budget_tokens=int(get_setting("task_token_budget", 8000)),
                    timeout_seconds=int(get_setting("task_timeout_seconds", settings.task_timeout_seconds)),
                )
                s.add(task)
                s.flush()
                id_map[item["id"]] = task.id
            for task in s.query(Task).filter(Task.plan_id == plan_id).all():
                raw = next((t for t in plan_data["tasks"] if id_map.get(t["id"]) == task.id), None)
                if raw:
                    task.depends_on = [id_map[d] for d in raw.get("depends_on", []) if d in id_map]

        await bus.emit(
            "plan.created",
            plan_id=plan_id,
            project_id=project_id,
            task_count=len(plan_data["tasks"]),
            source=meta.get("source"),
            heuristic=bool(meta.get("heuristic")),
            reason=meta.get("reason", ""),
            provider_error=provider_error,
            requirements=plan_data.get("requirements", []),
            acceptance_criteria=plan_data.get("acceptance_criteria", []),
        )

        if not facts["ok"]:
            self._set_plan_state(plan_id, "failed", failure_reason="; ".join(facts["errors"][:5]))
            await bus.emit("plan.rejected", plan_id=plan_id, errors=facts["errors"][:10])
            return {"project_id": project_id, "plan_id": plan_id, "state": "failed",
                    "errors": facts["errors"], "meta": meta}

        await bus.emit("plan.validated", plan_id=plan_id, facts=facts)
        self._set_plan_state(plan_id, "scheduled")

        if auto_start:
            await self.start(plan_id)
        return {
            "project_id": project_id,
            "plan_id": plan_id,
            "state": "scheduled",
            "task_count": len(plan_data["tasks"]),
            "meta": meta,
            "validation": facts,
            "workspace": str(root),
        }

    # ------------------------------------------------------------------ #
    # run control
    # ------------------------------------------------------------------ #
    async def start(self, plan_id: str) -> dict[str, Any]:
        handle = self.runs.get(plan_id)
        if handle is not None and handle.task is not None and not handle.task.done():
            if handle.pause_event.is_set():
                handle.pause_event.clear()
                self._set_plan_state(plan_id, "executing")
                await bus.emit("plan.resumed", plan_id=plan_id)
            return {"plan_id": plan_id, "state": "running", "already_running": True}

        with session_scope() as s:
            plan = s.get(Plan, plan_id)
            if plan is None:
                raise LookupError(f"Plan '{plan_id}' does not exist.")
            project_id = plan.project_id
            plan.state = "executing"
            plan.started_at = plan.started_at or now()
            plan.failure_reason = None

        handle = RunHandle(plan_id=plan_id, project_id=project_id)
        self.runs[plan_id] = handle
        budget_guard.budget.start(plan_id)
        handle.task = asyncio.create_task(self._run(handle), name=f"plan:{plan_id}")
        await bus.emit("plan.started", plan_id=plan_id, project_id=project_id)
        return {"plan_id": plan_id, "state": "executing", "already_running": False}

    async def pause(self, plan_id: str) -> dict[str, Any]:
        handle = self.runs.get(plan_id)
        if handle is None:
            self._set_plan_state(plan_id, "paused")
            return {"plan_id": plan_id, "state": "paused", "note": "no active run; state marked paused"}
        handle.pause_event.set()
        return {"plan_id": plan_id, "state": "pausing"}

    async def resume(self, plan_id: str) -> dict[str, Any]:
        return await self.start(plan_id)

    async def cancel(self, plan_id: str) -> dict[str, Any]:
        handle = self.runs.get(plan_id)
        if handle is None:
            with session_scope() as s:
                plan = s.get(Plan, plan_id)
                if plan is None:
                    raise LookupError(f"Plan '{plan_id}' does not exist.")
                for task in s.query(Task).filter(Task.plan_id == plan_id).all():
                    if task.status not in ("completed", "cancelled"):
                        task.status = "cancelled"
                plan.state = "cancelled"
                plan.finished_at = now()
            await bus.emit("plan.cancelled", plan_id=plan_id, detail="cancelled while not running")
            return {"plan_id": plan_id, "state": "cancelled"}

        handle.cancel_event.set()
        handle.pause_event.clear()
        for task_id, running in list(handle.inflight.items()):
            running.cancel()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and handle.inflight:
            await asyncio.sleep(0.1)
        with session_scope() as s:
            for task in s.query(Task).filter(Task.plan_id == plan_id).all():
                if task.status in ("pending", "ready", "running", "repairing", "blocked", "timeout"):
                    task.status = "cancelled"
            plan = s.get(Plan, plan_id)
            if plan is not None:
                plan.state = "cancelled"
                plan.finished_at = now()
            for agent in s.query(Agent).all():
                if agent.status not in ("idle",):
                    agent.status = "idle"
                    agent.current_task_id = None
        self.runs.pop(plan_id, None)
        await bus.emit("plan.cancelled", plan_id=plan_id, detail="cancelled by the founder")
        return {"plan_id": plan_id, "state": "cancelled"}

    # ------------------------------------------------------------------ #
    # the loop
    # ------------------------------------------------------------------ #
    async def _run(self, handle: RunHandle) -> None:
        plan_id = handle.plan_id
        try:
            with session_scope() as s:
                plan = s.get(Plan, plan_id)
                project = s.get(Project, plan.project_id) if plan else None
                if plan is None or project is None:
                    return
                root = Path(project.workspace_path)
                project_id = project.id
                objective = plan.objective
                acceptance = list(plan.acceptance_criteria or [])
                spend_authorized = bool(plan.spend_authorized)

            while True:
                if handle.cancel_event.is_set():
                    break
                if handle.pause_event.is_set():
                    with session_scope() as s:
                        current = s.get(Plan, plan_id)
                        current_state = current.state if current else "paused"
                    if current_state != "blocked":
                        # "blocked" carries a failure_reason the founder needs to see;
                        # downgrading it to "paused" would hide why nothing is moving.
                        self._set_plan_state(plan_id, "paused")
                        await bus.emit("plan.paused", plan_id=plan_id)
                    while handle.pause_event.is_set() and not handle.cancel_event.is_set():
                        await asyncio.sleep(0.25)
                    if handle.cancel_event.is_set():
                        break
                    self._set_plan_state(plan_id, "executing")
                    await bus.emit("plan.resumed", plan_id=plan_id)

                tasks = self._load_tasks(plan_id)
                state = budget_guard.budget.snapshot(plan_id)
                if not state.ok:
                    await bus.emit("budget.exceeded", plan_id=plan_id, **state.as_dict())
                    self._set_plan_state(plan_id, "blocked", failure_reason=state.reason)
                    await self._request_budget_approval(plan_id, state.reason)
                    handle.pause_event.set()
                    continue
                if budget_guard.budget.warning_threshold(state):
                    await bus.emit("budget.warning", plan_id=plan_id, **state.as_dict())

                active = [t for t in tasks if t["status"] in ("running", "repairing")]
                if not any(t["status"] in ("pending", "ready") for t in tasks) and not active:
                    break

                max_concurrency = int(get_setting("max_concurrency", settings.max_concurrency))
                load: dict[str, int] = {}
                for task in active:
                    if task.get("agent_id"):
                        load[task["agent_id"]] = load.get(task["agent_id"], 0) + 1
                ready = scheduler.ready_tasks(
                    tasks,
                    running_agent_load=load,
                    max_tasks_per_agent=int(get_setting("max_tasks_per_agent", settings.max_tasks_per_agent)),
                    max_concurrency=max_concurrency,
                )
                for task in ready:
                    if handle.cancel_event.is_set():
                        break
                    task_id = task["id"]
                    if task_id in handle.inflight:
                        continue
                    await self._route_task(task, plan_id=plan_id, load=load)
                    with session_scope() as s:
                        row = s.get(Task, task_id)
                        if row is not None:
                            row.status = "ready"
                    coroutine = self._execute_task(
                        handle, plan_id=plan_id, project_id=project_id, task_id=task_id, root=root,
                        objective=objective, acceptance=acceptance, spend_authorized=spend_authorized,
                    )
                    handle.inflight[task_id] = asyncio.create_task(coroutine, name=f"task:{task_id}")

                if not handle.inflight:
                    deadlocked, reason = scheduler.is_deadlocked(tasks)
                    if deadlocked:
                        self._set_plan_state(plan_id, "blocked", failure_reason=reason)
                        await bus.emit("plan.blocked", plan_id=plan_id, reason=reason)
                        handle.pause_event.set()
                        continue
                    await asyncio.sleep(0.2)
                    continue

                await asyncio.wait(set(handle.inflight.values()), return_when=asyncio.FIRST_COMPLETED)
                for task_id in [k for k, v in handle.inflight.items() if v.done()]:
                    future = handle.inflight.pop(task_id)
                    if future.cancelled():
                        continue
                    exception = future.exception()
                    if exception is not None:
                        log.exception("task %s raised", task_id, exc_info=exception)
                        await bus.emit("task.failed", task_id=task_id, plan_id=plan_id,
                                       error=f"{type(exception).__name__}: {exception}")
                    await checkpoints.save(plan_id, reason=f"task:{task_id}")
                    self._update_progress(plan_id)
        except asyncio.CancelledError:
            await bus.emit("plan.cancelled", plan_id=plan_id, detail="run coroutine cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 - the run must never die silently
            log.exception("plan %s crashed", plan_id)
            self._set_plan_state(plan_id, "failed", failure_reason=f"{type(exc).__name__}: {exc}")
            await bus.emit("plan.failed", plan_id=plan_id, error=f"{type(exc).__name__}: {exc}")
            return

        if handle.cancel_event.is_set():
            return
        await self._finish(handle, plan_id, project_id, root, objective, acceptance)

    async def _route_task(
        self, task: dict[str, Any], *, plan_id: str, load: dict[str, int]
    ) -> str | None:
        """System-1 confirmation of the planner's agent choice.

        The planner assigns an owner while it writes the DAG.  Before the task is
        dispatched the decision layer re-answers "who should own this?" from the
        task text and the live roster.  A *confident* disagreement overrides the
        planner; anything below the threshold keeps the planner's choice and is
        recorded as an escalation (with an LLM second opinion when one is
        available).  Every call persists a DecisionRecord, so the UI timeline shows
        real System 1 / System 2 activity.
        """
        if not decisions.enabled:
            return None
        try:
            with session_scope() as s:
                roster = [_agent_dict(row) for row in s.query(Agent).all()]
        except Exception as exc:  # pragma: no cover - db not ready
            log.warning("routing roster unavailable: %s", exc)
            return None
        candidates = [
            {**agent, "load": load.get(agent["id"], 0)}
            for agent in roster
            if agent["id"] != "ceo"
            and agent["is_enabled"]
            and not (PROFILE_MAP.get(agent["id"]) and PROFILE_MAP[agent["id"]].is_decision_agent)
        ]
        if len(candidates) < 2:
            return None
        request = presets.routing({**task, "plan_id": plan_id}, candidates)
        result = await decisions.decide(request)
        chosen = result.value("assigned_agent")
        planner_choice = task.get("agent_id")
        override = (
            chosen is not None
            and chosen != planner_choice
            and result.action == "auto"
            and chosen in {c["id"] for c in candidates}
        )
        if override:
            with session_scope() as s:
                row = s.get(Task, task["id"])
                if row is not None:
                    row.agent_id = str(chosen)
            task["agent_id"] = str(chosen)
            await bus.emit(
                "decision.routing.override",
                plan_id=plan_id,
                task_id=task["id"],
                from_agent=planner_choice,
                to_agent=chosen,
                confidence=result.confidence,
                engine=result.engine,
                fallback_used=result.fallback_used,
                latency_ms=result.latency_ms,
            )
        else:
            await bus.emit(
                "decision.routing.confirmed",
                plan_id=plan_id,
                task_id=task["id"],
                agent_id=planner_choice,
                suggestion=chosen,
                confidence=result.confidence,
                action=result.action,
                engine=result.engine,
                fallback_used=result.fallback_used,
                latency_ms=result.latency_ms,
            )
        return str(chosen) if override else None

    async def _request_budget_approval(self, plan_id: str, reason: str) -> None:
        approved = await gate.request(
            action="budget.increase",
            detail={"reason": reason, "plan_id": plan_id},
            risk=0.5,
            plan_id=plan_id,
            requested_by="orchestrator",
        )
        if approved:
            with session_scope() as s:
                from ..models import set_setting

                current = int(get_setting("plan_token_budget", settings.plan_token_budget))
                set_setting("plan_token_budget", current * 2)
            await bus.emit("budget.raised", plan_id=plan_id, reason="founder approved a larger budget")

    # ------------------------------------------------------------------ #
    # one task
    # ------------------------------------------------------------------ #
    async def _execute_task(
        self,
        handle: RunHandle,
        *,
        plan_id: str,
        project_id: str,
        task_id: str,
        root: Path,
        objective: str,
        acceptance: list[str],
        spend_authorized: bool,
    ) -> None:
        with session_scope() as s:
            row = s.get(Task, task_id)
            if row is None:
                return
            task = _task_dict(row)
            plan = s.get(Plan, plan_id)
            plan_heuristic = bool(plan.heuristic) if plan else False

        profile = PROFILE_MAP.get(task["agent_id"] or "")
        if profile is None:
            self._fail_task(task_id, f"No agent profile for '{task['agent_id']}'.", plan_id)
            return

        await self._set_agent_state(profile.id, "working", task_id, target="work")
        with session_scope() as s:
            row = s.get(Task, task_id)
            if row is not None:
                row.status = "running"
                row.started_at = row.started_at or now()
        await bus.emit("task.started", task_id=task_id, plan_id=plan_id, project_id=project_id,
                       agent_id=profile.id, title=task["title"], external_id=task["external_id"])

        ctx = ToolContext(
            root=root,
            project_id=project_id,
            plan_id=plan_id,
            task_id=task_id,
            agent_id=profile.id,
            sandbox_tier=int(get_setting("sandbox_tier", settings.sandbox_tier)),
            timeout_seconds=int(get_setting("shell_timeout_seconds", settings.shell_timeout_seconds)),
            docker_image=settings.docker_image,
        )

        dependencies = self._dependency_outputs(plan_id, task)
        provider_id, model = self._resolve_provider(profile, spend_authorized)

        attempt = int(task["retries"]) + 1
        repair_context = task["error"] if attempt > 1 else None
        result = None
        error = ""

        if provider_id is None:
            error = (
                "No usable AI provider for this agent. Add a provider (Ollama for local/free) or enable "
                "the offline mock provider for a labelled dry run."
            )
        else:
            try:
                result = await asyncio.wait_for(
                    run_task(
                        profile=profile,
                        task=task,
                        ctx=ctx,
                        provider_id=provider_id,
                        model=model,
                        spend_authorized=spend_authorized,
                        objective=objective,
                        acceptance_criteria=acceptance,
                        dependencies=dependencies,
                        repair_context=repair_context,
                        attempt=attempt,
                    ),
                    timeout=int(task.get("timeout_seconds") or settings.task_timeout_seconds),
                )
            except asyncio.TimeoutError:
                error = f"Task exceeded its {task.get('timeout_seconds')}s wall-clock limit."
                with session_scope() as s:
                    row = s.get(Task, task_id)
                    if row is not None:
                        row.status = "timeout"
                await bus.emit("task.timeout", task_id=task_id, plan_id=plan_id, agent_id=profile.id,
                               error=error)
            except ProviderError as exc:
                error = exc.message
                await bus.emit("provider.error", task_id=task_id, plan_id=plan_id, code=exc.code,
                               error=exc.message)
            except Exception as exc:  # noqa: BLE001
                error = f"{type(exc).__name__}: {exc}"
                log.exception("task %s failed", task_id)

        if result is not None:
            with session_scope() as s:
                usage_rows = s.query(UsageRecord).filter(UsageRecord.task_id == task_id).all()
                used_tokens = sum(r.tokens_in + r.tokens_out for r in usage_rows)
                used_cost = sum(r.cost_estimate for r in usage_rows)
            budget_guard.budget.add_usage(plan_id, used_tokens, used_cost)
            error = error or result.error

        # --- verification against the task's own done-criteria -------------- #
        verification: dict[str, Any] = {"verified": None, "checks": [], "reason": ""}
        if result is not None and result.ok:
            verification = await verify_task(ctx, task)
            if verification.get("verified") is False:
                error = "Verification failed: " + verification.get("reason", "")

        # --- System-1 output quality gate ---------------------------------- #
        quality: dict[str, Any] = {}
        if result is not None and not error:
            files = list(result.files_changed)
            verified = verification.get("verified")
            coverage = _criteria_coverage(task, result.summary, files)
            # Hard evidence dominates: a task whose verify commands really exited 0
            # and whose files really exist has met its criteria no matter how the
            # agent worded its summary.  Text overlap only breaks ties - judging on
            # wording alone made the gate reject honest, verified work.
            evidence = 0.0
            if verified is True:
                evidence += 0.55
            elif verified is False:
                evidence -= 0.75
            evidence += 0.2 if files else (-0.35 if task.get("outputs") else 0.0)
            if coverage >= 0.6:
                evidence += 0.2
            elif coverage <= 0.2 and verified is not True:
                evidence -= 0.15
            if not (result.summary or "").strip():
                evidence -= 0.15
            meets_signal = max(-1.0, min(1.0, evidence))
            quality_signal = max(-1.0, min(1.0, 0.5 * meets_signal + (coverage - 0.5)
                                           + (0.15 if len(files) > 1 else 0.0)))
            facts = {
                "files_changed": files,
                "tool_call_count": len(result.tool_calls),
                "criteria_coverage": coverage,
                "verified": verified,
                "meets_signal": meets_signal,
                "quality_signal": quality_signal,
                "hallucination_signal": -0.7 if (files or verified is True) else 0.4,
            }
            decision = await decisions.decide(presets.output_quality(task, result.summary, facts))
            quality = {
                "meets_criteria": decision.value("meets_criteria"),
                "quality": decision.value("quality_score"),
                "confidence": decision.confidence,
                "engine": decision.engine,
                "hallucination_risk": decision.prob("hallucination_risk", 0.0),
            }
            if decision.action == "auto" and decision.value("meets_criteria") is False:
                error = (
                    "The decision layer judged that this output does not meet the done-criteria "
                    f"(confidence {decision.confidence:.2f})."
                )

        if error:
            await self._handle_failure(handle, plan_id=plan_id, project_id=project_id, task=task,
                                       profile_id=profile.id, error=error, verification=verification,
                                       quality=quality, root=root, objective=objective,
                                       acceptance=acceptance, spend_authorized=spend_authorized,
                                       files_changed=ctx.changed_files)
            return

        with session_scope() as s:
            row = s.get(Task, task_id)
            if row is not None:
                row.status = "completed"
                row.summary = (result.summary if result else "")[:8000]
                row.result = (result.summary if result else "")[:20000]
                row.files_changed = sorted(set(ctx.changed_files))
                row.verification = verification
                row.tokens_used = int(row.tokens_used or 0) + (result.tokens_used if result else 0)
                row.finished_at = now()
                row.error = None
            s.add(AuditRecord(actor=f"agent:{profile.id}", action="task.completed", target=task_id,
                              result="ok",
                              context={"files": sorted(ctx.changed_files)[:40],
                                       "quality": quality,
                                       "mocked": bool(result.mocked) if result else False}))
        await self._set_agent_state(profile.id, "idle", None, target="home")
        await bus.emit(
            "task.completed",
            task_id=task_id,
            plan_id=plan_id,
            project_id=project_id,
            agent_id=profile.id,
            external_id=task["external_id"],
            title=task["title"],
            files_changed=sorted(ctx.changed_files),
            verification=verification,
            quality=quality,
            tokens=result.tokens_used if result else 0,
            mocked=bool(result.mocked) if result else False,
            summary=(result.summary if result else "")[:600],
        )
        await self._absorb_subtask_requests(handle, plan_id, project_id, task, result)

    async def _handle_failure(
        self,
        handle: RunHandle,
        *,
        plan_id: str,
        project_id: str,
        task: dict[str, Any],
        profile_id: str,
        error: str,
        verification: dict[str, Any],
        quality: dict[str, Any],
        root: Path,
        objective: str,
        acceptance: list[str],
        spend_authorized: bool,
        files_changed: set[str],
    ) -> None:
        task_id = task["id"]
        retries = int(task.get("retries") or 0)
        exit_code = None
        for check in verification.get("checks", []):
            if check.get("code") is not None:
                exit_code = int(check["code"])
                break

        strategy = await repair.decide_strategy(
            task, error, retries, {"quality": quality}, exit_code=exit_code
        )
        with session_scope() as s:
            row = s.get(Task, task_id)
            if row is not None:
                row.error = error[:8000]
                row.verification = verification
                row.retries = retries + 1
                row.files_changed = sorted(set(files_changed))

        await bus.emit(
            "task.failed",
            task_id=task_id,
            plan_id=plan_id,
            project_id=project_id,
            agent_id=profile_id,
            external_id=task["external_id"],
            title=task["title"],
            error=error[:2000],
            retries=retries + 1,
            strategy=strategy,
            verification=verification,
        )

        action = strategy["strategy"]
        if action == "escalate":
            await self._set_agent_state(profile_id, "blocked", task_id, target="home")
            with session_scope() as s:
                row = s.get(Task, task_id)
                if row is not None:
                    row.status = "blocked"
            approved = await gate.request(
                action="task.unblock",
                detail={"task": task["title"], "error": error[:2000], "agent_id": profile_id,
                        "reason": strategy["reason"]},
                risk=0.6,
                plan_id=plan_id,
                task_id=task_id,
                requested_by=f"agent:{profile_id}",
            )
            if approved:
                with session_scope() as s:
                    row = s.get(Task, task_id)
                    if row is not None:
                        row.status = "pending"
                        row.error = None
                await self._set_agent_state(profile_id, "idle", None, target="home")
                await bus.emit("task.ready", task_id=task_id, plan_id=plan_id,
                               detail="unblocked by the founder")
            else:
                with session_scope() as s:
                    row = s.get(Task, task_id)
                    if row is not None:
                        row.status = "cancelled"
                await bus.emit("task.cancelled", task_id=task_id, plan_id=plan_id,
                               detail="founder denied the unblock request")
            return

        if action == "reassign":
            roster = _enabled_worker_ids()
            candidates = repair.reassign_candidates(task, roster)
            new_agent = candidates[0] if candidates else profile_id
            with session_scope() as s:
                row = s.get(Task, task_id)
                if row is not None:
                    row.status = "pending"
                    row.agent_id = new_agent
            await self._set_agent_state(profile_id, "idle", None, target="home")
            await bus.emit("task.reassigned", task_id=task_id, plan_id=plan_id,
                           from_agent=profile_id, to_agent=new_agent, reason=strategy["reason"])
            return

        # retry_same / fix_context -> back to pending with the error retained as context
        with session_scope() as s:
            row = s.get(Task, task_id)
            if row is not None:
                row.status = "pending"
        await self._set_agent_state(profile_id, "idle", None, target="home")
        await bus.emit(
            "task.repairing",
            task_id=task_id,
            plan_id=plan_id,
            agent_id=profile_id,
            strategy=action,
            attempt=retries + 1,
            max_attempts=repair.max_repairs(),
            reason=strategy["reason"],
            confidence=strategy["confidence"],
            engine=strategy["engine"],
        )

    async def _absorb_subtask_requests(
        self, handle: RunHandle, plan_id: str, project_id: str, task: dict[str, Any], result: Any
    ) -> None:
        if result is None or not result.requested_subtasks:
            return
        for request in result.requested_subtasks:
            if handle.net_new_tasks >= MAX_NET_NEW_TASKS_PER_PLAN:
                await bus.emit(
                    "task.subtask_rejected", plan_id=plan_id, task_id=task["id"],
                    reason=f"Net-new task limit reached ({MAX_NET_NEW_TASKS_PER_PLAN} per plan).",
                )
                continue
            title = str(request.get("title") or "requested subtask")[:200]
            description = str(request.get("description") or "")[:4000]
            agent_id = str(request.get("suggested_agent") or task.get("agent_id") or "pm")
            if agent_id not in PROFILE_MAP or agent_id in ("ceo", "laya"):
                agent_id = "pm"
            with session_scope() as s:
                order = s.query(Task).filter(Task.plan_id == plan_id).count()
                row = Task(
                    plan_id=plan_id,
                    project_id=project_id,
                    external_id=f"sub{order + 1}",
                    title=title,
                    description=description,
                    agent_id=agent_id,
                    status="pending",
                    depends_on=[],
                    done_criteria=[f"Resolve the blocker reported by task {task.get('external_id')}"],
                    priority=2,
                    effort=1,
                    order_index=order,
                    timeout_seconds=int(get_setting("task_timeout_seconds", settings.task_timeout_seconds)),
                )
                s.add(row)
                s.flush()
                new_id = row.id
                dependent = s.get(Task, task["id"])
                if dependent is not None:
                    dependent.status = "pending"
                    dependent.depends_on = list(dict.fromkeys([*(dependent.depends_on or []), new_id]))
            handle.net_new_tasks += 1
            await bus.emit("task.subtask_added", plan_id=plan_id, parent_task=task["id"],
                           task_id=new_id, agent_id=agent_id, title=title)

    # ------------------------------------------------------------------ #
    # finish
    # ------------------------------------------------------------------ #
    async def _finish(
        self, handle: RunHandle, plan_id: str, project_id: str, root: Path,
        objective: str, acceptance: list[str],
    ) -> None:
        tasks = self._load_tasks(plan_id)
        failed = [t for t in tasks if t["status"] in ("failed", "cancelled", "timeout")]
        blocked = [t for t in tasks if t["status"] == "blocked"]

        self._set_plan_state(plan_id, "verifying")
        await bus.emit("plan.verifying", plan_id=plan_id)

        ctx = ToolContext(root=root, project_id=project_id, plan_id=plan_id)
        plan_verification = await self._plan_level_verification(ctx, tasks)
        acceptance_rows = await verify_acceptance(
            ctx, acceptance, tasks=tasks, plan_verification=plan_verification
        )
        plan_verification["secret_findings"] = scan_for_secrets(root)
        plan_verification["acceptance_summary"] = summarise(acceptance_rows)
        plan_verification["ok"] = bool(
            plan_verification.get("tests_passed", True)
            and not plan_verification["secret_findings"]
            and not any(row["status"] == "fail" for row in acceptance_rows)
        )

        self._set_plan_state(plan_id, "integrating")
        await bus.emit("plan.integrating", plan_id=plan_id)
        commit = await vcs.git_commit(ctx, f"chore: deliver '{objective[:80]}'")

        preview = servers.status(project_id)
        self._set_plan_state(plan_id, "reviewing")

        final_state = "complete"
        failure_reason = ""
        if blocked:
            final_state = "blocked"
            failure_reason = f"{len(blocked)} task(s) are waiting on a human decision."
        elif failed:
            final_state = "failed"
            failure_reason = f"{len(failed)} task(s) could not be completed: " + "; ".join(
                (t.get("error") or t["status"])[:120] for t in failed[:3]
            )
        elif not plan_verification["ok"]:
            final_state = "complete"
            failure_reason = "Delivered with unresolved verification findings (see the report)."

        with session_scope() as s:
            plan = s.get(Plan, plan_id)
            project = s.get(Project, project_id)
            report = reporter.build_report(
                project={"id": project_id, "name": project.name if project else "",
                         "workspace_path": str(root)},
                plan={"id": plan_id, "objective": objective, "state": final_state,
                      "requirements": list(plan.requirements or []) if plan else [],
                      "heuristic": bool(plan.heuristic) if plan else False,
                      "failure_reason": failure_reason},
                tasks=tasks,
                verification=plan_verification,
                acceptance=acceptance_rows,
                budget=budget_guard.budget.snapshot(plan_id).as_dict(),
                root=root,
                preview=preview,
            )
            report["git"] = commit
            if plan is not None:
                plan.state = final_state
                plan.finished_at = now()
                plan.failure_reason = failure_reason or None
                plan.validation = {**(plan.validation or {}), "final": plan_verification}
            if project is not None:
                project.status = final_state
                project.report = report
                project.preview_url = preview.get("public_url") or preview.get("local_url")
                project.preview_port = preview.get("port")

        for agent_id in _all_agent_ids():
            await self._set_agent_state(agent_id, "idle", None, target="home")

        await checkpoints.save(plan_id, reason="plan_finished")
        await bus.emit(
            "plan.finished",
            plan_id=plan_id,
            project_id=project_id,
            state=final_state,
            delivered=bool(report.get("delivered")),
            failure_reason=failure_reason,
            used_mock=bool(report.get("used_mock_provider")),
            limitations=report.get("limitations", []),
            metrics=report.get("metrics", {}),
            task_count=len(tasks),
        )
        self.runs.pop(plan_id, None)

    async def _plan_level_verification(self, ctx: ToolContext, tasks: list[dict[str, Any]]) -> dict[str, Any]:
        """Re-run every distinct verify command once, at plan level."""
        seen: set[str] = set()
        checks: list[dict[str, Any]] = []
        for task in tasks:
            for command in task.get("verify_commands") or []:
                if command in seen:
                    continue
                seen.add(command)
        for command in sorted(seen):
            result = await verify_task(ctx, {"verify_commands": [command]})
            checks.extend(result.get("checks", []))
        tests_passed = None
        for check in checks:
            if "pytest" in check.get("command", "") or "npm test" in check.get("command", ""):
                tests_passed = bool(check.get("passed"))
                break
        return {
            "checks": checks,
            "tests_passed": tests_passed if tests_passed is not None else True,
            "reason": "" if all(c.get("passed") for c in checks) else
            "; ".join(f"`{c['command']}` exit {c.get('code')}" for c in checks if not c.get("passed"))[:800],
        }

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _load_tasks(self, plan_id: str) -> list[dict[str, Any]]:
        with session_scope() as s:
            rows = s.query(Task).filter(Task.plan_id == plan_id).order_by(Task.order_index).all()
            return [_task_dict(row) for row in rows]

    def _dependency_outputs(self, plan_id: str, task: dict[str, Any]) -> list[dict[str, Any]]:
        deps = task.get("depends_on") or []
        if not deps:
            return []
        with session_scope() as s:
            rows = s.query(Task).filter(Task.id.in_(deps)).all()
            return [
                {"id": row.id, "external_id": row.external_id, "title": row.title,
                 "agent_id": row.agent_id, "summary": row.summary, "result": row.result,
                 "files_changed": list(row.files_changed or [])}
                for row in rows
            ]

    def _resolve_provider(self, profile: Any, spend_authorized: bool) -> tuple[str | None, str | None]:
        try:
            with session_scope() as s:
                row = s.get(Agent, profile.id)
                preferred_provider = row.provider_id if row else None
                preferred_model = row.model if row else None
            return providers.pick(
                role=profile.model_role,
                preferred_provider_id=preferred_provider,
                preferred_model=preferred_model,
                spend_authorized=spend_authorized,
            )
        except ProviderError as exc:
            log.warning("no provider for agent %s: %s", profile.id, exc.message)
            return None, None

    def _update_progress(self, plan_id: str) -> None:
        tasks = self._load_tasks(plan_id)
        done, total, fraction = scheduler.progress(tasks)
        with session_scope() as s:
            plan = s.get(Plan, plan_id)
            if plan is not None:
                plan.weight_done = done
                plan.weight_total = total
                plan.progress = fraction

    def _set_plan_state(self, plan_id: str, state: str, failure_reason: str | None = None) -> None:
        with session_scope() as s:
            plan = s.get(Plan, plan_id)
            if plan is None:
                return
            previous = plan.state
            plan.state = state
            if failure_reason is not None:
                plan.failure_reason = failure_reason
            if state in ("complete", "failed", "cancelled"):
                plan.finished_at = now()
        if previous != state:
            bus.emit_threadsafe("plan.state_changed", plan_id=plan_id, previous=previous, state=state)

    async def _set_agent_state(
        self, agent_id: str, status: str, task_id: str | None, *, target: str = "home"
    ) -> None:
        with session_scope() as s:
            row = s.get(Agent, agent_id)
            if row is None:
                return
            previous = row.status
            row.status = status
            row.current_task_id = task_id
            profile = PROFILE_MAP.get(agent_id)
            if profile is not None:
                if target == "hub":
                    row.city_x, row.city_y = (820.0, 545.0)
                elif target == "work" and task_id:
                    task = s.get(Task, task_id)
                    owner = task.agent_id if task else agent_id
                    department = PROFILE_MAP[owner].department if owner in PROFILE_MAP else profile.department
                    if department == profile.department:
                        row.city_x, row.city_y = row.home_x, row.home_y
                    else:
                        building = BUILDING_BY_DEPARTMENT.get(department)
                        if building is not None:
                            row.city_x, row.city_y = seat_for(agent_id, department,
                                                              _stable_seat(agent_id, building))
                else:
                    row.city_x, row.city_y = row.home_x, row.home_y
        await bus.emit(
            "agent.status_changed",
            agent_id=agent_id,
            previous=previous,
            status=status,
            task_id=task_id,
        )

    def _fail_task(self, task_id: str, error: str, plan_id: str) -> None:
        with session_scope() as s:
            row = s.get(Task, task_id)
            if row is not None:
                row.status = "failed"
                row.error = error
        bus.emit_threadsafe("task.failed", task_id=task_id, plan_id=plan_id, error=error)

    # ------------------------------------------------------------------ #
    # read models
    # ------------------------------------------------------------------ #
    def status(self) -> dict[str, Any]:
        active = []
        for plan_id, handle in self.runs.items():
            active.append({
                "plan_id": plan_id,
                "project_id": handle.project_id,
                "running": handle.task is not None and not handle.task.done(),
                "paused": handle.pause_event.is_set(),
                "cancelled": handle.cancel_event.is_set(),
                "inflight": list(handle.inflight.keys()),
                "net_new_tasks": handle.net_new_tasks,
                "elapsed_seconds": round(time.monotonic() - handle.started_at, 1),
            })
        return {"active_runs": active, "count": len(active)}


def _stable_seat(agent_id: str, building: Any) -> int:
    """Deterministic seat inside a building, so layout is reproducible."""
    import hashlib

    seats = len(building.seats or (1,))
    digest = hashlib.sha256(f"{building.id}:{agent_id}".encode()).digest()
    return int.from_bytes(digest[:4], "big") % max(seats, 1)


def _all_agent_ids() -> list[str]:
    return [p.id for p in PROFILES]


def _enabled_worker_ids() -> list[str]:
    with session_scope() as s:
        rows = s.query(Agent).filter(Agent.is_enabled.is_(True)).all()
        enabled = {row.id for row in rows}
    return [agent_id for agent_id in WORKER_IDS if agent_id in enabled] or list(WORKER_IDS)


def _derive_name(objective: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", objective or "")
    meaningful = [w for w in words if len(w) > 2 and w.lower() not in
                  {"build", "create", "make", "the", "and", "with", "for", "complete", "app", "application"}]
    return "-".join(meaningful[:3]).lower() or "project"


def _unique_workspace(name: str) -> Path:
    base = settings.workspaces_dir / name
    if not base.exists():
        return base
    index = 2
    while True:
        candidate = settings.workspaces_dir / f"{name}-{index}"
        if not candidate.exists():
            return candidate
        index += 1


def _specificity(objective: str) -> float:
    words = len((objective or "").split())
    has_verb = bool(re.search(r"\b(build|create|make|write|implement|design|add|fix|test|deploy)\b",
                              (objective or "").lower()))
    has_artifact = bool(re.search(r"\b(api|app|site|script|test|readme|dashboard|service|cli|page)\b",
                                  (objective or "").lower()))
    score = 0.0
    score += min(words / 40.0, 0.5)
    score += 0.25 if has_verb else 0.0
    score += 0.25 if has_artifact else 0.0
    return round(min(score, 1.0), 3)


def _clarifying_questions(objective: str) -> list[str]:
    questions = []
    if not re.search(r"\b(python|node|react|fastapi|django|flask|go|rust|java|typescript)\b",
                     objective.lower()):
        questions.append("Which language or stack should this be built in?")
    if not re.search(r"\b(test|pytest|coverage|qa)\b", objective.lower()):
        questions.append("What level of automated testing do you expect?")
    if not re.search(r"\b(deploy|local|docker|cloud|preview)\b", objective.lower()):
        questions.append("Where must this run — locally, in Docker, or deployed?")
    return questions[:3]


def _default_assumptions(objective: str) -> list[str]:
    return [
        "Assumed stack: Python 3.11+ with pytest, because none was specified.",
        "Assumed delivery target: a local, runnable project (no cloud deployment).",
        "Assumed scope: the smallest complete slice that satisfies the objective.",
    ]


def _criteria_coverage(task: dict[str, Any], summary: str, files: list[str]) -> float:
    criteria = task.get("done_criteria") or []
    if not criteria:
        return 0.5
    corpus = f"{summary} {' '.join(files)}".lower()
    hits = 0
    for criterion in criteria:
        words = [w for w in re.findall(r"[a-z]{4,}", str(criterion).lower())]
        if not words:
            continue
        if any(word in corpus for word in words):
            hits += 1
    return round(hits / len(criteria), 3)


async def _audit_tool_call(ctx: ToolContext, tool: str, args: dict, result: Any) -> None:
    from ..security.redact import redact_value

    sensitive = tool in ("delete_file", "git_push", "run_shell", "start_dev_server")
    if not sensitive and result.ok:
        return
    try:
        with session_scope() as s:
            s.add(
                AuditRecord(
                    actor=f"agent:{ctx.agent_id}" if ctx.agent_id else "system",
                    action=f"tool.{tool}",
                    target=str(args.get("path") or args.get("command") or "")[:300],
                    result="ok" if result.ok else ("denied" if result.denied else "error"),
                    context=redact_value({"args": args, "reason": result.reason}) if isinstance(args, dict)
                    else {},
                )
            )
    except Exception as exc:  # pragma: no cover
        log.warning("audit write failed: %s", exc)


orchestrator = Orchestrator()
