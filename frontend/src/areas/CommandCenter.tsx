/** Area 2 - Command Center: give the company an objective and watch it really work. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { clsx } from "clsx";
import { Pause, Play, RotateCcw, Send, Square, TriangleAlert } from "lucide-react";
import { ApiError, api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, ErrorState, Field, Loading, Panel, Progress, Stat } from "../components/ui";
import { Page } from "../components/Shell";
import { compactNumber, duration, money, percent, timeAgo, toneFor } from "../lib/format";
import type { BudgetState, Checkpoint, DeliveryReport, Plan, Task } from "../lib/types";
import { PlanDag } from "../components/PlanDag";
import { DeliveryReportView } from "../components/DeliveryReport";

interface ObjectiveResponse {
  project_id: string;
  plan_id: string;
  state: string;
  task_count: number;
  workspace: string | null;
  meta: Record<string, unknown>;
  validation: { ok: boolean; errors: string[] };
  errors: string[];
}

const ACTIVE_STATES = ["executing", "scheduling", "planning", "verifying", "repairing", "integrating",
                       "reviewing", "delivering", "paused", "blocked", "scheduled"];

export function CommandCenter() {
  const pushToast = useApp((state) => state.pushToast);
  const [objective, setObjective] = useState("");
  const [projectName, setProjectName] = useState("");
  const [spendAuthorized, setSpendAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  const plans = useResource<{ items: Plan[] }>(
    () => api.get<{ items: Plan[] }>("/api/plans", { limit: 40 }),
    { refreshOn: ["plan.", "objective.", "task."], debounce: 500 },
  );

  useEffect(() => {
    const items = plans.data?.items ?? [];
    if (!selectedPlan && items.length) {
      const active = items.find((plan) => ACTIVE_STATES.includes(plan.state));
      setSelectedPlan((active ?? items[0]).id);
    }
    if (selectedPlan && !items.some((plan) => plan.id === selectedPlan) && items.length) {
      setSelectedPlan(items[0].id);
    }
  }, [plans.data, selectedPlan]);

  const submit = async () => {
    setSubmitError(null);
    if (objective.trim().length < 3) {
      setSubmitError("Describe the objective in at least a sentence.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await api.post<ObjectiveResponse>("/api/objectives", {
        objective: objective.trim(),
        project_name: projectName.trim() || null,
        spend_authorized: spendAuthorized,
        auto_start: true,
      });
      setSelectedPlan(response.plan_id);
      setObjective("");
      setProjectName("");
      plans.reload();
      pushToast({
        title: "Objective accepted",
        body: `${response.task_count} tasks planned · ${response.state}`,
        tone: "success",
      });
    } catch (error) {
      setSubmitError(describeError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const activeCount = (plans.data?.items ?? []).filter((plan) => ACTIVE_STATES.includes(plan.state)).length;

  return (
    <Page className="space-y-4">
      <Panel
        title="Give the company an objective"
        subtitle="One orchestrator turns this into a dependency-aware plan, assigns it to the specialists, runs real tools and verifies the result."
        actions={<Badge tone={activeCount ? "accent" : "muted"}>{activeCount} running</Badge>}
      >
        <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
          <Field label="Objective" hint="Be specific: stack, deliverables and what 'done' means. Vague objectives get stated assumptions instead of questions.">
            <textarea
              className="field min-h-[96px]"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Build a Python CLI that converts CSV files to Parquet, with pytest tests and a README."
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
              }}
            />
          </Field>
          <div className="space-y-3">
            <Field label="Project name" hint="Optional - derived from the objective otherwise.">
              <input className="field" value={projectName} onChange={(event) => setProjectName(event.target.value)}
                     placeholder="csv-to-parquet" />
            </Field>
            <label className="flex items-start gap-2 rounded-md border border-line bg-sunken/60 p-2.5 text-xs">
              <input type="checkbox" className="mt-0.5" checked={spendAuthorized}
                     onChange={(event) => setSpendAuthorized(event.target.checked)} />
              <span>
                <span className="font-medium text-ink">Authorize paid providers for this run</span>
                <span className="mt-0.5 block text-ink-faint">
                  Off by default. With zero-spend on, only free/local providers (Ollama, LM Studio, the offline mock) are used.
                </span>
              </span>
            </label>
            <Button variant="accent" busy={submitting} onClick={() => void submit()} className="w-full justify-center">
              <Send size={14} /> Submit objective
            </Button>
          </div>
        </div>
        {submitError && <div className="mt-3"><ErrorState message={submitError} /></div>}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Panel title="Plans" subtitle="Most recent first" bodyClassName="p-2">
          {plans.loading && !plans.data && <Loading label="Loading plans" />}
          {plans.error && !plans.data && <ErrorState message={plans.error} onRetry={plans.reload} />}
          {plans.data?.items.length === 0 && (
            <div className="p-2">
              <EmptyState title="No plans yet" body="Submit an objective above and the CEO will plan it here." />
            </div>
          )}
          <ul className="space-y-1">
            {(plans.data?.items ?? []).map((plan) => (
              <li key={plan.id}>
                <button
                  type="button"
                  onClick={() => setSelectedPlan(plan.id)}
                  className={clsx("w-full rounded-md px-2.5 py-2 text-left row-hover",
                                  selectedPlan === plan.id && "bg-accent-soft")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="numeric text-[11px] text-ink-faint">{plan.id.slice(0, 8)}</span>
                    <Badge tone={toneFor("plan", plan.state)}>{plan.state}</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[13px]">{plan.objective}</p>
                  <div className="mt-1.5"><Progress value={plan.progress} tone={plan.state === "complete" ? "positive" : "accent"} /></div>
                  <p className="numeric mt-1 text-[11px] text-ink-faint">
                    {percent(plan.progress)} · {compactNumber(plan.tokens_used)} tok · {timeAgo(plan.created_at)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        {selectedPlan ? <PlanDetail planId={selectedPlan} onChanged={plans.reload} /> : (
          <Panel title="Run detail"><EmptyState title="Select a plan" body="Pick a plan on the left to inspect its DAG, budget, verification and delivery report." /></Panel>
        )}
      </div>
    </Page>
  );
}

function PlanDetail({ planId, onChanged }: { planId: string; onChanged: () => void }) {
  const pushToast = useApp((state) => state.pushToast);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const plan = useResource<Plan>(() => api.get<Plan>(`/api/plans/${planId}`), {
    deps: [planId], refreshOn: ["plan.", "task.", "budget.", "approval.", "checkpoint."], debounce: 400,
  });
  const tasks = useResource<{ items: Task[] }>(() => api.get<{ items: Task[] }>("/api/tasks", { plan: planId, limit: 100 }),
                                               { deps: [planId], refreshOn: ["task.", "plan.", "tool."], debounce: 400 });
  const budget = useResource<BudgetState>(() => api.get<BudgetState>(`/api/plans/${planId}/budget`),
                                           { deps: [planId], refreshOn: ["budget.", "task.", "plan."], debounce: 800 });
  const checkpoints = useResource<{ items: Checkpoint[] }>(() => api.get<{ items: Checkpoint[] }>(`/api/plans/${planId}/checkpoints`),
                                                           { deps: [planId], refreshOn: ["checkpoint.", "plan."], debounce: 1000 });
  const report = useResource<DeliveryReport | null>(async () => {
    try {
      return await api.get<DeliveryReport>(`/api/plans/${planId}/report`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "report_not_ready") return null;
      throw error;
    }
  }, { deps: [planId], refreshOn: ["plan.finished", "plan."], debounce: 1000 });

  const act = useCallback(async (action: string, call: () => Promise<unknown>, message: string) => {
    setBusy(action);
    setActionError(null);
    try {
      await call();
      pushToast({ title: message, tone: "success" });
      plan.reload();
      tasks.reload();
      onChanged();
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusy(null);
    }
  }, [onChanged, plan, pushToast, tasks]);

  const state = plan.data?.state ?? "";
  const running = ACTIVE_STATES.includes(state);
  const dag = useMemo(() => (tasks.data?.items ?? []), [tasks.data]);

  if (plan.loading && !plan.data) return <Panel title="Run detail"><Loading label="Loading plan" /></Panel>;
  if (plan.error && !plan.data) return <Panel title="Run detail"><ErrorState message={plan.error} onRetry={plan.reload} /></Panel>;

  const current = plan.data;
  if (!current) return null;

  return (
    <div className="space-y-4">
      <Panel
        title={current.objective}
        subtitle={<span className="numeric">{current.id} · started {timeAgo(current.started_at as string | null)}</span>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={toneFor("plan", current.state)}>{current.state}</Badge>
            {current.heuristic && <Badge tone="warning">rule-based plan</Badge>}
            {current.spend_authorized && <Badge tone="warning">spend authorized</Badge>}
            <Link className="btn btn-sm" to={`/projects`}>Open project</Link>
            {running && (
              <Button size="sm" busy={busy === "pause"}
                      onClick={() => void act("pause", () => api.post(`/api/plans/${planId}/pause`), "Run paused")}>
                <Pause size={13} /> Pause
              </Button>
            )}
            {(state === "paused" || state === "blocked") && (
              <Button size="sm" variant="accent" busy={busy === "resume"}
                      onClick={() => void act("resume", () => api.post(`/api/plans/${planId}/resume`), "Run resumed")}>
                <Play size={13} /> Resume
              </Button>
            )}
            {state !== "complete" && state !== "cancelled" && state !== "failed" && (
              <Button size="sm" variant="danger" busy={busy === "cancel"}
                      onClick={() => void act("cancel", () => api.post(`/api/plans/${planId}/cancel`), "Run cancelled")}>
                <Square size={13} /> Cancel
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between text-xs text-ink-faint">
              <span>Progress</span>
              <span className="numeric">{percent(current.progress)} · {current.weight_done}/{current.weight_total} effort</span>
            </div>
            <div className="mt-1">
              <Progress value={current.progress} tone={current.state === "complete" ? "positive" : current.state === "blocked" ? "warning" : "accent"} />
            </div>
          </div>

          {current.failure_reason && (
            <div className="flex items-start gap-2 rounded-md border border-[#f2cfcc] bg-danger-soft px-3 py-2 text-[13px] text-danger">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>{current.failure_reason}</span>
            </div>
          )}
          {actionError && <ErrorState message={actionError} />}

          <div className="grid gap-2 sm:grid-cols-4">
            <Stat label="Tokens" value={compactNumber(current.tokens_used)}
                  hint={budget.data ? `of ${compactNumber(budget.data.tokens_plan_budget)} plan budget` : undefined} />
            <Stat label="Cost" value={money(current.cost_estimate)}
                  hint={budget.data?.mocked_calls ? `${budget.data.mocked_calls} mocked calls` : "no paid calls"} />
            <Stat label="Tasks" value={dag.length}
                  hint={`${dag.filter((t) => t.status === "completed").length} done · ${dag.filter((t) => t.status === "running" || t.status === "repairing").length} active`} />
            <Stat label="Budget" value={budget.data ? (budget.data.ok ? "ok" : "blocked") : "—"}
                  hint={budget.data ? `${duration(budget.data.elapsed_seconds * 1000)} elapsed` : undefined}
                  tone={budget.data?.ok ? "positive" : "danger"} />
          </div>

          {budget.data && !budget.data.ok && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[#f0dfba] bg-warning-soft px-3 py-2 text-[13px] text-warning">
              <TriangleAlert size={14} />
              <span className="flex-1">{budget.data.reason}</span>
              <Button size="sm" busy={busy === "budget"}
                      onClick={() => void act("budget", async () => {
                        const approvals = await api.get<{ items: { id: string }[] }>("/api/approvals", { status: "pending" });
                        const target = approvals.items[0];
                        if (!target) throw new Error("No pending budget approval to grant.");
                        return api.post(`/api/approvals/${target.id}/decision`, { approved: true, note: "budget increase approved from the UI" });
                      }, "Budget approval granted")}>
                <RotateCcw size={13} /> Grant budget approval
              </Button>
            </div>
          )}
        </div>
      </Panel>

      <PlanDag tasks={dag} onRetry={(taskId) => void act(`retry-${taskId}`, () => api.post(`/api/tasks/${taskId}/retry`), "Task re-queued")}
               busy={busy} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Plan reasoning" subtitle="What the CEO decided before dispatching work">
          <div className="space-y-3 text-[13px]">
            <Section label="Requirements" items={current.requirements} />
            <Section label="Acceptance criteria" items={current.acceptance_criteria} />
            <Section label="Assumptions" items={current.assumptions} tone="warning" />
            <Section label="Clarifying questions" items={current.clarifying_questions} tone="warning" />
            {current.validation?.errors?.length > 0 && (
              <div>
                <p className="label text-danger">Validation errors</p>
                <ul className="mt-1 space-y-0.5 text-danger">
                  {current.validation.errors.map((error) => <li key={error}>· {error}</li>)}
                </ul>
              </div>
            )}
            <div className="numeric grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-faint sm:grid-cols-3">
              <span>actionable {percent(current.validation?.actionable_ratio ?? 0)}</span>
              <span>coverage {percent(current.validation?.coverage_ratio ?? 0)}</span>
              <span>est. tokens {compactNumber(current.validation?.estimated_tokens ?? 0)}</span>
            </div>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Checkpoints" subtitle="Every task boundary is saved; an interrupted run resumes from here">
            {checkpoints.data?.items.length ? (
              <ul className="space-y-1 text-[13px]">
                {checkpoints.data.items.slice(0, 8).map((checkpoint) => (
                  <li key={checkpoint.id} className="flex items-center justify-between gap-2 border-b border-line-soft py-1 last:border-0">
                    <span className="numeric text-ink-faint">#{checkpoint.sequence}</span>
                    <span className="min-w-0 flex-1 truncate">{checkpoint.reason}</span>
                    <span className="numeric text-xs text-ink-faint">{checkpoint.task_count} tasks</span>
                    <span className="numeric text-xs text-ink-faint">{timeAgo(checkpoint.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No checkpoint yet" body="Checkpoints are written after each task boundary." />
            )}
          </Panel>

          <Panel title="Delivery report" subtitle="Generated only from executed evidence">
            {report.loading && <Loading label="Loading report" />}
            {report.error && <ErrorState message={report.error} onRetry={report.reload} />}
            {!report.loading && !report.data && (
              <EmptyState title="Not delivered yet"
                          body="A report appears once the run reaches the delivery stage. It is never generated for a plan that is still executing." />
            )}
            {report.data && <DeliveryReportView report={report.data} />}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Section({ label, items, tone }: { label: string; items: string[]; tone?: "warning" }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className={clsx("label", tone === "warning" && "text-warning")}>{label}</p>
      <ul className="mt-1 space-y-0.5">
        {items.map((item, index) => <li key={`${label}-${index}`} className="text-ink-soft">· {item}</li>)}
      </ul>
    </div>
  );
}
