/** IdeaForge v1 — App shell: vault, tracker, settings tabs + idea detail + capture modal. */

import { useEffect, useMemo, useState } from 'react';
import { exportBackup, importBackup, loadState, saveState } from './lib/store';
import {
  DEFAULT_SETTINGS,
  STAGES,
  newIdea,
  type AISettings,
  type AppState,
  type Idea,
  type StageId,
} from './lib/types';
import { CaptureModal, type CaptureData } from './components/CaptureModal';
import { IdeaCard } from './components/IdeaCard';
import { IdeaDetail } from './components/IdeaDetail';
import { SettingsPanel } from './components/SettingsPanel';
import { TrackerBoard } from './components/TrackerBoard';
import { EmptyState, Icon, type IconName } from './components/ui';

type Tab = 'vault' | 'tracker' | 'settings';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'vault', label: 'Vault', icon: 'archive' },
  { id: 'tracker', label: 'Tracker', icon: 'kanban' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [tab, setTab] = useState<Tab>('vault');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const updateIdea = (id: string, patch: Partial<Idea>) =>
    setState((s) => ({
      ...s,
      ideas: s.ideas.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i)),
    }));

  const patchSettings = (patch: Partial<AISettings>) =>
    setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));

  const handleCaptureSave = (d: CaptureData) => {
    const idea = newIdea(d.title, d.description, d.tags);
    if (d.voiceNote) idea.voiceNote = d.voiceNote;
    setState((s) => ({ ...s, ideas: [idea, ...s.ideas] }));
    setCaptureOpen(false);
  };

  const deleteIdea = (id: string) => {
    setState((s) => ({ ...s, ideas: s.ideas.filter((i) => i.id !== id) }));
    setSelectedId((sel) => (sel === id ? null : sel));
  };

  const moveStage = (id: string, dir: -1 | 1) => {
    const idea = state.ideas.find((i) => i.id === id);
    if (!idea) return;
    const idx = STAGES.findIndex((s) => s.id === idea.stage);
    const next = STAGES[idx + dir];
    if (next) updateIdea(id, { stage: next.id });
  };

  const dropStage = (id: string, stage: StageId) => updateIdea(id, { stage });

  const toggleChecklist = (ideaId: string, stageIdx: number, itemId: string) =>
    setState((s) => ({
      ...s,
      ideas: s.ideas.map((i) => {
        if (i.id !== ideaId || !i.roadmap) return i;
        return {
          ...i,
          updatedAt: Date.now(),
          roadmap: {
            ...i.roadmap,
            stages: i.roadmap.stages.map((st, si) =>
              si !== stageIdx
                ? st
                : {
                    ...st,
                    checklist: st.checklist.map((c) =>
                      c.id === itemId ? { ...c, done: !c.done } : c,
                    ),
                  },
            ),
          },
        };
      }),
    }));

  const handleExport = () => {
    const blob = new Blob([exportBackup(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ideaforge-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportRaw = (raw: string) => {
    const next = importBackup(raw); // throws on invalid backup
    if (
      !window.confirm(`Replace all current data with this backup (${next.ideas.length} ideas)?`)
    )
      return;
    setState(next);
    setSelectedId(null);
  };

  const handleClear = () => {
    setState({ ideas: [], settings: { ...DEFAULT_SETTINGS } });
    setSelectedId(null);
  };

  const allTags = useMemo(
    () => [...new Set(state.ideas.flatMap((i) => i.tags))].sort(),
    [state.ideas],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.ideas.filter((i) => {
      if (starredOnly && !i.starred) return false;
      if (tagFilter && !i.tags.includes(tagFilter)) return false;
      if (q) {
        const hay = `${i.title} ${i.description} ${i.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [state.ideas, search, tagFilter, starredOnly]);

  const selected = selectedId ? state.ideas.find((i) => i.id === selectedId) ?? null : null;

  return (
    <div className="min-h-dvh bg-ink-950 text-ivory">
      <div className="mx-auto max-w-3xl px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))]">
        {selected ? (
          <IdeaDetail
            idea={selected}
            settings={state.settings}
            onBack={() => setSelectedId(null)}
            onUpdate={(patch) => updateIdea(selected.id, patch)}
            onToggleCheck={(si, itemId) => toggleChecklist(selected.id, si, itemId)}
          />
        ) : tab === 'vault' ? (
          <>
            <header className="mb-4 flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gold-400/15 text-gold-400">
                <Icon name="sparkles" className="w-5 h-5" />
              </span>
              <h1 className="text-xl font-extrabold tracking-tight">
                Idea<span className="text-gold-400">Forge</span>
              </h1>
              <span className="ml-1 rounded-full bg-ink-800 px-2.5 py-0.5 text-xs font-bold text-muted">
                {state.ideas.length}
              </span>
            </header>

            <div className="relative mb-3">
              <Icon
                name="search"
                className="pointer-events-none absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-muted"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ideas…"
                className="w-full rounded-xl border border-ink-600 bg-ink-900 py-2.5 pl-9 pr-3 text-sm text-ivory placeholder:text-muted/60 outline-none focus:border-gold-400/60 focus:ring-2 focus:ring-gold-400/20"
              />
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setStarredOnly((v) => !v)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                  starredOnly
                    ? 'border-gold-400/60 bg-gold-400/15 text-gold-400'
                    : 'border-ink-600 bg-ink-800 text-muted'
                }`}
              >
                <Icon name="star" className="w-3.5 h-3.5" filled={starredOnly} />
                Starred
              </button>
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTagFilter((f) => (f === t ? null : t))}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                    tagFilter === t
                      ? 'border-gold-400/60 bg-gold-400/15 text-gold-400'
                      : 'border-ink-600 bg-ink-800 text-muted'
                  }`}
                >
                  #{t}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <EmptyState
                icon="archive"
                art="vault"
                title={state.ideas.length === 0 ? 'Your vault is empty' : 'No ideas match'}
                hint={
                  state.ideas.length === 0
                    ? 'Tap the + button to capture your first idea.'
                    : 'Try a different search or clear the filters.'
                }
              />
            ) : (
              <div className="space-y-3">
                {filtered.map((idea) => (
                  <IdeaCard
                    key={idea.id}
                    idea={idea}
                    onOpen={() => setSelectedId(idea.id)}
                    onToggleStar={() => updateIdea(idea.id, { starred: !idea.starred })}
                    onDelete={() => deleteIdea(idea.id)}
                  />
                ))}
              </div>
            )}
          </>
        ) : tab === 'tracker' ? (
          <>
            <header className="mb-4">
              <h1 className="text-xl font-extrabold tracking-tight">
                Pipeline <span className="text-gold-400">Tracker</span>
              </h1>
              <p className="mt-0.5 text-sm text-muted">
                Drag cards between stages or use the arrows.
              </p>
            </header>
            <TrackerBoard
              ideas={state.ideas}
              onOpen={(id) => setSelectedId(id)}
              onMoveStage={moveStage}
              onDropStage={dropStage}
            />
          </>
        ) : (
          <>
            <header className="mb-4">
              <h1 className="text-xl font-extrabold tracking-tight">Settings</h1>
            </header>
            <SettingsPanel
              state={state}
              onSettings={patchSettings}
              onExport={handleExport}
              onImportRaw={handleImportRaw}
              onClear={handleClear}
            />
          </>
        )}
      </div>

      {tab === 'vault' && !selected && (
        <button
          type="button"
          onClick={() => setCaptureOpen(true)}
          aria-label="New idea"
          className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gold-400 text-ink-950 shadow-lg shadow-gold-400/20 transition active:scale-95"
        >
          <Icon name="plus" className="w-6 h-6" />
        </button>
      )}

      {captureOpen && (
        <CaptureModal onClose={() => setCaptureOpen(false)} onSave={handleCaptureSave} />
      )}

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <div className="mx-auto grid max-w-3xl grid-cols-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id && !selected ? 'page' : undefined}
              onClick={() => {
                setTab(t.id);
                setSelectedId(null);
              }}
              className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition ${
                tab === t.id && !selected ? 'text-gold-400' : 'text-muted hover:text-ivory'
              }`}
            >
              <Icon name={t.icon} className="w-5 h-5" />
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
