/**
 * Area 5 - Task Manager: every task the orchestrator created, with the evidence it
 * produced. Statuses, retries, verification exit codes and file lists all come from
 * the database; the retry and reassign buttons call the real endpoints.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { clsx } from "clsx";
import { CheckCircle2, CircleDashed, Filter, XCircle } from "lucide-react";
import { api } from "../api/client";
import { useResource } from "../lib/useResource";
import { Page } from "../components/Shell";
import { TaskModal, StatusDot } from "../components/TaskDetail";
import {
  Badge, Button, EmptyState, ErrorState, Loading, Panel, Progress, Stat,
} from "../components/ui";
import { timeAgo, toneFor } from "../lib/format";
import type { Agent, Plan, Task } from "../lib/types";

const STATUS_GROUPS: { label: string; statuses: string[] }[] = [
  { label: "Active", statuses: ["running", "repairing", "ready"] },
  { label: "Done", statuses: ["completed"] },
  { label: "Needs attention", statuses: ["failed", "blocked", "timeout"] },
  { label: "Queued", statuses: ["pending"] },
];

export function TaskManager() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const [agent, setAgent] = useState("");
  const [plan, setPlan] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(params.get("task"));

  const tasks = useResource<{ items: Task[]; count: number }>(
    () => api.get<{ items: Task[]; count: number }>("/api/tasks", {
      status: status || undefined,
      agent: agent || undefined,
      plan: plan || undefined,
      limit: 300,
    }),
    { deps: [status, agent, plan], refreshOn: ["task.", "plan.", "tool."], debounce: 500 },
  );
  const agents = useResource<{ items: Agent[] }>(() => api.get<{ items: Agent[] }>("/api/agents"), { debounce: 5000 });
  const plans = useResource<{ items: Plan[] }>(() => api.get<{ items: Plan[] }>("/api/plans", { limit: 50 }), {
    refreshOn: ["plan.", "objective."], debounce: 2000,
  });

  useEffect(() => {
    const wanted = params.get("task");
    if (wanted) setOpenId(wanted);
  }, [params]);

  const all = tasks.data?.items ?? [];
  const rows = useMemo(() => {
    if (!query.trim()) return all;
    const needle = query.trim().toLowerCase();
    return all.filter((task) =>
      `${task.external_id} ${task.title} ${task.description} ${task.agent_id ?? ""}`.toLowerCase().includes(needle));
  }, [all, query]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const task of all) tally[task.status] = (tally[task.status] ?? 0) + 1;
    return tally;
  }, [all]);

  const verified = all.filter((task) => task.verification?.verified === true).length;
  const failed = all.filter((task) => task.verification?.verified === false).length;
  const open = all.find((task) => task.id === openId) ?? null;
  const agentName = (id: string | null) =>
    id ? agents.data?.items.find((row) => row.id === id)?.name ?? id : "unassigned";

  const close = () => {
    setOpenId(null);
    if (params.has("task")) {
      params.delete("task");
      setParams(params, { replace: true });
    }
  };

  return (
    <Page className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {STATUS_GROUPS.map((group) => {
          const total = group.statuses.reduce((sum, value) => sum + (counts[value] ?? 0), 0);
          const active = status !== "" && group.statuses.includes(status);
          return (
            <button key={group.label} type="button" onClick={() => setStatus(active ? "" : group.statuses.join(","))}
                    className={clsx("text-left", active && "ring-2 ring-accent ring-offset-1 rounded-md")}>
              <Stat label={group.label} value={total}
                    hint={group.statuses.map((value) => `${value} ${counts[value] ?? 0}`).join(" · ")}
                    tone={group.label === "Needs attention" && total ? "danger"
                      : group.label === "Done" ? "positive" : group.label === "Active" ? "accent" : "muted"} />
            </button>
          );
        })}
        <Stat label="Verified" value={`${verified}/${all.length}`}
              hint={failed ? `${failed} failed verification` : "no failed verification"}
              tone={failed ? "warning" : "positive"} />
      </div>

      <Panel
        title="Tasks"
        subtitle="Filtered views call the API again - the counts above always describe the unfiltered result set."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-xs text-ink-faint"><Filter size={12} /></span>
            <input className="field w-44" placeholder="Search tasks…" value={query}
                   onChange={(event) => setQuery(event.target.value)} aria-label="Search tasks" />
            <select className="field w-auto" value={agent} onChange={(event) => setAgent(event.target.value)}
                    aria-label="Filter by agent">
              <option value="">Any agent</option>
              {(agents.data?.items ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
            <select className="field w-auto max-w-[220px]" value={plan} onChange={(event) => setPlan(event.target.value)}
                    aria-label="Filter by plan">
              <option value="">Any plan</option>
              {(plans.data?.items ?? []).map((row) => (
                <option key={row.id} value={row.id}>{row.id.slice(0, 8)} · {row.state}</option>
              ))}
            </select>
            {(status || agent || plan) && (
              <Button size="sm" variant="ghost" onClick={() => { setStatus(""); setAgent(""); setPlan(""); }}>
                Clear
              </Button>
            )}
            {tasks.reloading && <span className="text-xs text-ink-faint">refreshing…</span>}
          </div>
        }
        bodyClassName="p-0"
      >
        {tasks.loading && !tasks.data && <div className="p-4"><Loading label="Loading tasks" /></div>}
        {tasks.error && !tasks.data && <div className="p-4"><ErrorState message={tasks.error} onRetry={tasks.reload} /></div>}
        {!tasks.loading && rows.length === 0 && (
          <div className="p-4">
            <EmptyState title="No task matches those filters"
                        body="Submit an objective in the Command Center, or clear the filters above." />
          </div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="label border-b border-line text-left">
                  <th className="px-3 py-2 font-medium">Task</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Evidence</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                  <th className="px-3 py-2 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((task) => (
                  <tr key={task.id}
                      className="cursor-pointer border-b border-line-soft last:border-0 row-hover"
                      onClick={() => setOpenId(task.id)}>
                    <td className="px-3 py-2">
                      <span className="numeric block text-[11px] text-ink-faint">{task.external_id}</span>
                      <span className="block max-w-[380px] truncate font-medium">{task.title}</span>
                      {task.depends_on.length > 0 && (
                        <span className="numeric mt-0.5 block text-[11px] text-ink-faint">
                          after {task.depends_on.length} task(s)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-soft">{agentName(task.agent_id)}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <StatusDot status={task.status} />
                        <Badge tone={toneFor("task", task.status)}>{task.status}</Badge>
                        {task.retries > 0 && <span className="numeric text-[11px] text-warning">{task.retries}×</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Evidence task={task} />
                    </td>
                    <td className="numeric px-3 py-2 text-xs text-ink-faint">{task.tokens_used || 0}</td>
                    <td className="numeric px-3 py-2 text-right text-[11px] text-ink-faint">{timeAgo(task.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <TaskModal task={open} onClose={close} onChanged={tasks.reload}
                 agents={(agents.data?.items ?? []).map((row) => ({ id: row.id, name: row.name, role: row.role }))} />
    </Page>
  );
}

function Evidence({ task }: { task: Task }) {
  const checks = task.verification?.checks ?? [];
  if (checks.length === 0 && task.files_changed.length === 0) {
    return <span className="text-xs text-ink-faint">no evidence recorded yet</span>;
  }
  const passed = checks.filter((check) => check.passed).length;
  return (
    <div className="space-y-1">
      {task.files_changed.length > 0 && (
        <span className="numeric flex items-center gap-1 text-[11px] text-ink-soft">
          <CheckCircle2 size={11} className="text-positive" /> {task.files_changed.length} file(s)
        </span>
      )}
      {checks.length > 0 && (
        <span className="flex items-center gap-2">
          <span className="numeric text-[11px] text-ink-soft">
            {passed === checks.length
              ? <CheckCircle2 size={11} className="inline text-positive" />
              : passed === 0
                ? <XCircle size={11} className="inline text-danger" />
                : <CircleDashed size={11} className="inline text-warning" />}{" "}
            {passed}/{checks.length} checks
          </span>
          <span className="w-16"><Progress value={checks.length ? passed / checks.length : 0}
                                           tone={passed === checks.length ? "positive" : "warning"} /></span>
        </span>
      )}
      {task.verification?.verified === false && task.verification?.reason && (
        <span className="block max-w-[260px] truncate text-[11px] text-danger">{task.verification.reason}</span>
      )}
    </div>
  );
}
