/**
 * Area 7 - AI Providers: the only place a credential enters the system.
 * Keys are POSTed once, encrypted with Fernet on the server, and the API only ever
 * returns has_key plus a fingerprint. Zero-spend is a hard switch here.
 */
import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import {
  Check, FlaskConical, KeyRound, Plug, Plus, RefreshCw, ShieldCheck, Trash2, X,
} from "lucide-react";
import { api, describeError } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { Page } from "../components/Shell";
import {
  Badge, Button, EmptyState, ErrorState, Field, KeyValue, Loading, Modal, Panel, Stat, Toggle,
} from "../components/ui";
import { compactNumber, duration, money, timeAgo } from "../lib/format";
import type { Provider, ProviderTestResult, UsageSummary } from "../lib/types";

interface ProviderKind {
  kind: string;
  default_base_url: string;
  requires_key: boolean;
  is_paid_by_default: boolean;
}

interface ProviderListResponse { items: (Provider & { usage?: UsageSummary })[]; count: number; zero_spend: boolean }

const EMPTY_FORM = {
  label: "", kind: "ollama", base_url: "", api_key: "", organization_id: "",
  default_model: "", fallback_model: "", is_paid: false, is_enabled: true,
  requests_per_minute: 120, max_concurrent: 2, timeout_seconds: 120, max_retries: 2,
};

export function ProvidersArea() {
  const pushToast = useApp((state) => state.pushToast);
  const refreshSettings = useApp((state) => state.refreshSettings);
  const settings = useApp((state) => state.settings);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});

  const list = useResource<ProviderListResponse>(() => api.get<ProviderListResponse>("/api/providers"), {
    refreshOn: ["provider.", "settings.", "usage."], debounce: 900,
  });
  const kinds = useResource<{ items: ProviderKind[] }>(() => api.get<{ items: ProviderKind[] }>("/api/providers/kinds"));
  const globalUsage = useResource<UsageSummary>(() => api.get<UsageSummary>("/api/providers/usage/global"), {
    refreshOn: ["usage.", "provider.", "plan.finished", "task."], debounce: 1500,
  });

  const items = list.data?.items ?? [];
  const zeroSpend = Boolean(settings?.zero_spend ?? list.data?.zero_spend);

  const act = async (key: string, call: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError(null);
    try {
      const result = await call();
      pushToast({ title: message, tone: "success" });
      list.reload();
      return result;
    } catch (cause) {
      setError(describeError(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const testProvider = async (provider: Provider) => {
    setBusy(`test-${provider.id}`);
    setError(null);
    try {
      const result = await api.post<ProviderTestResult>(`/api/providers/${provider.id}/test`);
      setResults((current) => ({ ...current, [provider.id]: result }));
      pushToast({
        title: result.ok ? `${provider.label} reachable` : `${provider.label} failed the check`,
        body: `${result.message} · ${duration(result.latency_ms)}${result.mocked ? " · mocked" : ""}`,
        tone: result.ok ? "success" : "danger",
      });
      list.reload();
    } catch (cause) {
      setResults((current) => ({
        ...current,
        [provider.id]: {
          ok: false, message: describeError(cause), latency_ms: 0, kind: provider.kind,
          is_paid: provider.is_paid, mocked: false, model: provider.default_model,
        },
      }));
    } finally {
      setBusy(null);
    }
  };

  const discoverModels = async (provider: Provider) => {
    setBusy(`models-${provider.id}`);
    setError(null);
    try {
      const result = await api.get<{ items: string[]; source: string; count: number }>(
        `/api/providers/${provider.id}/models`, { refresh: true },
      );
      setModels((current) => ({ ...current, [provider.id]: result.items }));
      pushToast({ title: `${result.count} model(s) discovered`, body: `source: ${result.source}`, tone: "info" });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const setZeroSpend = (enabled: boolean) =>
    void act("zero-spend", async () => {
      await api.post("/api/settings/zero-spend", undefined, { enabled });
      await refreshSettings();
    }, enabled ? "Zero-spend mode engaged" : "Zero-spend mode released");

  const makeDefault = (provider: Provider) =>
    void act(`default-${provider.id}`, () => useApp.getState().saveSettings({ default_provider_id: provider.id }),
             `${provider.label} is now the default provider`);

  return (
    <Page className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Providers" value={items.length}
              hint={`${items.filter((row) => row.is_enabled).length} enabled`} />
        <Stat label="Zero spend" value={zeroSpend ? "on" : "off"}
              hint={zeroSpend ? "paid providers are blocked" : "paid calls are allowed"}
              tone={zeroSpend ? "positive" : "danger"} />
        <Stat label="Calls" value={compactNumber(globalUsage.data?.calls ?? 0)}
              hint={`${globalUsage.data?.mocked_calls ?? 0} of them mocked`} />
        <Stat label="Tokens / cost" value={`${compactNumber(globalUsage.data?.tokens_total ?? 0)} · ${money(globalUsage.data?.cost_estimate ?? 0)}`}
              hint={`avg ${duration(globalUsage.data?.avg_latency_ms ?? 0)} per call`} />
      </div>

      <Panel
        title="Spend policy"
        subtitle="Zero-spend is the default and the safe setting. Turning it off is recorded in the audit trail."
        actions={<Button size="sm" onClick={() => void act("usage", () => Promise.resolve(), "")}><RefreshCw size={12} /></Button>}
      >
        <Toggle
          checked={zeroSpend}
          onChange={setZeroSpend}
          label="Zero-spend mode"
          description="With this on, providers marked as paid are refused at the registry level (SpendBlockedError) unless the specific run was authorised with spend_authorized=true. Local and mock providers keep working."
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <ShieldCheck size={13} className="text-positive" />
          Keys are encrypted with Fernet before they touch SQLite. The API returns <span className="numeric">has_key</span> and a
          fingerprint only - never the key, in any response, log or error trace.
        </div>
      </Panel>

      {error && <ErrorState message={error} />}

      <Panel
        title="Configured providers"
        subtitle="Test and model discovery hit the real endpoint; nothing here is simulated except the provider explicitly marked as mock."
        actions={<Button size="sm" variant="accent" onClick={() => setAdding(true)}><Plus size={13} /> Add provider</Button>}
        bodyClassName="p-2"
      >
        {list.loading && !list.data && <Loading label="Loading providers" />}
        {list.error && !list.data && <ErrorState message={list.error} onRetry={list.reload} />}
        {!list.loading && items.length === 0 && (
          <div className="p-2">
            <EmptyState
              title="No provider configured"
              body="Add Ollama on http://127.0.0.1:11434 for a free local model, or the offline mock provider to exercise the whole pipeline without any network."
              action={<Button size="sm" variant="accent" className="mt-1" onClick={() => setAdding(true)}><Plus size={13} /> Add provider</Button>}
            />
          </div>
        )}
        <ul className="space-y-2">
          {items.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              busy={busy}
              result={results[provider.id]}
              models={models[provider.id]}
              isDefault={settings?.default_provider_id === provider.id}
              isFallback={settings?.fallback_provider_id === provider.id}
              onTest={() => void testProvider(provider)}
              onModels={() => void discoverModels(provider)}
              onEdit={() => setEditing(provider)}
              onDefault={() => makeDefault(provider)}
              onFallback={() => void act(`fallback-${provider.id}`,
                                         () => useApp.getState().saveSettings({ fallback_provider_id: provider.id }),
                                         `${provider.label} is now the fallback provider`)}
              onToggle={() => void act(`toggle-${provider.id}`,
                                       () => api.patch(`/api/providers/${provider.id}`, { is_enabled: !provider.is_enabled }),
                                       provider.is_enabled ? `${provider.label} disabled` : `${provider.label} enabled`)}
              onDelete={() => {
                if (!window.confirm(`Delete the provider "${provider.label}"? Its encrypted key is removed with it.`)) return;
                void act(`delete-${provider.id}`, () => api.del(`/api/providers/${provider.id}`), "Provider deleted");
              }}
            />
          ))}
        </ul>
      </Panel>

      <Panel title="How to configure each kind" subtitle="Exact values, no placeholders">
        <ul className="grid gap-2 md:grid-cols-2">
          {(kinds.data?.items ?? []).map((entry) => (
            <li key={entry.kind} className="panel-flat p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="numeric text-[13px] font-semibold">{entry.kind}</span>
                {entry.is_paid_by_default && <Badge tone="warning">paid by default</Badge>}
                {!entry.requires_key && <Badge tone="positive">no key needed</Badge>}
              </div>
              <p className="numeric mt-1 text-xs text-ink-faint">
                base_url: {entry.default_base_url || "(set manually)"}
              </p>
            </li>
          ))}
        </ul>
        {kinds.loading && !kinds.data && <Loading label="Loading provider kinds" />}
        <div className="code mt-3">{`# Local, free, no key (recommended default)
ollama serve                                   # in another terminal
ollama pull llama3.1:8b
# then add a provider: kind=ollama, base_url=http://127.0.0.1:11434, default_model=llama3.1:8b, is_paid=false

# Offline mock - exercises the whole pipeline with no network at all
# kind=mock, is_paid=false, default_model=mock-agent
# A run that used it is always reported with used_mock_provider=true and delivered=false.`}</div>
      </Panel>

      {adding && (
        <ProviderForm
          kinds={kinds.data?.items ?? []}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); list.reload(); }}
        />
      )}
      {editing && (
        <ProviderForm
          kinds={kinds.data?.items ?? []}
          provider={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); }}
        />
      )}
    </Page>
  );
}

function ProviderCard({
  provider, busy, result, models, isDefault, isFallback,
  onTest, onModels, onEdit, onDefault, onFallback, onToggle, onDelete,
}: {
  provider: Provider & { usage?: UsageSummary };
  busy: string | null;
  result?: ProviderTestResult;
  models?: string[];
  isDefault: boolean;
  isFallback: boolean;
  onTest: () => void;
  onModels: () => void;
  onEdit: () => void;
  onDefault: () => void;
  onFallback: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const last = result ?? (provider.last_test_ok === null ? undefined : {
    ok: Boolean(provider.last_test_ok),
    message: provider.last_test_message ?? "",
    latency_ms: provider.last_test_latency_ms ?? 0,
    kind: provider.kind,
    is_paid: provider.is_paid,
    mocked: provider.kind === "mock",
    model: provider.default_model,
  });

  return (
    <li className={clsx("panel-flat p-3", !provider.is_enabled && "opacity-70")}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                              provider.is_paid ? "bg-warning-soft text-warning" : "bg-positive-soft text-positive")}>
          <Plug size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold">{provider.label}</span>
            <Badge tone="muted">{provider.kind}</Badge>
            {provider.is_paid && <Badge tone="warning">paid</Badge>}
            {!provider.is_enabled && <Badge tone="muted">disabled</Badge>}
            {isDefault && <Badge tone="accent">default</Badge>}
            {isFallback && <Badge tone="accent">fallback</Badge>}
            {provider.has_key && (
              <Badge tone="positive"><KeyRound size={10} /> key set · {provider.key_fingerprint || "fingerprint unavailable"}</Badge>
            )}
            {!provider.has_key && provider.kind !== "ollama" && provider.kind !== "mock" && (
              <Badge tone="danger">no key</Badge>
            )}
          </div>
          <p className="numeric mt-1 truncate text-xs text-ink-faint">
            {provider.base_url || "(default base url)"} · model {provider.default_model ?? "—"}
            {provider.fallback_model ? ` / fallback ${provider.fallback_model}` : ""}
          </p>
          <p className="numeric mt-0.5 text-[11px] text-ink-faint">
            {provider.usage
              ? `${provider.usage.calls} calls · ${compactNumber(provider.usage.tokens_total)} tok · ${money(provider.usage.cost_estimate)} · ${provider.usage.mocked_calls} mocked`
              : "no usage recorded"}
            {provider.last_test_at ? ` · last tested ${timeAgo(String(provider.last_test_at))}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" busy={busy === `test-${provider.id}`} onClick={onTest}>
            <FlaskConical size={12} /> Test
          </Button>
          <Button size="sm" busy={busy === `models-${provider.id}`} onClick={onModels}>Models</Button>
          <Button size="sm" onClick={onEdit}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? <X size={12} /> : <Check size={12} className="opacity-0" />} More
          </Button>
          <Button size="sm" variant="danger" busy={busy === `delete-${provider.id}`} onClick={onDelete}
                  title="Delete this provider">
            <Trash2 size={12} />
          </Button>
        </div>
      </div>

      {last && (
        <div className={clsx("mt-2 rounded-md border px-2.5 py-1.5 text-xs",
                             last.ok ? "border-[#cfe8da] bg-positive-soft text-positive"
                                     : "border-[#f2cfcc] bg-danger-soft text-danger")}>
          <span className="font-medium">{last.ok ? "Reachable" : "Not reachable"}</span>
          <span className="numeric"> · {duration(last.latency_ms)}</span>
          <span className="ml-1 text-ink-soft">{last.message}</span>
          {last.mocked && <span className="ml-1 text-warning">(mock provider - proves wiring only)</span>}
        </div>
      )}

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-line-soft pt-3">
          <div className="flex flex-wrap gap-2">
            {!isDefault && <Button size="sm" onClick={onDefault}>Make default</Button>}
            {!isFallback && <Button size="sm" onClick={onFallback}>Make fallback</Button>}
            <Button size="sm" busy={busy === `toggle-${provider.id}`} onClick={onToggle}>
              {provider.is_enabled ? "Disable" : "Enable"}
            </Button>
          </div>
          <KeyValue items={[
            ["Rate limit", <span className="numeric">{provider.requests_per_minute} req/min · {provider.max_concurrent} concurrent</span>],
            ["Timeout / retries", <span className="numeric">{provider.timeout_seconds}s · {provider.max_retries}</span>],
            ["Role models", <span className="numeric">{Object.keys(provider.role_models).length
              ? JSON.stringify(provider.role_models) : "none - uses the default model"}</span>],
            ["Extra headers", <span className="numeric">{Object.keys(provider.extra_headers).length
              ? Object.keys(provider.extra_headers).join(", ") : "none"}</span>],
            ["Organization", provider.organization_id ? <span className="numeric">{provider.organization_id}</span> : "—"],
          ]} />
          {models && models.length > 0 && (
            <div>
              <p className="label">Discovered models ({models.length})</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {models.map((model) => <Badge key={model} tone="muted"><span className="numeric">{model}</span></Badge>)}
              </div>
            </div>
          )}
          {models && models.length === 0 && (
            <p className="text-xs text-ink-faint">Model discovery returned nothing - this provider kind may not expose a /models endpoint.</p>
          )}
        </div>
      )}
    </li>
  );
}

function ProviderForm({
  kinds, provider, onClose, onSaved,
}: {
  kinds: ProviderKind[];
  provider?: Provider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pushToast = useApp((state) => state.pushToast);
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    ...(provider
      ? {
        label: provider.label, kind: provider.kind, base_url: provider.base_url,
        organization_id: provider.organization_id ?? "", default_model: provider.default_model ?? "",
        fallback_model: provider.fallback_model ?? "", is_paid: provider.is_paid,
        is_enabled: provider.is_enabled, requests_per_minute: provider.requests_per_minute,
        max_concurrent: provider.max_concurrent, timeout_seconds: provider.timeout_seconds,
        max_retries: provider.max_retries,
      }
      : {}),
  }));
  const [apiKey, setApiKey] = useState("");
  const [roleModels, setRoleModels] = useState(() =>
    Object.entries(provider?.role_models ?? {}).map(([role, model]) => `${role}=${model}`).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindMeta = useMemo(() => kinds.find((entry) => entry.kind === form.kind), [kinds, form.kind]);

  useEffect(() => {
    if (provider || !kindMeta) return;
    setForm((current) => ({
      ...current,
      base_url: current.base_url || kindMeta.default_base_url,
      is_paid: kindMeta.is_paid_by_default,
    }));
  }, [kindMeta, provider]);

  const parseRoleModels = (): Record<string, string> =>
    Object.fromEntries(
      roleModels.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split("=").map((part) => part.trim()))
        .filter((parts) => parts.length === 2 && parts[0] && parts[1])
        .map((parts) => [parts[0], parts[1]] as [string, string]),
    );

  const submit = async () => {
    setBusy(true);
    setError(null);
    const payload = {
      label: form.label.trim(),
      kind: form.kind,
      base_url: form.base_url.trim() || (kindMeta?.default_base_url ?? ""),
      organization_id: form.organization_id.trim() || null,
      default_model: form.default_model.trim() || null,
      fallback_model: form.fallback_model.trim() || null,
      is_paid: form.is_paid,
      is_enabled: form.is_enabled,
      requests_per_minute: Number(form.requests_per_minute),
      max_concurrent: Number(form.max_concurrent),
      timeout_seconds: Number(form.timeout_seconds),
      max_retries: Number(form.max_retries),
      role_models: parseRoleModels(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    };
    try {
      if (provider) {
        await api.patch(`/api/providers/${provider.id}`, payload);
        pushToast({ title: "Provider updated", body: payload.label, tone: "success" });
      } else {
        await api.post("/api/providers", payload);
        pushToast({ title: "Provider added", body: `${payload.label} (${payload.kind})`, tone: "success" });
      }
      onSaved();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} wide title={provider ? `Edit ${provider.label}` : "Add a provider"}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" hint="Shown everywhere in the UI.">
            <input className="field" value={form.label} placeholder="Ollama (local)"
                   onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <Field label="Kind" hint={kindMeta ? (kindMeta.requires_key ? "requires an API key" : "no API key needed") : undefined}>
            <select className="field" value={form.kind} disabled={Boolean(provider)}
                    onChange={(event) => setForm({ ...form, kind: event.target.value, base_url: "" })}>
              {(kinds.length ? kinds : [{ kind: form.kind, default_base_url: "", requires_key: true, is_paid_by_default: true }])
                .map((entry) => <option key={entry.kind} value={entry.kind}>{entry.kind}</option>)}
            </select>
          </Field>
          <Field label="Base URL" hint={kindMeta?.default_base_url ? `default: ${kindMeta.default_base_url}` : undefined}>
            <input className="field numeric" value={form.base_url} placeholder={kindMeta?.default_base_url}
                   onChange={(event) => setForm({ ...form, base_url: event.target.value })} />
          </Field>
          <Field label="Default model" hint="Used for every role unless overridden below.">
            <input className="field numeric" value={form.default_model} placeholder="llama3.1:8b"
                   onChange={(event) => setForm({ ...form, default_model: event.target.value })} />
          </Field>
          <Field label="API key" hint={provider
            ? `Stored encrypted. Current fingerprint: ${provider.key_fingerprint || "none"}. Leave blank to keep it.`
            : "Encrypted with Fernet before storage; never returned by the API."}>
            <input className="field numeric" type="password" value={apiKey} autoComplete="off"
                   placeholder={provider?.has_key ? "•••••••• (unchanged)" : "sk-…"}
                   onChange={(event) => setApiKey(event.target.value)} />
          </Field>
          <Field label="Organization id" hint="Optional (OpenAI / Anthropic org scoping).">
            <input className="field numeric" value={form.organization_id}
                   onChange={(event) => setForm({ ...form, organization_id: event.target.value })} />
          </Field>
          <Field label="Fallback model" hint="Tried when the default model errors.">
            <input className="field numeric" value={form.fallback_model}
                   onChange={(event) => setForm({ ...form, fallback_model: event.target.value })} />
          </Field>
          <Field label="Role models" hint="One per line: role=model. Roles: planning, coding, review, docs, decision.">
            <textarea className="field numeric min-h-[72px]" value={roleModels}
                      placeholder={"planning=llama3.1:8b\ncoding=qwen2.5-coder:7b"}
                      onChange={(event) => setRoleModels(event.target.value)} />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Requests / min">
            <input className="field numeric" type="number" min={1} max={10000} value={form.requests_per_minute}
                   onChange={(event) => setForm({ ...form, requests_per_minute: Number(event.target.value) })} />
          </Field>
          <Field label="Max concurrent">
            <input className="field numeric" type="number" min={1} max={32} value={form.max_concurrent}
                   onChange={(event) => setForm({ ...form, max_concurrent: Number(event.target.value) })} />
          </Field>
          <Field label="Timeout (s)">
            <input className="field numeric" type="number" min={5} max={900} value={form.timeout_seconds}
                   onChange={(event) => setForm({ ...form, timeout_seconds: Number(event.target.value) })} />
          </Field>
          <Field label="Max retries">
            <input className="field numeric" type="number" min={0} max={8} value={form.max_retries}
                   onChange={(event) => setForm({ ...form, max_retries: Number(event.target.value) })} />
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle checked={form.is_paid} onChange={(next) => setForm({ ...form, is_paid: next })}
                  label="Paid provider"
                  description="Paid providers are refused while zero-spend mode is on." />
          <Toggle checked={form.is_enabled} onChange={(next) => setForm({ ...form, is_enabled: next })}
                  label="Enabled" description="Disabled providers are skipped by the picker." />
        </div>

        {error && <ErrorState message={error} />}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" busy={busy} disabled={!form.label.trim()} onClick={() => void submit()}>
            <Check size={13} /> {provider ? "Save changes" : "Add provider"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
