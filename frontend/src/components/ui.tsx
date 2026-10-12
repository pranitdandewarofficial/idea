/** Shared UI primitives. Plain, light, one accent colour, no decoration for its own sake. */
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, X } from "lucide-react";
import type { Tone } from "../lib/format";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "badge",
  muted: "badge badge-muted",
  accent: "badge badge-accent",
  positive: "badge badge-positive",
  warning: "badge badge-warning",
  danger: "badge badge-danger",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx(TONE_CLASS[tone], className)}>{children}</span>;
}

export function Panel({
  title, subtitle, actions, children, className, bodyClassName,
}: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode;
  className?: string; bodyClassName?: string;
}) {
  return (
    <section className={clsx("panel flex min-h-0 flex-col", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx("min-h-0 flex-1", bodyClassName ?? "p-4")}>{children}</div>
    </section>
  );
}

export function Button({
  children, onClick, variant = "default", size = "md", disabled, busy, title, type = "button", className,
}: {
  children: ReactNode; onClick?: () => void; variant?: "default" | "accent" | "danger" | "ghost";
  size?: "sm" | "md"; disabled?: boolean; busy?: boolean; title?: string; type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={clsx(
        "btn",
        size === "sm" && "btn-sm",
        variant === "accent" && "btn-accent",
        variant === "danger" && "btn-danger",
        variant === "ghost" && "btn-ghost",
        className,
      )}
    >
      {busy && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Field({
  label, hint, children, htmlFor,
}: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </label>
  );
}

export function Toggle({
  checked, onChange, label, description, disabled,
}: {
  checked: boolean; onChange: (next: boolean) => void; label: string;
  description?: ReactNode; disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-soft py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {description && <p className="mt-0.5 text-xs text-ink-faint">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150",
          checked ? "border-accent bg-accent" : "border-line bg-sunken",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all duration-150",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "positive" | "warning" }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bar = tone === "positive" ? "bg-positive" : tone === "warning" ? "bg-warning" : "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar"
         aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx("h-full rounded-full transition-[width] duration-260 ease-out", bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink",
  muted: "text-ink-faint",
  accent: "text-accent",
  positive: "text-positive",
  warning: "text-warning",
  danger: "text-danger",
};

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="panel-flat px-3 py-2.5">
      <p className="label">{label}</p>
      <p className={clsx("numeric mt-1 text-[20px] leading-6 font-semibold", TONE_TEXT[tone ?? "neutral"])}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-[13px] text-ink-faint">
      <Loader2 size={14} className="animate-spin" />
      {label}…
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-[#f2cfcc] bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Request failed</p>
        <p className="mt-0.5 break-words text-[12px] text-ink-soft">{message}</p>
        {onRetry && (
          <button type="button" className="btn btn-sm mt-2" onClick={onRetry}>Try again</button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-line bg-sunken/60 px-4 py-6">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {body && <div className="text-xs text-ink-faint">{body}</div>}
      {action}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Modal({
  open, title, children, onClose, wide,
}: { open: boolean; title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0b1020]/25 p-6"
         role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        className={clsx("panel rise mt-8 w-full", wide ? "max-w-4xl" : "max-w-xl")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4 scroll-thin">{children}</div>
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {items.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-ink-faint">{key}</dt>
          <dd className="min-w-0 break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
