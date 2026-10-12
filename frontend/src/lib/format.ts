/** Pure formatting helpers. Unit-tested in format.test.ts. */

export type Tone = "neutral" | "accent" | "positive" | "warning" | "danger" | "muted";

export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 2 : 1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function bytes(value: number | null | undefined): string {
  if (!value || value < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function money(value: number | null | undefined): string {
  if (!value) return "$0.00";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Deterministic hue from any seed, so an avatar keeps its colour across renders. */
export function hueFromSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return hash;
}

export const TASK_TONE: Record<string, Tone> = {
  pending: "muted",
  ready: "accent",
  running: "accent",
  repairing: "warning",
  blocked: "warning",
  timeout: "danger",
  failed: "danger",
  completed: "positive",
  cancelled: "muted",
};

export const AGENT_TONE: Record<string, Tone> = {
  idle: "muted",
  working: "accent",
  collaborating: "accent",
  waiting: "warning",
  blocked: "warning",
  offline: "danger",
};

export const PLAN_TONE: Record<string, Tone> = {
  draft: "muted",
  received: "muted",
  clarifying: "warning",
  planning: "accent",
  scheduled: "accent",
  scheduling: "accent",
  executing: "accent",
  verifying: "accent",
  repairing: "warning",
  integrating: "accent",
  reviewing: "accent",
  delivering: "accent",
  complete: "positive",
  failed: "danger",
  cancelled: "muted",
  paused: "warning",
  blocked: "danger",
};

export function toneFor(kind: "task" | "agent" | "plan", status: string): Tone {
  const table = kind === "task" ? TASK_TONE : kind === "agent" ? AGENT_TONE : PLAN_TONE;
  return table[status] ?? "neutral";
}

export function truncate(text: string | null | undefined, limit = 160): string {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const bucket = key(item);
    (acc[bucket] ??= []).push(item);
    return acc;
  }, {});
}
