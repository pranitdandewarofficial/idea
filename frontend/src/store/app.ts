/**
 * Global client state. Only cross-cutting facts live here (boot status, live
 * event buffer, connection state, settings, toasts); each screen loads its own
 * data through `useResource` so nothing is cached longer than it is true.
 */
import { create } from "zustand";
import { api, bootstrap, describeError } from "../api/client";
import type { AppEvent, Health, Settings, SettingsResponse, SetupStatus } from "../lib/types";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: "info" | "success" | "warning" | "danger";
  createdAt: number;
}

const EVENT_LIMIT = 800;

interface AppState {
  ready: boolean;
  booting: boolean;
  bootError: string | null;
  health: Health | null;
  setup: SetupStatus | null;
  settings: Settings | null;
  settingsMeta: SettingsResponse | null;
  connection: ConnectionState;
  connectionDetail: string;
  events: AppEvent[];
  lastEventId: number;
  pendingApprovals: number;
  toasts: Toast[];

  boot: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  refreshSetup: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>;
  setConnection: (state: ConnectionState, detail?: string) => void;
  ingestEvents: (events: AppEvent[]) => void;
  clearEvents: () => void;
  setPendingApprovals: (count: number) => void;
  pushToast: (toast: Omit<Toast, "id" | "createdAt">) => void;
  dismissToast: (id: string) => void;
}

let bootPromise: Promise<void> | null = null;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  booting: false,
  bootError: null,
  health: null,
  setup: null,
  settings: null,
  settingsMeta: null,
  connection: "connecting",
  connectionDetail: "",
  events: [],
  lastEventId: 0,
  pendingApprovals: 0,
  toasts: [],

  boot: async () => {
    if (bootPromise) return bootPromise;
    set({ booting: true, bootError: null });
    bootPromise = (async () => {
      try {
        await bootstrap();
        const [health, setup, settingsResponse] = await Promise.all([
          api.get<Health>("/api/health"),
          api.get<SetupStatus>("/api/setup/status"),
          api.get<SettingsResponse>("/api/settings"),
        ]);
        const history = await api.get<{ items: AppEvent[]; last_id: number }>("/api/events", { limit: 200 });
        set({
          ready: true,
          booting: false,
          health,
          setup,
          settings: settingsResponse.values as Settings,
          settingsMeta: settingsResponse,
          events: history.items.slice(-EVENT_LIMIT),
          lastEventId: history.last_id ?? history.items.at(-1)?.id ?? 0,
          pendingApprovals: countPendingApprovals(history.items),
        });
      } catch (error) {
        bootPromise = null;
        set({ ready: false, booting: false, bootError: describeError(error), connection: "offline" });
      }
    })();
    return bootPromise;
  },

  refreshHealth: async () => {
    try {
      set({ health: await api.get<Health>("/api/health") });
    } catch {
      /* the connection banner already reports this */
    }
  },

  refreshSetup: async () => {
    try {
      set({ setup: await api.get<SetupStatus>("/api/setup/status") });
    } catch {
      /* ignore */
    }
  },

  refreshSettings: async () => {
    try {
      const response = await api.get<SettingsResponse>("/api/settings");
      set({ settings: response.values as Settings, settingsMeta: response });
    } catch {
      /* ignore */
    }
  },

  saveSettings: async (patch) => {
    const saved = await api.patch<{ values: Settings; changed: string[] }>("/api/settings", patch);
    set({ settings: saved.values });
    return saved.values;
  },

  setConnection: (state, detail = "") => set({ connection: state, connectionDetail: detail }),

  ingestEvents: (incoming) => {
    if (!incoming.length) return;
    const known = new Set(get().events.map((e) => e.id));
    const fresh = incoming.filter((e) => !known.has(e.id));
    if (!fresh.length) return;
    const merged = [...get().events, ...fresh].slice(-EVENT_LIMIT);
    const lastEventId = merged.reduce((max, e) => Math.max(max, e.id), get().lastEventId);
    const approvalDelta = fresh.filter((e) => e.kind.startsWith("approval.")).length;
    set({
      events: merged,
      lastEventId,
      pendingApprovals: approvalDelta
        ? Math.max(0, countPendingApprovals(merged))
        : get().pendingApprovals,
    });
    for (const event of fresh) {
      if (event.notify && event.priority !== "low") {
        get().pushToast({
          title: event.kind,
          body: summarise(event),
          tone: event.priority === "critical" ? "danger" : event.priority === "high" ? "warning" : "info",
        });
      }
    }
  },

  clearEvents: () => set({ events: [] }),

  setPendingApprovals: (count) => set({ pendingApprovals: count }),

  pushToast: (toast) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    set({ toasts: [...get().toasts, { ...toast, id, createdAt: Date.now() }].slice(-4) });
    window.setTimeout(() => get().dismissToast(id), 7000);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

function countPendingApprovals(events: AppEvent[]): number {
  let open = 0;
  for (const event of events) {
    if (event.kind === "approval.requested") open += 1;
    if (event.kind === "approval.decided" || event.kind === "approval.expired") open = Math.max(0, open - 1);
  }
  return open;
}

export function summarise(event: AppEvent): string {
  const payload = event.payload ?? {};
  const parts = ["title", "agent_id", "task_id", "external_id", "error", "reason", "message", "detail"]
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.slice(0, 3).join(" · ").slice(0, 220);
}
