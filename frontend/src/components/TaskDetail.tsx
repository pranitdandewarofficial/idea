/**
 * Task evidence view. Everything shown here was really executed: tool calls with
 * their real results, verify commands with exit codes and raw output, and the
 * decision-layer verdicts for this task.
 */
import { useState } from "react";
import { clsx } from "clsx";
import { Check, FileCode2, RotateCcw, UserCog, X } from "lucide-react";
import { api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { Badge, Button, EmptyState, ErrorState, Loading, Modal } from "./ui";
import { clockTime, duration, toneFor } from "../lib/format";
import type { DecisionRecord, Task } from "../lib/types";

interface Timeline {
  tool_calls: {
    id: string; tool: string; ok: boolean; denied: boolean; reason: string | null;
    exit_code: number | null; duration_ms: number; args: Record<string, unknown>;
    result_excerpt?: string; created_at: string | null;
  }[];
  messages: { id: string; role: string; content: string; created_at: string | null }[];
  events: { id: number; kind: string; payload: Record<string, unknown>; ts: string | null }[];
}

export function TaskDetail({
  task, onClose, onChanged, agents,
}: {
  task: Task;
  onClose?: () => void;
  onChanged?: () => void;
  agents?: { id: string; name: string; role: string }[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("");

  const timeline = useResource<Timeline>(() => api.get<Timeline>(`/api/tasks/${task.id}/timeline`), {
    deps: [task.id, task.status], refreshOn: ["tool.", "task.", "decision."], debounce: 600,
  });
  const decisions = useResource<{ items: DecisionRecord[] }>(
    () => api.get<{ items: DecisionRecord[] }>("/api/decisions", { task_id: task.id, limit: 50 }),
    { deps: [task.id, task.status], refreshOn: ["decision."], debounce: 800 },
  );

  const act = async (key: string, call: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await call();
      timeline.reload();
      onChanged?.();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="numeric text-xs text-ink-faint">{task.external_id}</span>
            <Badge tone={toneFor("task", task.status)}>{task.status}</Badge>
            {task.retries > 0 && <Badge tone="warning">{task.retries} retries</Badge>}
          </div>
          <h3 className="mt-1 text-[15px] font-semibold">{task.title}</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            owner {task.agent_id ?? "unassigned"} · effort {task.effort} · priority {task.priority}
            {task.depends_on.length > 0 && <> · after {task.depends_on.join(", ")}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" busy={busy === "retry"}
                  onClick={() => void act("retry", () => api.post(`/api/tasks/${task.id}/retry`))}>
            <RotateCcw size={13} /> Retry
          </Button>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} title="Close"><X size={13} /></Button>
          )}
        </div>
      </header>

      {error && <ErrorState message={error} />}

      <section>
        <p className="label">Instructions given to the agent</p>
        <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-soft">{task.description}</p>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section>
          <p className="label">Done criteria</p>
          <ul className="mt-1 space-y-0.5 text-[13px] text-ink-soft">
            {task.done_criteria.length === 0 && <li className="text-ink-faint">none declared</li>}
            {task.done_criteria.map((criterion) => <li key={criterion}>· {criterion}</li>)}
          </ul>
        </section>
        <section>
          <p className="label">Declared outputs</p>
          <ul className="mt-1 space-y-0.5 text-[13px] text-ink-soft">
            {task.outputs.length === 0 && <li className="text-ink-faint">none declared</li>}
            {task.outputs.map((output) => (
              <li key={output} className="numeric flex items-center gap-1.5">
                <FileCode2 size={12} /> {output}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section>
        <div className="flex items-center justify-between">
          <p className="label">Verification</p>
          <Badge tone={task.verification?.verified === true ? "positive" : task.verification?.verified === false ? "danger" : "muted"}>
            {task.verification?.verified === true ? "passed" : task.verification?.verified === false ? "failed" : "no automated check"}
          </Badge>
        </div>
        {task.verification?.reason && (
          <p className="mt-1 text-[13px] text-danger">{task.verification.reason}</p>
        )}
        <div className="mt-2 space-y-2">
          {(task.verification?.checks ?? []).map((check) => (
            <div key={check.command} className="panel-flat p-2.5">
              <div className="flex items-center justify-between gap-2">
                <code className="numeric truncate text-xs">{check.command}</code>
                <span className="flex items-center gap-1.5">
                  {check.policy_denied && <Badge tone="danger">blocked by policy</Badge>}
                  <Badge tone={check.passed ? "positive" : "danger"}>
                    {check.passed ? <Check size={11} /> : <X size={11} />} exit {check.code ?? "—"}
                  </Badge>
                </span>
              </div>
              {(check.stdout || check.stderr) && (
                <pre className="code mt-1.5 max-h-40 overflow-y-auto">
                  {[check.stdout, check.stderr].filter(Boolean).join("\n--- stderr ---\n")}
                </pre>
              )}
              <p className="numeric mt-1 text-[11px] text-ink-faint">
                {check.sandbox ?? "subprocess"} · {duration(check.duration_ms ?? null)}
                {check.timed_out ? " · timed out" : ""}
              </p>
            </div>
          ))}
          {(task.verification?.checks ?? []).length === 0 && (
            <EmptyState title="Nothing was executed for this task yet"
                        body="Verification runs the task's own verify commands after the agent finishes." />
          )}
        </div>
      </section>

      {task.files_changed.length > 0 && (
        <section>
          <p className="label">Files changed ({task.files_changed.length})</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {task.files_changed.map((file) => (
              <li key={file} className="numeric badge">{file}</li>
            ))}
          </ul>
        </section>
      )}

      {task.summary && (
        <section>
          <p className="label">Agent summary</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-soft">{task.summary}</p>
        </section>
      )}

      {task.error && (
        <section>
          <p className="label text-danger">Last error</p>
          <pre className="code mt-1 max-h-40 overflow-y-auto border-[#f2cfcc] text-danger">{task.error}</pre>
        </section>
      )}

      <section>
        <p className="label">Decision layer for this task</p>
        {decisions.loading && <Loading label="Loading decisions" />}
        {decisions.data?.items.length ? (
          <ul className="mt-1.5 space-y-1">
            {decisions.data.items.map((decision) => (
              <li key={decision.id} className="flex flex-wrap items-center gap-2 border-b border-line-soft py-1 text-[12px] last:border-0">
                <span className="numeric w-28 shrink-0 text-ink-faint">{decision.decision_type}</span>
                <Badge tone={decision.engine === "llm" ? "warning" : "accent"}>{decision.engine}</Badge>
                <span className="numeric">conf {decision.confidence.toFixed(2)}</span>
                <Badge tone={decision.action === "auto" ? "positive" : "warning"}>{decision.action}</Badge>
                {decision.fallback_used && <Badge tone="warning">system 2</Badge>}
                <span className="numeric text-ink-faint">{decision.latency_ms.toFixed(1)} ms</span>
                <span className="min-w-0 flex-1 truncate text-ink-soft">
                  {Object.entries(decision.answers ?? {})
                    .map(([key, answer]) => `${key}=${String(answer.value)}`).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-ink-faint">No decision was recorded for this task.</p>
        )}
      </section>

      <section>
        <p className="label">Tool calls ({timeline.data?.tool_calls.length ?? 0})</p>
        {timeline.loading && <Loading label="Loading tool calls" />}
        {timeline.error && <ErrorState message={timeline.error} onRetry={timeline.reload} />}
        {timeline.data && timeline.data.tool_calls.length === 0 && (
          <p className="mt-1 text-xs text-ink-faint">This task has not called a tool.</p>
        )}
        <ul className="mt-1.5 space-y-1.5">
          {(timeline.data?.tool_calls ?? []).map((call) => (
            <li key={call.id} className="panel-flat p-2.5">
              <div className="flex items-center justify-between gap-2">
                <code className="numeric text-xs font-medium">{call.tool}</code>
                <span className="flex items-center gap-1.5">
                  {call.denied && <Badge tone="danger">denied</Badge>}
                  <Badge tone={call.ok ? "positive" : "danger"}>{call.ok ? "ok" : "failed"}</Badge>
                  <span className="numeric text-[11px] text-ink-faint">{duration(call.duration_ms)}</span>
                </span>
              </div>
              <pre className="code mt-1.5 max-h-32 overflow-y-auto">{JSON.stringify(call.args, null, 2)}</pre>
              {call.reason && <p className="mt-1 text-[12px] text-danger">{call.reason}</p>}
              {call.result_excerpt && <pre className="code mt-1 max-h-32 overflow-y-auto">{call.result_excerpt}</pre>}
              <p className="numeric mt-1 text-[11px] text-ink-faint">{clockTime(call.created_at)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <p className="label">Reassign</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <select className="field w-auto min-w-[180px]" value={reassignTo}
                  onChange={(event) => setReassignTo(event.target.value)}>
            <option value="">choose an agent…</option>
            {(agents ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>
            ))}
          </select>
          <Button size="sm" disabled={!reassignTo} busy={busy === "reassign"}
                  onClick={() => void act("reassign", () => api.post(`/api/tasks/${task.id}/reassign`, null, { agent_id: reassignTo }))}>
            <UserCog size={13} /> Reassign
          </Button>
        </div>
      </section>
    </div>
  );
}

export function TaskModal({
  task, onClose, onChanged, agents,
}: {
  task: Task | null; onClose: () => void; onChanged?: () => void;
  agents?: { id: string; name: string; role: string }[];
}) {
  return (
    <Modal open={Boolean(task)} onClose={onClose} wide title={task ? `${task.external_id} · ${task.title}` : ""}>
      {task && <TaskDetail task={task} onClose={onClose} onChanged={onChanged} agents={agents} />}
    </Modal>
  );
}

export function StatusDot({ status }: { status: string }) {
  const tone = toneFor("task", status);
  const colour = tone === "positive" ? "bg-positive" : tone === "danger" ? "bg-danger"
    : tone === "warning" ? "bg-warning" : tone === "accent" ? "bg-accent" : "bg-[#c9cddb]";
  return <span className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", colour, status === "running" && "pulse")} />;
}
