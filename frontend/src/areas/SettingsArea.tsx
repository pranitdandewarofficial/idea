/**
 * Area 10 - Settings: the real configuration surface.
 * Values come from GET /api/settings (which merges the built-in defaults with the
 * stored rows) and are saved with PATCH. The danger zone calls the purge and memory
 * endpoints, which report exactly how many rows they deleted.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { clsx } from "clsx";
import {
  AlertOctagon, Check, Copy, Database, Eye, EyeOff, Gauge, KeyRound, RefreshCw, Save,
  ShieldCheck, Terminal,
} from "lucide-react";
import { api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { Page } from "../components/Shell";
import {
  Badge, Button, CopyButton, ErrorState, Field, KeyValue, Loading, Panel, Stat, Toggle,
} from "../components/ui";
import { compactNumber, duration, money, percent } from "../lib/format";
import type { Health, Provider, SettingsResponse, SetupStatus, UsageSummary } from "../lib/types";

/** Keys the backend describes but does not seed in SETTING_KEYS; these match app/config.py. */
const BUILTIN_DEFAULTS: Record<string, string | number | boolean> = {
  max_tasks_per_agent: 1,
  low_risk_threshold: 0.4,
  approval_timeout_seconds: 0,
};

const GROUPS: { title: string; subtitle: string; keys: string[] }[] = [
  {
    title: "Spend and safety",
    subtitle: "The switches that keep a run from costing money or doing damage.",
    keys: ["zero_spend", "auto_approve_low_risk", "low_risk_threshold", "approval_timeout_seconds", "guardrail_sensitivity"],
  },
  {
    title: "Execution limits",
    subtitle: "Bounded concurrency, timeouts and retries - the reason a run cannot loop forever.",
    keys: ["max_concurrency", "max_tasks_per_agent", "task_timeout_seconds", "shell_timeout_seconds", "max_repairs", "sandbox_tier"],
  },
  {
    title: "Decision layer",
    subtitle: "System 1 acts on its own only above the gate; below it, the LLM or a human decides.",
    keys: ["decisions_enabled", "decision_mode", "decision_confidence_threshold"],
  },
  {
    title: "Token budgets",
    subtitle: "Hitting either budget pauses the run and raises an approval instead of spending more.",
    keys: ["plan_token_budget", "global_token_budget"],
  },
  {
    title: "Providers and display",
    subtitle: "Which provider an agent gets when it has no explicit assignment.",
    keys: ["default_provider_id", "fallback_provider_id", "compact_mode"],
  },
];

const DECISION_MODES = ["auto", "laya", "laya_mnn", "laya_hosted", "local", "llm"];
const GUARDRAIL_LEVELS = ["low", "medium", "high"];

interface BudgetResponse {
  global: UsageSummary;
  global_token_budget: number;
  plan_token_budget: number;
  zero_spend: boolean;
}

export function SettingsArea() {
  const { settingsMeta, health, setup, refreshSettings, refreshHealth, refreshSetup } = useApp();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [showToken, setShowToken] = useState(false);

  const meta = useResource<SettingsResponse | null>(
    async () => settingsMeta ?? api.get<SettingsResponse>("/api/settings"),
    { refreshOn: ["settings."], debounce: 2000 },
  );
  const effective = meta.data ?? settingsMeta;

  const providers = useResource<{ items: Provider[] }>(() => api.get<{ items: Provider[] }>("/api/providers"), {
    refreshOn: ["provider."], debounce: 3000,
  });
  const budget = useResource<BudgetResponse>(() => api.get<BudgetResponse>("/api/settings/budget"), {
    refreshOn: ["budget.", "usage.", "plan.", "task."], debounce: 2000,
  });

  useEffect(() => {
    if (effective) setDraft({ ...effective.values });
  }, [effective]);

  const dirty = useMemo(() => {
    if (!effective) return [];
    return Object.keys(draft).filter((key) => draft[key] !== effective.values[key]);
  }, [draft, effective]);

  const save = async () => {
    if (!effective || dirty.length === 0) return;
    setBusy("save");
    setError(null);
    setSaved(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of dirty) patch[key] = draft[key];
      const result = await api.patch<{ values: Record<string, unknown>; changed: string[] }>("/api/settings", patch);
      setDraft(result.values);
      setSaved(result.changed);
      await refreshSettings();
      meta.reload();
      budget.reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const values = effective?.values ?? ({} as Record<string, unknown>);
  const descriptions = effective?.descriptions ?? {};
  const defaults = effective?.defaults ?? {};

  const valueFor = (key: string): unknown =>
    key in draft ? draft[key] : values[key] ?? defaults[key] ?? BUILTIN_DEFAULTS[key] ?? "";

  return (
    <Page className="space-y-4">
      <SetupChecklist setup={setup} health={health} onRefresh={() => { void refreshSetup(); void refreshHealth(); }} />

      {error && <ErrorState message={error} />}
      {saved && (
        <div className="flex items-center gap-2 rounded-md border border-[#cfe8da] bg-positive-soft px-3 py-2 text-[13px] text-positive">
          <Check size={14} /> Saved: <span className="numeric">{saved.join(", ")}</span>
        </div>
      )}

      <Panel
        title="Token usage and budgets"
        subtitle="Counted by the registry on every completion, mocked or not."
        actions={<Button size="sm" onClick={() => budget.reload()}><RefreshCw size={12} /> Refresh</Button>}
      >
        {budget.loading && !budget.data && <Loading label="Loading budgets" />}
        {budget.data && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Global tokens" value={compactNumber(budget.data.global.tokens_total)}
                  hint={`${compactNumber(budget.data.global.tokens_in)} in / ${compactNumber(budget.data.global.tokens_out)} out`} />
            <Stat label="Global budget" value={compactNumber(budget.data.global_token_budget)}
                  hint={`${percent(1 - budget.data.global.tokens_total / Math.max(1, budget.data.global_token_budget))} remaining`}
                  tone={budget.data.global.tokens_total > budget.data.global_token_budget ? "danger" : "positive"} />
            <Stat label="Per-plan budget" value={compactNumber(budget.data.plan_token_budget)}
                  hint="a plan that exceeds it pauses and asks" />
            <Stat label="Cost so far" value={money(budget.data.global.cost_estimate)}
                  hint={`${budget.data.global.calls} calls · ${budget.data.global.mocked_calls} mocked · avg ${duration(budget.data.global.avg_latency_ms)}`}
                  tone={budget.data.global.cost_estimate > 0 ? "warning" : "positive"} />
          </div>
        )}
      </Panel>

      {GROUPS.map((group) => (
        <Panel key={group.title} title={group.title} subtitle={group.subtitle}>
          <div className="space-y-1">
            {group.keys.map((key) => (
              <SettingRow
                key={key}
                settingKey={key}
                description={descriptions[key] ?? ""}
                defaultValue={defaults[key] ?? BUILTIN_DEFAULTS[key]}
                value={valueFor(key)}
                providers={providers.data?.items ?? []}
                busy={busy === "save"}
                onChange={(next) => setDraft((current) => ({ ...current, [key]: next }))}
              />
            ))}
          </div>
        </Panel>
      ))}

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface/95 p-3 shadow-panel backdrop-blur">
        <span className="text-[13px] text-ink-soft">
          {dirty.length === 0
            ? "No unsaved change."
            : <span>{dirty.length} change(s): <span className="numeric">{dirty.join(", ")}</span></span>}
        </span>
        <span className="ml-auto flex gap-2">
          <Button size="sm" disabled={dirty.length === 0} onClick={() => setDraft({ ...values })}>Discard</Button>
          <Button size="sm" variant="accent" busy={busy === "save"} disabled={dirty.length === 0}
                  onClick={() => void save()}>
            <Save size={13} /> Save settings
          </Button>
        </span>
      </div>

      <Panel title="Local paths and access" subtitle="Everything stays on this machine.">
        {effective && (
          <div className="space-y-3">
            <KeyValue items={[
              ["Data directory", <span className="numeric">{effective.paths.data_dir}</span>],
              ["Workspaces", <span className="numeric">{effective.paths.workspaces_dir}</span>],
              ["Database", <span className="numeric">{effective.paths.database}</span>],
              ["API base", <span className="numeric">{setup?.api_base ?? "—"}</span>],
              ["Auth", effective.auth_enabled ? "bearer token required on every /api route" : "disabled (not recommended)"],
              ["Sandbox", <span className="numeric">tier {effective.sandbox.tier} · image {effective.sandbox.docker_image}</span>],
              ["Runtime", <span className="numeric">python {health?.python ?? "—"} · {health?.platform ?? "—"}</span>],
            ]} />
            <div className="panel-flat flex flex-wrap items-center gap-2 p-3">
              <KeyRound size={14} className="text-ink-faint" />
              <span className="text-[13px]">API token</span>
              <code className="numeric flex-1 truncate text-xs text-ink-soft">
                {showToken ? effective.api_token ?? "(auth disabled)" : "•".repeat(Math.min(32, (effective.api_token ?? "").length || 12))}
              </code>
              <Button size="sm" variant="ghost" onClick={() => setShowToken((value) => !value)}
                      title={showToken ? "Hide" : "Reveal"}>
                {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
              </Button>
              {effective.api_token && <CopyButton value={effective.api_token} label="Copy token" />}
            </div>
            <p className="text-xs text-ink-faint">
              The token is generated at first boot and stored in <span className="numeric">backend/.data/api_token</span>.
              The browser keeps it in memory only - never in localStorage, a cookie or the URL. Provider keys are
              encrypted with Fernet and are never returned by any endpoint.
            </p>
          </div>
        )}
      </Panel>

      <DangerZone onBusy={setBusy} busy={busy} onError={setError} onDone={() => { meta.reload(); budget.reload(); }} />
    </Page>
  );
}

function SetupChecklist({ setup, health, onRefresh }: { setup: SetupStatus | null; health: Health | null; onRefresh: () => void }) {
  const rows: { label: string; ok: boolean; detail: string; to?: string }[] = [
    {
      label: "Backend reachable", ok: Boolean(health?.ok),
      detail: health ? `v${health.version} · ${health.counts.providers} provider(s) · ${health.counts.plans} plan(s)` : "no response from /api/health",
    },
    {
      label: "A provider is configured", ok: Boolean(setup?.has_provider),
      detail: setup?.providers.length
        ? setup.providers.map((provider) => `${provider.label} (${provider.kind}${provider.is_enabled ? "" : ", disabled"})`).join(", ")
        : "add Ollama or the offline mock provider",
      to: "/providers",
    },
    {
      label: "A free/local provider exists", ok: Boolean(setup?.has_free_provider),
      detail: setup?.has_free_provider
        ? "runs are possible under zero-spend"
        : "every configured provider is marked paid, so zero-spend blocks all calls",
      to: "/providers",
    },
    {
      label: "Zero-spend mode", ok: Boolean(setup?.zero_spend),
      detail: setup?.zero_spend ? "paid providers are blocked unless a run authorises spend" : "paid calls are allowed - spend can occur",
      to: "/providers",
    },
    {
      label: "Decision layer", ok: Boolean(setup?.decision_layer.enabled),
      detail: setup
        ? `${setup.decision_layer.engine} · gate ${setup.decision_layer.threshold} · Laya ${setup.decision_layer.laya_available ? "loaded" : `unavailable (${setup.decision_layer.laya_reason})`}`
        : "unknown",
      to: "/activity",
    },
    {
      label: "Sandbox", ok: (setup?.sandbox.tier ?? 1) >= 1,
      detail: `tier ${setup?.sandbox.tier ?? health?.sandbox_tier ?? "?"} · docker ${setup?.sandbox.docker_available || health?.docker_available ? "available" : "not available (subprocess sandbox with resource limits is used)"}`,
    },
    {
      label: "Setup complete", ok: Boolean(setup?.complete),
      detail: setup?.complete ? "the company can take an objective" : "resolve the items above first",
      to: "/command",
    },
  ];

  return (
    <Panel
      title="Readiness"
      subtitle="Computed from /api/setup/status and /api/health - not a decorative checklist."
      actions={<Button size="sm" onClick={onRefresh}><RefreshCw size={12} /> Re-check</Button>}
      bodyClassName="p-2"
    >
      <ul className="grid gap-1 md:grid-cols-2">
        {rows.map((row) => (
          <li key={row.label} className="flex items-start gap-2 rounded-md px-2.5 py-2">
            <span className={clsx("mt-1 h-2 w-2 shrink-0 rounded-full", row.ok ? "bg-positive" : "bg-warning")} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{row.label}</span>
                <Badge tone={row.ok ? "positive" : "warning"}>{row.ok ? "ok" : "action needed"}</Badge>
                {row.to && <Link className="text-[11px] text-accent hover:underline" to={row.to}>open</Link>}
              </span>
              <span className="mt-0.5 block text-xs text-ink-faint">{row.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SettingRow({
  settingKey, description, defaultValue, value, providers, onChange, busy,
}: {
  settingKey: string;
  description: string;
  defaultValue: unknown;
  value: unknown;
  providers: Provider[];
  onChange: (next: unknown) => void;
  busy: boolean;
}) {
  const changed = value !== defaultValue && defaultValue !== undefined;
  const label = settingKey.replace(/_/g, " ");

  if (typeof value === "boolean" || typeof defaultValue === "boolean") {
    return (
      <Toggle
        checked={Boolean(value)}
        onChange={onChange}
        disabled={busy}
        label={label}
        description={<span>{description}{changed && <span className="numeric ml-1 text-accent">(default: {String(defaultValue)})</span>}</span>}
      />
    );
  }

  if (settingKey === "decision_mode") {
    return (
      <TextRow label={label} description={description} defaultValue={defaultValue} changed={changed}>
        <select className="field w-auto" value={String(value)} disabled={busy}
                onChange={(event) => onChange(event.target.value)}>
          {DECISION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </TextRow>
    );
  }

  if (settingKey === "guardrail_sensitivity") {
    return (
      <TextRow label={label} description={description} defaultValue={defaultValue} changed={changed}>
        <select className="field w-auto" value={String(value)} disabled={busy}
                onChange={(event) => onChange(event.target.value)}>
          {GUARDRAIL_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </TextRow>
    );
  }

  if (settingKey === "default_provider_id" || settingKey === "fallback_provider_id") {
    return (
      <TextRow label={label} description={description} defaultValue={defaultValue} changed={changed}>
        <select className="field w-auto max-w-xs" value={String(value ?? "")} disabled={busy}
                onChange={(event) => onChange(event.target.value)}>
          <option value="">{settingKey === "fallback_provider_id" ? "No fallback" : "Automatic (first enabled free provider)"}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label} ({provider.kind}{provider.is_paid ? ", paid" : ", free"})
            </option>
          ))}
        </select>
      </TextRow>
    );
  }

  if (typeof value === "number") {
    const step = settingKey === "decision_confidence_threshold" || settingKey === "low_risk_threshold" ? 0.05 : 1;
    return (
      <TextRow label={label} description={description} defaultValue={defaultValue} changed={changed}>
        <input className="field numeric w-36" type="number" step={step} value={Number(value)} disabled={busy}
               onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value))} />
      </TextRow>
    );
  }

  return (
    <TextRow label={label} description={description} defaultValue={defaultValue} changed={changed}>
      <input className="field numeric w-56" value={String(value ?? "")} disabled={busy}
             onChange={(event) => onChange(event.target.value)} />
    </TextRow>
  );
}

function TextRow({
  label, description, defaultValue, changed, children,
}: {
  label: string; description: string; defaultValue: unknown; changed: boolean; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft py-2.5 last:border-0">
      <div className="min-w-0 max-w-xl">
        <p className="text-[13px] font-medium capitalize">{label}</p>
        <p className="mt-0.5 text-xs text-ink-faint">
          {description}
          {changed && <span className="numeric ml-1 text-accent">(default: {String(defaultValue)})</span>}
        </p>
      </div>
      {children}
    </div>
  );
}

function DangerZone({
  busy, onBusy, onError, onDone,
}: {
  busy: string | null;
  onBusy: (value: string | null) => void;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const pushToast = useApp((state) => state.pushToast);
  const [days, setDays] = useState(7);
  const [includeToolCalls, setIncludeToolCalls] = useState(false);
  const [includeDecisions, setIncludeDecisions] = useState(false);
  const [includeMessages, setIncludeMessages] = useState(false);
  const [scope, setScope] = useState("company");
  const [result, setResult] = useState<string | null>(null);

  const purge = async () => {
    onBusy("purge");
    onError("");
    try {
      const outcome = await api.post<{ deleted: Record<string, number>; cutoff: string }>("/api/settings/purge", undefined, {
        events_older_than_days: days,
        include_tool_calls: includeToolCalls,
        include_decisions: includeDecisions,
        include_messages: includeMessages,
      });
      const total = Object.values(outcome.deleted).reduce((sum, value) => sum + value, 0);
      setResult(`Deleted ${total} row(s) older than ${outcome.cutoff}: ${JSON.stringify(outcome.deleted)}`);
      pushToast({ title: "History purged", body: `${total} row(s) removed`, tone: "success" });
      onDone();
    } catch (cause) {
      onError(describeError(cause));
    } finally {
      onBusy(null);
    }
  };

  const resetMemory = async () => {
    onBusy("memory");
    onError("");
    try {
      const outcome = await api.post<{ deleted: number; scope: string }>("/api/settings/memory/reset", undefined, { scope });
      setResult(`Forgot ${outcome.deleted} ${outcome.scope} memory item(s).`);
      pushToast({ title: "Memory reset", body: `${outcome.deleted} item(s) forgotten`, tone: "success" });
    } catch (cause) {
      onError(describeError(cause));
    } finally {
      onBusy(null);
    }
  };

  return (
    <Panel
      title={<span className="flex items-center gap-2 text-danger"><AlertOctagon size={15} /> Danger zone</span>}
      subtitle="Bookkeeping only. Neither action touches a project workspace, and both are written to the audit trail."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <p className="text-[13px] font-medium flex items-center gap-1.5"><Database size={13} /> Purge history</p>
            <p className="mt-0.5 text-xs text-ink-faint">
              Deletes events, checkpoints and usage records older than the cutoff, plus the optional tables below.
            </p>
          </div>
          <Field label="Older than (days)">
            <input className="field numeric w-32" type="number" min={0} max={3650} value={days}
                   onChange={(event) => setDays(Number(event.target.value))} />
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={includeToolCalls} onChange={(event) => setIncludeToolCalls(event.target.checked)} />
            Include tool call records <span className="text-ink-faint">(you lose the execution evidence for old tasks)</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={includeDecisions} onChange={(event) => setIncludeDecisions(event.target.checked)} />
            Include decision records <span className="text-ink-faint">(calibration history disappears)</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={includeMessages} onChange={(event) => setIncludeMessages(event.target.checked)} />
            Include agent messages
          </label>
          <Button variant="danger" busy={busy === "purge"} onClick={() => void purge()}>
            <Database size={13} /> Purge now
          </Button>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-[13px] font-medium flex items-center gap-1.5"><ShieldCheck size={13} /> Reset memory</p>
            <p className="mt-0.5 text-xs text-ink-faint">
              <span className="numeric">company</span> forgets shared lessons; <span className="numeric">all</span> also clears every
              agent and project namespace. Agents keep their profiles and tool whitelists.
            </p>
          </div>
          <Field label="Scope">
            <select className="field w-auto" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="company">company</option>
              <option value="all">all</option>
            </select>
          </Field>
          <Button variant="danger" busy={busy === "memory"} onClick={() => void resetMemory()}>
            <ShieldCheck size={13} /> Reset memory
          </Button>
          <div className="rounded-md border border-line bg-sunken/60 p-2.5 text-xs text-ink-faint">
            <p className="flex items-center gap-1.5 font-medium text-ink-soft">
              <Terminal size={12} /> Equivalent commands
            </p>
            <pre className="numeric mt-1 whitespace-pre-wrap">{`curl -X POST "$API/api/settings/purge?events_older_than_days=7" \\
     -H "Authorization: Bearer $TOKEN"
curl -X POST "$API/api/settings/memory/reset?scope=company" \\
     -H "Authorization: Bearer $TOKEN"`}</pre>
          </div>
        </div>
      </div>

      {result && (
        <p className="mt-3 rounded-md border border-[#cfe8da] bg-positive-soft px-3 py-2 text-xs text-positive">
          <Gauge size={12} className="mr-1 inline" /> {result}
        </p>
      )}
      {busy === null && (
        <p className="mt-3 flex items-center gap-2 text-xs text-ink-faint">
          <Copy size={12} /> Nothing on this page can delete a project workspace. Use Projects → delete for that, with the
          explicit “also delete files” checkbox.
        </p>
      )}
    </Panel>
  );
}
