/** Shared UI primitives: icons, badges, bars, spinner. No emojis — SVG only. */

import { useEffect, useState, type ReactNode } from 'react';
import { STAGES, type StageId, type Verdict } from '../lib/types';

export type IconName =
  | 'plus'
  | 'search'
  | 'star'
  | 'mic'
  | 'stop'
  | 'trash'
  | 'back'
  | 'check'
  | 'sparkles'
  | 'download'
  | 'upload'
  | 'key'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'x'
  | 'pencil'
  | 'eye'
  | 'eyeOff'
  | 'refresh'
  | 'alert'
  | 'zap'
  | 'shield'
  | 'kanban'
  | 'archive'
  | 'database'
  | 'activity'
  | 'settings';

const ICONS: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </>
  ),
  star: <path d="M12 2.5l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8-6.1-3.4-6.1 3.4 1.4-6.8L2.2 9.6l6.9-.8L12 2.5z" />,
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 18v4M8 22h8" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </>
  ),
  back: <path d="M19 12H5m7-7-7 7 7 7" />,
  check: <path d="M20 6 9 17l-5-5" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
      <path d="M5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15z" />
    </>
  ),
  download: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  upload: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  pencil: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19" />
      <path d="M6.61 6.61A17.5 17.5 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 4.39-.91" />
      <path d="m2 2 20 20" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 9v4m0 4h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </>
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  kanban: (
    <>
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="11" rx="1" />
      <rect x="17" y="3" width="4" height="7" rx="1" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </>
  ),
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
};

export function Icon({
  name,
  className = 'w-5 h-5',
  filled = false,
}: {
  name: IconName;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export function Spinner({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const styles: Record<Verdict, string> = {
    PURSUE: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    PIVOT: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    KILL: 'border-red-500/40 bg-red-500/10 text-red-300',
  };
  const icon: IconName = verdict === 'PURSUE' ? 'check' : verdict === 'PIVOT' ? 'refresh' : 'x';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold tracking-wider ${styles[verdict]}`}
    >
      <Icon name={icon} className="w-3 h-3" />
      {verdict}
    </span>
  );
}

export function StagePill({ stage }: { stage: StageId }) {
  const s = STAGES.find((x) => x.id === stage);
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-ink-600 bg-ink-800 px-2 py-0.5 text-[11px] font-medium text-muted">
      {s?.label ?? stage}
    </span>
  );
}

export function TagChip({ tag }: { tag: string }) {
  return (
    <span className="inline-flex max-w-full items-center break-all rounded-md bg-ink-800 px-1.5 py-0.5 text-[11px] text-muted">
      #{tag}
    </span>
  );
}

export function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-ink-700 ${className}`}>
      <div
        className="h-full rounded-full bg-gold-400 transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function ScoreBar({ label, value }: { label: string; value: number }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setW(value * 10));
    return () => cancelAnimationFrame(raf);
  }, [value]);
  const color =
    value >= 7 ? 'bg-emerald-400' : value >= 4 ? 'bg-gold-400' : 'bg-red-400';
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-muted">{label}</span>
        <span className="font-bold text-ivory">{value}/10</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-700">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${color}`}
          style={{ width: `${w}%` }}
        />
      </div>
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      <Icon name="alert" className="mt-0.5 w-4 h-4 shrink-0" />
      <p className="flex-1">{message}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded text-red-300 hover:text-red-100"
          aria-label="Dismiss"
        >
          <Icon name="x" className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  art,
  title,
  hint,
}: {
  icon: IconName;
  art?: 'vault' | 'kanban' | 'zap';
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-ink-600 bg-ink-900/50 px-6 py-10 text-center">
      {art ? <EmptyArt kind={art} /> : <Icon name={icon} className="w-8 h-8 text-muted" />}
      <p className="font-semibold text-ivory">{title}</p>
      {hint && <p className="max-w-[28ch] text-sm text-muted">{hint}</p>}
    </div>
  );
}

type EmptyArtKind = 'vault' | 'kanban' | 'zap';

const ART_STROKE = 'currentColor';
const ART_GOLD = '#e8b44c';

function EmptyArt({ kind }: { kind: EmptyArtKind }) {
  return (
    <svg
      viewBox="0 0 120 96"
      className="h-24 w-auto text-muted/60"
      fill="none"
      stroke={ART_STROKE}
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="60" cy="88" rx="38" ry="5" stroke="none" fill={ART_GOLD} opacity="0.14" />
      {kind === 'vault' && (
        <>
          <path d="M32 52h56v24a6 6 0 0 1-6 6H38a6 6 0 0 1-6-6V52z" />
          <path d="M28 38h64l-7 12H35l-7-12z" />
          <path d="M52 64h16" stroke={ART_GOLD} />
          <path d="M46 16v10M41 21h10" stroke={ART_GOLD} />
          <path d="M76 10v8M72 14h8" stroke={ART_GOLD} />
          <circle cx="62" cy="28" r="2" stroke="none" fill={ART_GOLD} />
        </>
      )}
      {kind === 'kanban' && (
        <>
          <rect x="16" y="20" width="26" height="58" rx="6" />
          <rect x="47" y="20" width="26" height="58" rx="6" />
          <rect x="78" y="20" width="26" height="58" rx="6" />
          <rect x="21" y="28" width="16" height="11" rx="3" stroke={ART_GOLD} />
          <rect x="21" y="45" width="16" height="11" rx="3" />
          <rect x="52" y="28" width="16" height="11" rx="3" />
          <rect x="83" y="28" width="16" height="11" rx="3" />
          <rect x="83" y="45" width="16" height="11" rx="3" stroke={ART_GOLD} />
        </>
      )}
      {kind === 'zap' && (
        <>
          <path
            d="M66 10 36 54h17l-3 30 34-44H66l0-30z"
            stroke={ART_GOLD}
            fill={ART_GOLD}
            fillOpacity="0.12"
          />
          <path d="M26 26l-7-9M94 26l7-9M20 52H10M100 52h10" />
        </>
      )}
    </svg>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const widths = [92, 76, 86, 62];
  return (
    <div className="space-y-2.5 rounded-2xl border border-ink-700 bg-ink-900 p-4" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-3.5 rounded-md"
          style={{ width: `${widths[i % widths.length]}%` }}
        />
      ))}
    </div>
  );
}

export function SelectWrap({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      {children}
      <Icon
        name="chevronDown"
        className="pointer-events-none absolute right-3 top-1/2 w-4 h-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-gold-400 px-4 py-2.5 text-sm font-bold text-ink-950 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-ink-600 bg-ink-800 px-4 py-2.5 text-sm font-semibold text-ivory transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-xl border border-ink-600 bg-ink-800 px-3 py-2.5 text-sm text-ivory placeholder:text-muted/60 outline-none focus:border-gold-400/60 focus:ring-2 focus:ring-gold-400/20';

export const selectClass = `${inputClass} appearance-none pr-9`;
