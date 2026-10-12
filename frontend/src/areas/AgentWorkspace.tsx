/**
 * Area 4 - Agent Workspace: the live console for one specialist.
 * Messages, tool calls (with real exit codes, durations and denials) and memory are
 * read straight from the database rows the runtime wrote. Nothing here is simulated.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { clsx } from "clsx";
import { Ban, Check, ChevronDown, ChevronRight, CircleSlash, Terminal, Wrench } from "lucide-react";
import { api } from "../api/client";
import { useResource } from "../lib/useResource";
import { Page } from "../components/Shell";
import { Avatar } from "./AgentDirectory";
import {
  Badge, Button, EmptyState, ErrorState, KeyValue, Loading, Panel, Progress, Stat,
} from "../components/ui";
import { clockTime, duration, timeAgo, toneFor } from "../lib/format";
import type { Agent, AgentTaskRow, MemoryItem, MessageRow, ToolCallRow } from "../lib/types";

type Tab = "messages" | "tools" | "tasks" | "memory";

const TABS: { id: Tab; label: string; icon: typeof Terminal }[] = [
  { id: "messages", label: "Conversation", icon: Terminal },
  { id: "tools", label: "Tool calls", icon: Wrench },
  { id: "tasks", label: "Tasks", icon: Check },
  { id: "memory", label: "Memory", icon: CircleSlash },
];

export function AgentWorkspace() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("tools");

  const agents = useResource<{ items: Agent[] }>(() => api.get<{ items: Agent[] }>("/api/agents"), {
    refreshOn: ["agent.", "task.", "plan."], debounce: 1500,
  });

  const roster = agents.data?.items ?? [];
  const currentId = agentId ?? roster.find((agent) => agent.id !== "ceo" && agent.id !== "laya")?.id ?? roster[0]?.id ?? "";

  useEffect(() => {
    if (!agentId && currentId) navigate(`/workspace/${currentId}`, { replace: true });
  }, [agentId, currentId, navigate]);

  const agent = roster.find((row) => row.id === currentId) ?? null;

  return (
    <Page className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="field w-auto min-w-[240px]"
          value={currentId}
          onChange={(event) => navigate(`/workspace/${event.target.value}`)}
          aria-label="Choose an agent"
        >
          {roster.length === 0 && <option value="">Loading roster…</option>}
          {roster.map((row) => (
            <option key={row.id} value={row.id}>{row.name} — {row.role}</option>
          ))}
        </select>
        <div className="flex gap-1">
          {TABS.map((entry) => (
            <button key={entry.id} type="button"
                    onClick={() => setTab(entry.id)}
                    className={clsx("btn btn-sm", tab === entry.id && "btn-accent")}>
              <entry.icon size={13} /> {entry.label}
            </button>
          ))}
        </div>
      </div>

      {agents.loading && !agents.data && <Loading label="Loading the roster" />}
      {agents.error && !agents.data && <ErrorState message={agents.error} onRetry={agents.reload} />}
      {!agent && !agents.loading && (
        <EmptyState title="No agent selected" body="The backend has no agents registered yet." />
      )}

      {agent && (
        <>
          <Panel
            title={
              <span className="flex items-center gap-2">
                <Avatar agent={agent} size={24} /> {agent.name}
                <span className="text-[13px] font-normal text-ink-faint">· {agent.role}</span>
              </span>
            }
            subtitle={`${agent.department} · model role ${agent.model_role} · ${agent.tools.length} tools granted`}
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={toneFor("agent", agent.status)}>{agent.status}</Badge>
                <Button size="sm" onClick={() => navigate(`/agents/${agent.id}`)}>Directory</Button>
              </div>
            }
          >
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Open tasks" value={agent.load ?? 0}
                    hint={agent.current_task ? agent.current_task.title : "nothing assigned"} />
              <Stat label="Provider" value={agent.provider_id ?? "default"} hint={agent.model ?? "provider default model"} />
              <Stat label="Temperature" value={agent.temperature} hint={`max ${agent.max_tokens} tokens/turn`} />
              <Stat label="Parallelism" value={agent.max_parallel_tasks}
                    hint={agent.is_enabled ? "enabled" : "disabled - excluded from routing"}
                    tone={agent.is_enabled ? "positive" : "warning"} />
            </div>
            {agent.current_task && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-ink-faint">
                  <span className="numeric">{agent.current_task.id.slice(0, 8)} · {agent.current_task.title}</span>
                  <span>{agent.current_task.status}</span>
                </div>
                <div className="mt-1"><Progress value={agent.current_task.status === "completed" ? 1 : 0.5} /></div>
              </div>
            )}
          </Panel>

          {tab === "messages" && <MessagesPanel agentId={agent.id} />}
          {tab === "tools" && <ToolsPanel agentId={agent.id} />}
          {tab === "tasks" && <TasksPanel agentId={agent.id} />}
          {tab === "memory" && <MemoryPanel agentId={agent.id} />}
        </>
      )}
    </Page>
  );
}

function MessagesPanel({ agentId }: { agentId: string }) {
  const [taskFilter, setTaskFilter] = useState("");
  const messages = useResource<{ items: MessageRow[] }>(
    () => api.get<{ items: MessageRow[] }>(`/api/agents/${agentId}/messages`, {
      task_id: taskFilter || undefined, limit: 120,
    }),
    { deps: [agentId, taskFilter], refreshOn: ["task.", "tool.", "plan."], debounce: 800 },
  );

  const taskIds = useMemo(
    () => [...new Set((messages.data?.items ?? []).map((row) => row.task_id).filter(Boolean))] as string[],
    [messages.data],
  );

  return (
    <Panel
      title="Conversation"
      subtitle="Every prompt sent to this agent and every reply it produced, stored verbatim."
      actions={
        <select className="field w-auto" value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}
                aria-label="Filter by task">
          <option value="">All tasks</option>
          {taskIds.map((id) => <option key={id} value={id}>{id.slice(0, 8)}</option>)}
        </select>
      }
      bodyClassName="p-3"
    >
      {messages.loading && !messages.data && <Loading label="Loading messages" />}
      {messages.error && <ErrorState message={messages.error} onRetry={messages.reload} />}
      {messages.data?.items.length === 0 && (
        <EmptyState title="No messages recorded"
                    body="Messages appear as soon as this agent runs a task. Secrets are redacted before storage." />
      )}
      <ol className="space-y-2">
        {(messages.data?.items ?? []).map((message) => (
          <li key={message.id}
              className={clsx("panel-flat p-2.5", message.role === "assistant" && "bg-accent-soft/40")}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={message.role === "assistant" ? "accent" : message.role === "tool" ? "warning" : "muted"}>
                {message.role}
              </Badge>
              {message.task_id && <span className="numeric text-[11px] text-ink-faint">{message.task_id.slice(0, 8)}</span>}
              <span className="numeric ml-auto text-[11px] text-ink-faint" title={message.created_at ?? ""}>
                {clockTime(message.created_at)}
              </span>
            </div>
            <pre className="code mt-1.5 max-h-64 overflow-y-auto">{message.content}</pre>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function ToolsPanel({ agentId }: { agentId: string }) {
  const [onlyFailures, setOnlyFailures] = useState(false);
  const calls = useResource<{ items: ToolCallRow[] }>(
    () => api.get<{ items: ToolCallRow[] }>(`/api/agents/${agentId}/tool-calls`, { limit: 80 }),
    { deps: [agentId], refreshOn: ["tool.", "task."], debounce: 500 },
  );

  const rows = (calls.data?.items ?? []).filter((row) => !onlyFailures || !row.ok || row.denied);
  const denied = (calls.data?.items ?? []).filter((row) => row.denied).length;
  const failed = (calls.data?.items ?? []).filter((row) => !row.ok && !row.denied).length;

  return (
    <Panel
      title="Tool calls"
      subtitle="Executed inside the project workspace only, through the policy layer."
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={denied ? "danger" : "muted"}><Ban size={10} /> {denied} denied</Badge>
          <Badge tone={failed ? "warning" : "muted"}>{failed} failed</Badge>
          <Button size="sm" variant={onlyFailures ? "accent" : "default"}
                  onClick={() => setOnlyFailures((value) => !value)}>
            Only problems
          </Button>
        </div>
      }
      bodyClassName="p-2"
    >
      {calls.loading && !calls.data && <Loading label="Loading tool calls" />}
      {calls.error && <ErrorState message={calls.error} onRetry={calls.reload} />}
      {rows.length === 0 && !calls.loading && (
        <div className="p-2">
          <EmptyState title={onlyFailures ? "No denied or failed calls" : "No tool calls yet"}
                      body={onlyFailures
                        ? "Every recorded call for this agent was allowed and succeeded."
                        : "Tool calls appear here the moment the agent touches the workspace."} />
        </div>
      )}
      <ul className="space-y-1">
        {rows.map((row) => <ToolCallRowView key={row.id} row={row} />)}
      </ul>
    </Panel>
  );
}

function ToolCallRowView({ row }: { row: ToolCallRow }) {
  const [open, setOpen] = useState(false);
  const tone = row.denied ? "danger" : row.ok ? "positive" : "warning";
  return (
    <li className="panel-flat">
      <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left row-hover"
              onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="numeric w-40 shrink-0 truncate text-[13px] font-medium">{row.tool}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
          {summariseArgs(row.args)}
        </span>
        {row.exit_code !== null && <span className="numeric text-[11px] text-ink-faint">exit {row.exit_code}</span>}
        <span className="numeric text-[11px] text-ink-faint">{duration(row.duration_ms)}</span>
        <Badge tone={tone}>{row.denied ? "denied" : row.ok ? "ok" : "failed"}</Badge>
        <span className="numeric w-16 shrink-0 text-right text-[11px] text-ink-faint">{timeAgo(row.created_at)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line-soft px-3 py-2.5">
          <KeyValue items={[
            ["Tool", <span className="numeric">{row.tool}</span>],
            ["Task", row.task_id ? <span className="numeric">{row.task_id.slice(0, 8)}</span> : "—"],
            ["Exit code", <span className="numeric">{row.exit_code ?? "—"}</span>],
            ["Duration", <span className="numeric">{duration(row.duration_ms)}</span>],
            ["When", clockTime(row.created_at)],
          ]} />
          {row.reason && (
            <div className="flex items-start gap-2 rounded-md border border-[#f2cfcc] bg-danger-soft px-2.5 py-2 text-xs text-danger">
              <Ban size={12} className="mt-0.5 shrink-0" />
              <span>{row.reason}</span>
            </div>
          )}
          <div>
            <p className="label">Arguments</p>
            <pre className="code mt-1 max-h-52 overflow-y-auto">{JSON.stringify(row.args, null, 2)}</pre>
          </div>
          <div>
            <p className="label">Result excerpt</p>
            <pre className="code mt-1 max-h-64 overflow-y-auto">{row.result_excerpt ?? "(no excerpt stored)"}</pre>
          </div>
        </div>
      )}
    </li>
  );
}

function summariseArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args ?? {}).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}=${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
  });
  return parts.join(" ") || "(no arguments)";
}

function TasksPanel({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const tasks = useResource<{ items: AgentTaskRow[] }>(
    () => api.get<{ items: AgentTaskRow[] }>(`/api/agents/${agentId}/tasks`, { limit: 60 }),
    { deps: [agentId], refreshOn: ["task.", "plan."], debounce: 600 },
  );

  return (
    <Panel title="Task history" subtitle="Newest first" bodyClassName="p-2">
      {tasks.loading && !tasks.data && <Loading label="Loading tasks" />}
      {tasks.error && <ErrorState message={tasks.error} onRetry={tasks.reload} />}
      {tasks.data?.items.length === 0 && (
        <div className="p-2"><EmptyState title="No tasks assigned yet" body="Route work to this agent from the Command Center." /></div>
      )}
      <table className="w-full text-[13px]">
        <thead>
          <tr className="label border-b border-line text-left">
            <th className="px-2.5 py-1.5 font-medium">Task</th>
            <th className="px-2.5 py-1.5 font-medium">Title</th>
            <th className="px-2.5 py-1.5 font-medium">Files</th>
            <th className="px-2.5 py-1.5 font-medium">Status</th>
            <th className="px-2.5 py-1.5 text-right font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {(tasks.data?.items ?? []).map((task) => (
            <tr key={task.id} className="border-b border-line-soft last:border-0 row-hover">
              <td className="px-2.5 py-1.5">
                <button type="button" className="numeric text-accent hover:underline"
                        onClick={() => navigate(`/tasks?task=${task.id}`)}>
                  {task.external_id}
                </button>
              </td>
              <td className="max-w-[320px] truncate px-2.5 py-1.5">{task.title}</td>
              <td className="numeric px-2.5 py-1.5 text-xs text-ink-faint">{task.files_changed.length}</td>
              <td className="px-2.5 py-1.5">
                <span className="flex items-center gap-2">
                  <Badge tone={toneFor("task", task.status)}>{task.status}</Badge>
                  {task.retries > 0 && <span className="numeric text-[11px] text-warning">{task.retries} retries</span>}
                </span>
              </td>
              <td className="numeric px-2.5 py-1.5 text-right text-[11px] text-ink-faint">{timeAgo(task.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function MemoryPanel({ agentId }: { agentId: string }) {
  const [query, setQuery] = useState("");
  const memory = useResource<{ namespace: string; items: MemoryItem[]; count: number }>(
    () => api.get<{ namespace: string; items: MemoryItem[]; count: number }>(`/api/agents/${agentId}/memory`, {
      q: query || undefined, limit: 25,
    }),
    { deps: [agentId, query], refreshOn: ["memory.", "plan.finished"], debounce: 700 },
  );

  return (
    <Panel
      title="Recalled memory"
      subtitle={memory.data ? `namespace ${memory.data.namespace} · scoped to this agent plus project/company lessons` : undefined}
      actions={
        <input className="field w-56" placeholder="Filter by keyword…" value={query}
               onChange={(event) => setQuery(event.target.value)} aria-label="Search memory" />
      }
    >
      {memory.loading && !memory.data && <Loading label="Loading memory" />}
      {memory.error && <ErrorState message={memory.error} onRetry={memory.reload} />}
      {memory.data?.items.length === 0 && (
        <EmptyState title="Nothing stored"
                    body={query
                      ? "No memory entry matches that keyword."
                      : "The agent writes lessons after a run finishes; they are recalled into later prompts."} />
      )}
      <ul className="space-y-2">
        {(memory.data?.items ?? []).map((item) => (
          <li key={item.id} className="panel-flat p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="numeric text-[13px] font-medium">{item.key}</span>
              <Badge tone="muted">{item.scope}</Badge>
              <Badge tone="muted">{item.kind}</Badge>
              <span className="numeric ml-auto text-[11px] text-ink-faint">score {item.score.toFixed(3)}</span>
            </div>
            <p className="mt-1.5 text-[13px] text-ink-soft">{item.content}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
