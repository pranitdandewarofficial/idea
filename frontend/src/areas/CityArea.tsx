/** Area 1 - City. The live map, driven entirely by GET /api/city. */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { clsx } from "clsx";
import { Crosshair, Maximize2, Minus, Plus, TriangleAlert } from "lucide-react";
import { api } from "../api/client";
import { useResource } from "../lib/useResource";
import { useApp } from "../store/app";
import { CityCanvas, type FocusRequest } from "../city/CityCanvas";
import { Badge, Button, EmptyState, ErrorState, Loading, Progress } from "../components/ui";
import { AGENT_TONE, initials } from "../lib/format";
import type { CityAgent, CityLayout } from "../lib/types";

const REFRESH_ON = ["task.", "agent.", "plan.", "approval.", "provider.", "settings.", "decision.routing"];

export function CityArea() {
  const settings = useApp((state) => state.settings);
  const saveSettings = useApp((state) => state.saveSettings);
  const [selection, setSelection] = useState<{ kind: "agent" | "building"; id: string } | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  const city = useResource<CityLayout>(() => api.get<CityLayout>("/api/city"), { refreshOn: REFRESH_ON, debounce: 400 });
  const reducedMotion = useMemo(
    () => (typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false),
    [],
  );

  const onSelect = useCallback((next: { kind: "agent" | "building"; id: string } | null) => {
    setSelection(next);
    if (!next || !city.data) return;
    if (next.kind === "building") {
      const building = city.data.buildings.find((b) => b.id === next.id);
      if (building) {
        setFocus({
          key: `${building.id}-${Date.now()}`,
          rect: { x: building.x - 80, y: building.y - 80, w: building.w + 160, h: building.h + 160 },
        });
      }
    } else {
      const agent = city.data.agents.find((a) => a.id === next.id);
      if (agent) {
        setFocus({ key: `${agent.id}-${Date.now()}`, rect: { x: agent.city_x - 160, y: agent.city_y - 140, w: 320, h: 280 }, scale: 1.5 });
      }
    }
  }, [city.data]);

  const toggleCompact = async () => {
    const next = !(settings?.compact_mode ?? false);
    try {
      await saveSettings({ compact_mode: next });
      city.reload();
    } catch {
      /* the settings screen surfaces the error */
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      <div className="panel relative min-w-0 flex-1 overflow-hidden">
        {city.loading && !city.data && (
          <div className="absolute inset-0 flex items-center justify-center"><Loading label="Loading the city" /></div>
        )}
        {city.error && !city.data && (
          <div className="p-4"><ErrorState message={city.error} onRetry={city.reload} /></div>
        )}
        {city.data && (
          <>
            <CityCanvas
              layout={city.data}
              compact={Boolean(settings?.compact_mode)}
              reducedMotion={reducedMotion}
              selectedId={selection?.id ?? null}
              focus={focus}
              onSelect={onSelect}
              className="absolute inset-0"
            />
            <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5">
              <div className="panel-flat pointer-events-auto px-3 py-2">
                <p className="label">The city is the state</p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {city.data.agents.length} agents · {city.data.buildings.length} departments ·{" "}
                  {city.data.task_markers.length} task{city.data.task_markers.length === 1 ? "" : "s"} in flight
                </p>
              </div>
              {city.data.active_plans.length > 0 && (
                <div className="panel-flat pointer-events-auto w-64 px-3 py-2">
                  {city.data.active_plans.map((plan) => (
                    <Link key={plan.id} to="/command" className="block py-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium">{plan.objective}</span>
                        <Badge tone="accent">{plan.state}</Badge>
                      </div>
                      <div className="mt-1"><Progress value={plan.progress} /></div>
                    </Link>
                  ))}
                </div>
              )}
              {city.data.degraded_providers.length > 0 && (
                <div className="panel-flat pointer-events-auto flex items-center gap-2 px-3 py-2 text-xs text-warning">
                  <TriangleAlert size={13} />
                  degraded: {city.data.degraded_providers.join(", ")}
                </div>
              )}
            </div>

            <div className="absolute bottom-3 left-3 flex items-center gap-2">
              <Button size="sm" onClick={() => setFocus({
                  key: `fit-${Date.now()}`,
                  rect: { x: 0, y: 0, w: city.data?.world.width ?? 0, h: city.data?.world.height ?? 0 },
                  scale: 0.4,
                })} title="Fit the whole city (Esc)">
                <Maximize2 size={13} /> Fit
              </Button>
              <Button size="sm" onClick={toggleCompact} title="Toggle labels (C)">
                <Crosshair size={13} /> {settings?.compact_mode ? "Detailed" : "Compact"}
              </Button>
              <span className="badge">1–9 districts · Esc fit · drag to pan · scroll to zoom</span>
            </div>

            <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
              <Button size="sm" onClick={() => setFocus(nudge(focus, 1.2))} title="Zoom in"><Plus size={13} /></Button>
              <Button size="sm" onClick={() => setFocus(nudge(focus, 1 / 1.2))} title="Zoom out"><Minus size={13} /></Button>
            </div>
          </>
        )}
      </div>

      <aside className="flex w-[330px] shrink-0 flex-col gap-3 overflow-y-auto scroll-thin">
        {selection && city.data ? (
          selection.kind === "building"
            ? <BuildingCard layout={city.data} id={selection.id} onAgent={(agentId) => setSelection({ kind: "agent", id: agentId })} />
            : <AgentCard agent={city.data.agents.find((a) => a.id === selection.id) ?? null} />
        ) : (
          <div className="panel p-4">
            <p className="label">Nothing selected</p>
            <p className="mt-1 text-[13px] text-ink-soft">
              Click a building or an avatar. Every light, badge and marker on the map is bound to a real
              task, agent state or provider.
            </p>
            <div className="mt-3 space-y-1.5 text-xs text-ink-faint">
              <p><span className="badge badge-accent">accent ring</span> working on a task now</p>
              <p><span className="badge badge-warning">amber ring</span> blocked or waiting on you</p>
              <p><span className="badge badge-muted">grey ring</span> idle at home seat</p>
            </div>
          </div>
        )}

        <div className="panel p-4">
          <div className="flex items-center justify-between">
            <p className="label">Company state</p>
            <Badge tone={city.data?.zero_spend ? "positive" : "warning"}>
              {city.data?.zero_spend ? "zero spend" : "spend allowed"}
            </Badge>
          </div>
          <dl className="mt-2 space-y-1.5 text-[13px]">
            <Row label="Pending approvals" value={city.data?.pending_approvals ?? 0} />
            <Row label="Active plans" value={city.data?.active_plans.length ?? 0} />
            <Row label="Providers" value={`${city.data?.providers.filter((p) => p.is_enabled).length ?? 0} enabled / ${city.data?.providers.length ?? 0}`} />
          </dl>
          {city.data && city.data.active_plans.length === 0 && (
            <div className="mt-3">
              <EmptyState
                title="The city is quiet"
                body="No plan is running. Give the company an objective and the streets fill up."
                action={<Link className="btn btn-accent btn-sm mt-2" to="/command">Open Command Center</Link>}
              />
            </div>
          )}
        </div>

        <div className="panel p-4">
          <p className="label">Departments</p>
          <ul className="mt-2 space-y-1">
            {(city.data?.buildings ?? []).map((building, index) => {
              const state = city.data?.buildings_state[building.id];
              return (
                <li key={building.id}>
                  <button
                    type="button"
                    className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] row-hover",
                                    selection?.id === building.id && "bg-accent-soft text-accent")}
                    onClick={() => onSelect({ kind: "building", id: building.id })}
                  >
                    <span className="numeric w-4 text-[11px] text-ink-faint">{index + 1}</span>
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: building.accent }} />
                    <span className="min-w-0 flex-1 truncate">{building.name}</span>
                    {state && state.active > 0 && <Badge tone="accent">{state.active}</Badge>}
                    {state && state.blocked > 0 && <Badge tone="warning">{state.blocked}</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function nudge(current: FocusRequest | null, factor: number): FocusRequest {
  const rect = current?.rect ?? { x: 0, y: 0, w: 1680, h: 1120 };
  return { key: `zoom-${Date.now()}`, rect, scale: Math.max(0.4, Math.min(2.5, (current?.scale ?? 1) * factor)) };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="numeric font-medium">{value}</dd>
    </div>
  );
}

function BuildingCard({ layout, id, onAgent }: { layout: CityLayout; id: string; onAgent: (agentId: string) => void }) {
  const building = layout.buildings.find((b) => b.id === id);
  if (!building) return null;
  const state = layout.buildings_state[id] ?? { active: 0, blocked: 0, agents: [] };
  const markers = layout.task_markers.filter((m) => m.building_id === id);
  const residents = layout.agents.filter((a) => a.building_id === id);
  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold">{building.name}</h3>
          <p className="text-xs text-ink-faint">{building.department}</p>
        </div>
        <span className="h-3 w-3 rounded-sm" style={{ background: building.accent }} />
      </div>
      <p className="mt-2 text-[13px] text-ink-soft">{building.detail}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge tone={state.active ? "accent" : "muted"}>{state.active} working</Badge>
        <Badge tone={state.blocked ? "warning" : "muted"}>{state.blocked} blocked</Badge>
        <Badge tone="muted">{residents.length} resident{residents.length === 1 ? "" : "s"}</Badge>
      </div>

      {markers.length > 0 && (
        <>
          <p className="label mt-4">Work in this building</p>
          <ul className="mt-1.5 space-y-1.5">
            {markers.map((marker) => (
              <li key={marker.task_id} className="panel-flat px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="numeric text-[11px] text-ink-faint">{marker.external_id}</span>
                  <Badge tone={marker.status === "blocked" || marker.status === "failed" ? "danger" : marker.status === "repairing" ? "warning" : "accent"}>
                    {marker.status}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-[13px]">{marker.title}</p>
                {marker.error && <p className="mt-0.5 text-[11px] text-danger">{marker.error}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      {residents.length > 0 && (
        <>
          <p className="label mt-4">Residents</p>
          <ul className="mt-1.5 space-y-1">
            {residents.map((agent) => (
              <li key={agent.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left row-hover"
                        onClick={() => onAgent(agent.id)}>
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-[10px] font-semibold">
                    {initials(agent.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{agent.name}</span>
                    <span className="block truncate text-[11px] text-ink-faint">{agent.role}</span>
                  </span>
                  <Badge tone={AGENT_TONE[agent.status] ?? "muted"}>{agent.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: CityAgent | null }) {
  if (!agent) return null;
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-[13px] font-semibold text-accent">
          {initials(agent.name)}
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold">{agent.name}</h3>
          <p className="truncate text-xs text-ink-faint">{agent.role} · {agent.department}</p>
        </div>
        <Badge tone={AGENT_TONE[agent.status] ?? "muted"} className="ml-auto">{agent.status}</Badge>
      </div>

      {agent.current_task ? (
        <div className="panel-flat mt-3 px-3 py-2">
          <p className="label">Current task</p>
          <p className="mt-0.5 truncate text-[13px]">{agent.current_task.title}</p>
          <p className="numeric mt-0.5 text-[11px] text-ink-faint">{agent.current_task.status}</p>
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-ink-faint">Idle — at the home seat in {agent.building_id}.</p>
      )}

      <dl className="mt-3 space-y-1 text-[13px]">
        <Row label="Load" value={`${agent.load} / ${agent.status === "working" ? "busy" : "free"}`} />
        <Row label="Decision agent" value={agent.is_decision_agent ? "yes (System 1)" : "no"} />
      </dl>
      <Link className="btn btn-sm mt-3" to={`/workspace/${agent.id}`}>Open workspace</Link>
    </div>
  );
}
