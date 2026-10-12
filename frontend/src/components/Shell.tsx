/** Application shell: navigation rail, live status bar, approval drawer, toasts. */
import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity, BookOpen, Building2, Check, CircleAlert, Compass, FolderGit2, Gauge,
  ListChecks, Plug, Settings as SettingsIcon, ShieldCheck, Terminal, Users, X,
} from "lucide-react";
import { api } from "../api/client";
import { live } from "../live/stream";
import { timeAgo } from "../lib/format";
import { useApp } from "../store/app";
import type { Approval } from "../lib/types";
import { Badge, Button, EmptyState, ErrorState, Loading, Panel } from "./ui";

const NAV = [
  { to: "/", label: "City", icon: Building2, end: true },
  { to: "/command", label: "Command Center", icon: Compass },
  { to: "/agents", label: "Agent Directory", icon: Users },
  { to: "/workspace", label: "Agent Workspace", icon: Terminal },
  { to: "/tasks", label: "Task Manager", icon: ListChecks },
  { to: "/projects", label: "Projects", icon: FolderGit2 },
  { to: "/providers", label: "AI Providers", icon: Plug },
  { to: "/knowledge", label: "Knowledge Center", icon: BookOpen },
  { to: "/activity", label: "Activity Center", icon: Activity },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

const CONNECTION_LABEL: Record<string, string> = {
  live: "Live",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function Shell() {
  const location = useLocation();
  const { connection, connectionDetail, pendingApprovals, health, settings } = useApp();
  const [approvalsOpen, setApprovalsOpen] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const dot = connection === "live" ? "bg-positive" : connection === "offline" ? "bg-danger" : "bg-warning";

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[212px] shrink-0 flex-col border-r border-line bg-surface" aria-label="Areas">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white">
            <Building2 size={15} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-4">PRANIT AI CITY</p>
            <p className="truncate text-[11px] text-ink-faint">local-first company</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 scroll-thin">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={"end" in item ? item.end : false}
                     className={({ isActive }) => clsx("nav-item", isActive && "text-accent")}>
              {({ isActive }) => (
                <>
                  <item.icon size={15} strokeWidth={isActive ? 2.1 : 1.8} />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
        <div className="border-t border-line p-3 text-[11px] text-ink-faint">
          <p className="numeric">v{health?.version ?? "—"} · py {health?.python ?? "—"}</p>
          <p className="mt-1 flex items-center gap-1.5">
            <ShieldCheck size={12} /> sandbox tier {health?.sandbox_tier ?? "—"}
          </p>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <h1 className="text-[15px] font-semibold">{titleFor(location.pathname)}</h1>
          <div className="ml-auto flex items-center gap-2">
            <Badge tone={settings?.zero_spend ? "positive" : "warning"}>
              {settings?.zero_spend ? "zero spend on" : "spend allowed"}
            </Badge>
            <Badge tone={health?.decisions_enabled ? "accent" : "muted"}>
              <Gauge size={11} /> {health?.decisions_enabled ? `system 1: ${health?.decision_engine}` : "decisions off"}
            </Badge>
            <button
              type="button"
              className={clsx("btn btn-sm", pendingApprovals > 0 && "btn-accent")}
              onClick={() => setApprovalsOpen(true)}
            >
              <CircleAlert size={13} />
              Approvals
              {pendingApprovals > 0 && <span className="numeric">{pendingApprovals}</span>}
            </button>
            <span className="flex items-center gap-1.5 text-xs text-ink-faint" title={connectionDetail}>
              <span className={clsx("h-2 w-2 rounded-full", dot, connection !== "live" && "pulse")} />
              {CONNECTION_LABEL[connection]}
              <span className="numeric hidden lg:inline">({live.mode})</span>
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <Outlet />
        </main>
      </div>

      <ApprovalDrawer open={approvalsOpen} onClose={() => setApprovalsOpen(false)} />
      <Toaster />
    </div>
  );
}

function titleFor(pathname: string): string {
  const item = NAV.find((entry) => (entry.to === "/" ? pathname === "/" : pathname.startsWith(entry.to)));
  return item?.label ?? "PRANIT AI CITY";
}

export function ApprovalDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const body = await api.get<{ items: Approval[] }>("/api/approvals", { status: "pending" });
      setItems(body.items);
      useApp.getState().setPendingApprovals(body.items.length);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const unsubscribe = live.subscribe((event) => {
      if (event.kind.startsWith("approval.")) void load();
    });
    return unsubscribe;
  }, [open]);

  const decide = async (approval: Approval, approved: boolean, note: string) => {
    setBusyId(approval.id);
    try {
      await api.post(`/api/approvals/${approval.id}/decision`, { approved, note });
      await load();
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusyId(null);
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[#0b1020]/20" onClick={onClose} role="presentation">
      <aside className="rise flex h-full w-full max-w-lg flex-col border-l border-line bg-canvas shadow-panel"
             role="dialog" aria-modal="true" aria-label="Approval gates"
             onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3">
          <div>
            <h2 className="text-[15px] font-semibold">Approval gates</h2>
            <p className="text-xs text-ink-faint">
              Destructive, deploy and credential actions stop here until you decide.
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close approvals">
            <X size={14} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 scroll-thin">
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {items === null && !error && <Loading label="Loading approvals" />}
          {items?.length === 0 && (
            <EmptyState title="Nothing waiting" body="No action is currently blocked on your approval." />
          )}
          {items?.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} busy={busyId === approval.id}
                          onDecide={decide} />
          ))}
        </div>
      </aside>
    </div>
  );
}

function ApprovalCard({
  approval, busy, onDecide,
}: { approval: Approval; busy: boolean; onDecide: (a: Approval, approved: boolean, note: string) => void }) {
  const [note, setNote] = useState("");
  const riskTone = approval.risk === "critical" ? "danger"
    : approval.risk === "high" ? "warning"
      : approval.risk === "medium" ? "neutral" : "muted";
  return (
    <article className="panel-flat p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{approval.action}</p>
          <p className="text-xs text-ink-faint">
            requested by {approval.requested_by} · {timeAgo(approval.created_at)}
          </p>
        </div>
        <Badge tone={riskTone}>{approval.risk} · {approval.risk_score.toFixed(2)}</Badge>
      </div>
      <pre className="code mt-2 max-h-40 overflow-y-auto">{JSON.stringify(approval.detail, null, 2)}</pre>
      <input className="field mt-2" placeholder="Note (optional, stored in the audit trail)"
             value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="danger" size="sm" busy={busy} onClick={() => onDecide(approval, false, note)}>Deny</Button>
        <Button variant="accent" size="sm" busy={busy} onClick={() => onDecide(approval, true, note)}>
          <Check size={13} /> Approve
        </Button>
      </div>
    </article>
  );
}

export function Toaster() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="panel rise pointer-events-auto p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-semibold">{toast.title}</p>
            <button type="button" className="text-ink-faint hover:text-ink" onClick={() => dismiss(toast.id)}
                    aria-label="Dismiss notification">
              <X size={13} />
            </button>
          </div>
          {toast.body && <p className="mt-0.5 text-xs text-ink-soft">{toast.body}</p>}
        </div>
      ))}
    </div>
  );
}

export function AreaHeader({
  title, subtitle, actions,
}: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
        {subtitle && <p className="mt-0.5 max-w-3xl text-[13px] text-ink-faint">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="text-xs text-ink-faint underline decoration-line underline-offset-2 hover:text-accent">
      {children}
    </Link>
  );
}

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("mx-auto w-full max-w-[1400px] p-5", className)}>{children}</div>;
}

export { Panel };
