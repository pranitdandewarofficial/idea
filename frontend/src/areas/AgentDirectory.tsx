/**
 * Area 3 - Agent Directory: the twelve real profiles loaded from the backend.
 * Every control here writes through PATCH /api/agents/{id}; the tool whitelist can
 * only ever be narrowed, because the backend rejects anything the profile does not
 * authorise (409 tool_not_permitted).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { clsx } from "clsx";
import {
  Brain, Check, FlaskConical, Lock, Pencil, ShieldAlert, Terminal, Trash2, X,
} from "lucide-react";
import { api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { Page } from "../components/Shell";
import {
  Badge, Button, EmptyState, ErrorState, Field, KeyValue, Loading, Panel, Stat, Toggle,
} from "../components/ui";
import { initials, timeAgo, toneFor } from "../lib/format";
import type {
  Agent, AgentTaskRow, MemoryItem, Provider, ProviderSummary,
} from "../lib/types";

interface ToolDescriptor {
  name: string;
  description: string;
  category: string;
  gated: boolean;
  risk: number;
  params: string[];
}

interface ToolPolicy {
  agent_id: string;
  authorised: ToolDescriptor[];
  granted: string[];
  revoked: string[];
  catalogue_size: number;
}

interface ModelTest {
  ok: boolean;
  provider_id: string;
  model: string | null;
  role: string;
  reply: string;
  latency_ms: number;
  tokens: number;
  mocked: boolean;
}

export function AgentDirectory() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  const agents = useResource<{ items: Agent[]; count: number }>(
    () => api.get<{ items: Agent[]; count: number }>("/api/agents", { q: query || undefined }),
    { refreshOn: ["agent.", "task.", "plan.", "settings."], debounce: 600, deps: [query] },
  );

  const items = useMemo(() => {
    const rows = agents.data?.items ?? [];
    return status ? rows.filter((agent) => agent.status === status) : rows;
  }, [agents.data, status]);

  const departments = useMemo(() => {
    const grouped = new Map<string, Agent[]>();
    for (const agent of items) {
      const bucket = grouped.get(agent.department) ?? [];
      bucket.push(agent);
      grouped.set(agent.department, bucket);
    }
    return [...grouped.entries()];
  }, [items]);

  const selected = items.find((agent) => agent.id === agentId) ?? null;
  const working = items.filter((agent) => agent.status === "working" || agent.status === "collaborating").length;
  const blocked = items.filter((agent) => agent.status === "blocked").length;
  const disabled = items.filter((agent) => !agent.is_enabled).length;

  return (
    <Page className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Agents" value={agents.data?.count ?? "—"} hint="11 specialists + the decision agent" />
        <Stat label="Working now" value={working} hint={blocked ? `${blocked} blocked` : "nothing blocked"}
              tone={working ? "accent" : "muted"} />
        <Stat label="Disabled" value={disabled} hint="excluded from routing" tone={disabled ? "warning" : "muted"} />
        <Stat label="Live load" value={(items).reduce((sum, agent) => sum + (agent.load ?? 0), 0)}
              hint="queued + running tasks" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="field max-w-xs"
          placeholder="Search name, role, skill…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search agents"
        />
        <select className="field w-auto" value={status} onChange={(event) => setStatus(event.target.value)}
                aria-label="Filter by status">
          <option value="">Any status</option>
          {["idle", "working", "collaborating", "waiting", "blocked", "offline"].map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        {agents.reloading && <span className="text-xs text-ink-faint">refreshing…</span>}
      </div>

      {agents.error && !agents.data && <ErrorState message={agents.error} onRetry={agents.reload} />}
      {agents.loading && !agents.data && <Loading label="Loading the roster" />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="space-y-4">
          {departments.map(([department, rows]) => (
            <Panel key={department} title={department} subtitle={`${rows.length} agent${rows.length === 1 ? "" : "s"}`}
                   bodyClassName="p-2">
              <ul className="space-y-1">
                {rows.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/agents/${agent.id}`)}
                      className={clsx("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left row-hover",
                                      agent.id === agentId && "bg-accent-soft")}
                    >
                      <Avatar agent={agent} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium">{agent.name}</span>
                          {agent.is_decision_agent && <Badge tone="accent"><Brain size={10} /> system 1</Badge>}
                          {!agent.is_enabled && <Badge tone="muted">off</Badge>}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-faint">{agent.role}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={toneFor("agent", agent.status)}>{agent.status}</Badge>
                        {(agent.load ?? 0) > 0 && <span className="numeric text-[11px] text-ink-faint">{agent.load} task(s)</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
          {!agents.loading && items.length === 0 && (
            <EmptyState title="No agent matches that filter"
                        body="Clear the search box or pick another status." />
          )}
        </div>

        {selected ? (
          <AgentDetail key={selected.id} agent={selected} onChanged={agents.reload} />
        ) : (
          <Panel title="Agent detail">
            <EmptyState title="Pick an agent"
                        body="Select a person on the left to see their real configuration: model, whitelist, output contract, recent tasks and memory namespace." />
          </Panel>
        )}
      </div>
    </Page>
  );
}

export function Avatar({ agent, size = 32 }: { agent: { name: string; avatar_seed?: string; status?: string }; size?: number }) {
  const hue = useMemo(() => {
    const seed = agent.avatar_seed || agent.name;
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
    return hash;
  }, [agent.avatar_seed, agent.name]);
  return (
    <span
      className="numeric flex shrink-0 items-center justify-center rounded-md font-semibold text-white"
      style={{
        width: size, height: size, fontSize: size * 0.36,
        background: `hsl(${hue} 42% 46%)`,
      }}
      aria-hidden
    >
      {initials(agent.name)}
    </span>
  );
}

function AgentDetail({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const navigate = useNavigate();
  const pushToast = useApp((state) => state.pushToast);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ModelTest | null>(null);
  const [draft, setDraft] = useState({
    provider_id: agent.provider_id ?? "",
    model: agent.model ?? "",
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    max_parallel_tasks: agent.max_parallel_tasks,
    is_enabled: agent.is_enabled,
    tools: agent.tools,
  });

  useEffect(() => {
    setDraft({
      provider_id: agent.provider_id ?? "",
      model: agent.model ?? "",
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      max_parallel_tasks: agent.max_parallel_tasks,
      is_enabled: agent.is_enabled,
      tools: agent.tools,
    });
    setEditing(false);
    setTest(null);
    setError(null);
  }, [agent.id, agent.provider_id, agent.model, agent.temperature, agent.max_tokens,
      agent.max_parallel_tasks, agent.is_enabled, agent.tools]);

  const policy = useResource<ToolPolicy>(() => api.get<ToolPolicy>(`/api/agents/${agent.id}/tools`), {
    deps: [agent.id, agent.tools], refreshOn: ["agent.", "tool.denied"], debounce: 800,
  });
  const tasks = useResource<{ items: AgentTaskRow[] }>(
    () => api.get<{ items: AgentTaskRow[] }>(`/api/agents/${agent.id}/tasks`, { limit: 20 }),
    { deps: [agent.id], refreshOn: ["task.", "plan."], debounce: 600 },
  );
  const memory = useResource<{ namespace: string; items: MemoryItem[]; count: number }>(
    () => api.get<{ namespace: string; items: MemoryItem[]; count: number }>(`/api/agents/${agent.id}/memory`, { limit: 20 }),
    { deps: [agent.id], refreshOn: ["memory.", "task.", "plan.finished"], debounce: 1200 },
  );
  const providerList = useResource<{ items: Provider[] }>(() => api.get<{ items: Provider[] }>("/api/providers"), {
    refreshOn: ["provider."], debounce: 1500,
  });

  const run = async (key: string, call: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError(null);
    try {
      const result = await call();
      pushToast({ title: message, tone: "success" });
      onChanged();
      return result;
    } catch (cause) {
      setError(describeError(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    void run("save", async () => {
      const patch = {
        provider_id: draft.provider_id || null,
        model: draft.model.trim() || null,
        temperature: Number(draft.temperature),
        max_tokens: Number(draft.max_tokens),
        max_parallel_tasks: Number(draft.max_parallel_tasks),
        is_enabled: draft.is_enabled,
        tools: draft.tools,
      };
      await api.patch(`/api/agents/${agent.id}`, patch);
      setEditing(false);
    }, "Agent configuration saved");

  const toggleTool = (name: string) => {
    setDraft((current) => ({
      ...current,
      tools: current.tools.includes(name)
        ? current.tools.filter((tool) => tool !== name)
        : [...current.tools, name].sort(),
    }));
  };

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Avatar agent={agent} size={26} /> {agent.name}
            <span className="text-[13px] font-normal text-ink-faint">· {agent.role}</span>
          </span>
        }
        subtitle={agent.personality || undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={toneFor("agent", agent.status)}>{agent.status}</Badge>
            {agent.is_decision_agent && <Badge tone="accent"><Brain size={11} /> decision agent</Badge>}
            <Button size="sm" onClick={() => navigate(`/workspace/${agent.id}`)}>
              <Terminal size={13} /> Workspace
            </Button>
            <Button size="sm" variant={editing ? "ghost" : "default"} onClick={() => setEditing((value) => !value)}>
              {editing ? <X size={13} /> : <Pencil size={13} />} {editing ? "Cancel" : "Configure"}
            </Button>
          </div>
        }
      >
        {error && <div className="mb-3"><ErrorState message={error} /></div>}

        {editing ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider" hint="Leave empty to use the company default provider.">
                <select className="field" value={draft.provider_id}
                        onChange={(event) => setDraft({ ...draft, provider_id: event.target.value })}>
                  <option value="">Company default</option>
                  {(providerList.data?.items ?? []).map((provider: Provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label} ({provider.kind}{provider.is_paid ? ", paid" : ", free"})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" hint="Optional override of the provider's default model.">
                <input className="field" value={draft.model} placeholder="e.g. llama3.1:8b"
                       onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
              </Field>
              <Field label="Temperature" hint="0.0 - 2.0">
                <input className="field numeric" type="number" step="0.05" min={0} max={2}
                       value={draft.temperature}
                       onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} />
              </Field>
              <Field label="Max tokens per turn" hint="128 - 32768">
                <input className="field numeric" type="number" step="128" min={128} max={32768}
                       value={draft.max_tokens}
                       onChange={(event) => setDraft({ ...draft, max_tokens: Number(event.target.value) })} />
              </Field>
              <Field label="Parallel tasks" hint="1 - 4; the orchestrator never exceeds this.">
                <input className="field numeric" type="number" min={1} max={4}
                       value={draft.max_parallel_tasks}
                       onChange={(event) => setDraft({ ...draft, max_parallel_tasks: Number(event.target.value) })} />
              </Field>
              <div className="flex items-end">
                <Toggle checked={draft.is_enabled} label="Enabled"
                        description="Disabled agents are excluded from routing."
                        onChange={(next) => setDraft({ ...draft, is_enabled: next })} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="accent" busy={busy === "save"} onClick={save}>
                <Check size={13} /> Save configuration
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <KeyValue
              items={[
                ["Department", agent.department],
                ["Model role", <span className="numeric">{agent.model_role}</span>],
                ["Provider", agent.provider_id
                  ? <span className="numeric">{providerName(providerList.data?.items ?? [], agent.provider_id)}</span>
                  : "company default"],
                ["Model", agent.model ? <span className="numeric">{agent.model}</span> : "provider default"],
                ["Temperature", <span className="numeric">{agent.temperature}</span>],
                ["Max tokens", <span className="numeric">{agent.max_tokens}</span>],
                ["Parallel tasks", <span className="numeric">{agent.max_parallel_tasks}</span>],
                ["Memory namespace", <span className="numeric">{agent.memory_namespace}</span>],
                ["Current task", agent.current_task
                  ? <span className="numeric">{agent.current_task.title} ({agent.current_task.status})</span>
                  : "none"],
                ["Enabled", agent.is_enabled ? "yes" : "no - excluded from routing"],
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" busy={busy === "test"}
                      onClick={() => void run("test", async () => {
                        const result = await api.post<ModelTest>(`/api/agents/${agent.id}/test-model`);
                        setTest(result);
                        return result;
                      }, "Model reachable")}>
                <FlaskConical size={13} /> Test model connection
              </Button>
              {memory.data && memory.data.count > 0 && (
                <Button size="sm" variant="danger" busy={busy === "forget"}
                        onClick={() => void run("forget", async () => {
                          await api.del(`/api/agents/${agent.id}/memory`);
                          memory.reload();
                        }, "Agent memory cleared")}>
                  <Trash2 size={13} /> Clear memory
                </Button>
              )}
            </div>
            {test && <ModelTestResult result={test} />}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Charter" subtitle="Fixed by the profile; not editable from the UI">
          <div className="space-y-3 text-[13px]">
            <List label="Responsibilities" items={agent.responsibilities} />
            <List label="Skills" items={agent.skills} chips />
            <div>
              <p className="label flex items-center gap-1 text-danger">
                <ShieldAlert size={11} /> Explicitly prohibited
              </p>
              <ul className="mt-1 space-y-0.5 text-danger">
                {agent.prohibited.map((item) => <li key={item}>· {item}</li>)}
              </ul>
            </div>
            <div>
              <p className="label">Output contract</p>
              <pre className="code mt-1">{JSON.stringify(agent.output_contract, null, 2)}</pre>
            </div>
          </div>
        </Panel>

        <Panel
          title="Tool whitelist"
          subtitle={policy.data
            ? `${policy.data.granted.length} granted of ${policy.data.authorised.length} authorised · catalogue has ${policy.data.catalogue_size} tools`
            : "Least privilege: the backend rejects any tool the profile does not authorise"}
          actions={editing ? <Badge tone="warning">editing</Badge> : undefined}
        >
          {policy.loading && !policy.data && <Loading label="Loading policy" />}
          {policy.error && <ErrorState message={policy.error} onRetry={policy.reload} />}
          {policy.data && (
            <ul className="space-y-1">
              {policy.data.authorised.map((tool) => {
                const granted = draft.tools.includes(tool.name);
                return (
                  <li key={tool.name}
                      className={clsx("flex items-start gap-2 rounded-md border px-2.5 py-2",
                                      granted ? "border-line bg-surface" : "border-line-soft bg-sunken/60")}>
                    {editing ? (
                      <input type="checkbox" className="mt-1" checked={granted}
                             onChange={() => toggleTool(tool.name)} aria-label={`Grant ${tool.name}`} />
                    ) : (
                      <span className={clsx("mt-1 h-2 w-2 shrink-0 rounded-full",
                                            granted ? "bg-positive" : "bg-[#c9cddb]")} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="numeric text-[13px] font-medium">{tool.name}</span>
                        <Badge tone="muted">{tool.category}</Badge>
                        {tool.gated && <Badge tone="warning"><Lock size={10} /> approval gated</Badge>}
                        {tool.risk >= 0.6 && <Badge tone="danger">risk {tool.risk.toFixed(2)}</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-faint">{tool.description}</span>
                    </span>
                  </li>
                );
              })}
              {policy.data.authorised.length === 0 && (
                <EmptyState title="No tools authorised"
                            body="This agent reasons only; it cannot touch the filesystem or the shell." />
              )}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent tasks" subtitle="Everything this agent was really assigned" bodyClassName="p-2">
          {tasks.loading && !tasks.data && <Loading label="Loading tasks" />}
          {tasks.data?.items.length === 0 && (
            <div className="p-2">
              <EmptyState title="No tasks yet" body="Submit an objective in the Command Center and the CEO will route work here." />
            </div>
          )}
          <ul className="space-y-1">
            {(tasks.data?.items ?? []).map((task) => (
              <li key={task.id} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 row-hover">
                <span className="numeric w-14 shrink-0 text-[11px] text-ink-faint">{task.external_id}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>
                {task.retries > 0 && <Badge tone="warning">{task.retries} retried</Badge>}
                <Badge tone={toneFor("task", task.status)}>{task.status}</Badge>
                <span className="numeric w-16 shrink-0 text-right text-[11px] text-ink-faint">{timeAgo(task.created_at)}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Memory" subtitle={memory.data ? `namespace ${memory.data.namespace}` : undefined}>
          {memory.loading && !memory.data && <Loading label="Loading memory" />}
          {memory.error && <ErrorState message={memory.error} onRetry={memory.reload} />}
          {memory.data?.items.length === 0 && (
            <EmptyState title="Nothing remembered yet"
                        body="Lessons are written after a run finishes; they are recalled into the agent's next prompt." />
          )}
          <ul className="space-y-2">
            {(memory.data?.items ?? []).map((item) => (
              <li key={item.id} className="panel-flat p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="numeric truncate text-[12px] font-medium">{item.key}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Badge tone="muted">{item.kind}</Badge>
                    <span className="numeric text-[11px] text-ink-faint">score {item.score.toFixed(2)}</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">{item.content}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function providerName(items: (Provider | ProviderSummary)[], id: string): string {
  const found = items.find((provider) => provider.id === id);
  return found ? `${found.label} (${found.kind})` : id;
}

function ModelTestResult({ result }: { result: ModelTest }) {
  return (
    <div className={clsx("rounded-md border px-3 py-2 text-[13px]",
                         result.ok ? "border-[#cfe8da] bg-positive-soft text-positive"
                                   : "border-[#f2cfcc] bg-danger-soft text-danger")}>
      <p className="font-medium">
        {result.ok ? "Model reachable" : "Model call failed"} · <span className="numeric">{result.latency_ms.toFixed(0)} ms</span>
      </p>
      <p className="numeric mt-0.5 text-xs text-ink-soft">
        {result.provider_id} / {result.model ?? "?"} · role {result.role} · {result.tokens} tokens
      </p>
      <p className="mt-1 text-xs text-ink-soft">reply: “{result.reply}”</p>
      {result.mocked && (
        <p className="mt-1 text-xs text-warning">
          This was the offline mock provider - it proves the wiring, not a real model. No delivery can be
          labelled successful on a mocked run.
        </p>
      )}
    </div>
  );
}

function List({ label, items, chips }: { label: string; items: string[]; chips?: boolean }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="label">{label}</p>
      {chips ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {items.map((item) => <Badge key={item} tone="muted">{item}</Badge>)}
        </div>
      ) : (
        <ul className="mt-1 space-y-0.5 text-ink-soft">
          {items.map((item) => <li key={item}>· {item}</li>)}
        </ul>
      )}
    </div>
  );
}
