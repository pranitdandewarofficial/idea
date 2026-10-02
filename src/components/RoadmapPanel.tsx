/** Roadmap tab: template generation, AI enrichment, 7 stage accordions with checkboxes. */

import { useState } from 'react';
import type { AISettings, Idea, Roadmap } from '../lib/types';
import { AIError, chatCompletion } from '../lib/ai';
import { extractJson } from '../lib/parse';
import { buildRoadmapPrompt } from '../lib/prompts';
import { resolveBaseUrl, resolveModel } from '../lib/providers';
import { generateRoadmap, roadmapProgress, stageProgress } from '../lib/roadmap';
import {
  EmptyState,
  ErrorBanner,
  GhostButton,
  Icon,
  PrimaryButton,
  ProgressBar,
  Spinner,
} from './ui';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalizeEnriched(payload: unknown): Roadmap | null {
  if (!isRecord(payload)) return null;
  const raw = payload.stages;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const stages = raw.slice(0, 7).map((s, si) => {
    const o = isRecord(s) ? s : {};
    const checklist = Array.isArray(o.checklist)
      ? o.checklist
          .map((t, i) => ({
            id: `ai_s${si}_c${i}`,
            text: typeof t === 'string' ? t.trim() : '',
            done: false,
          }))
          .filter((c) => c.text)
      : [];
    if (checklist.length === 0) return null;
    return {
      stage: typeof o.stage === 'string' && o.stage.trim() ? o.stage.trim() : `Stage ${si + 1}`,
      objective: typeof o.objective === 'string' ? o.objective.trim() : '',
      checklist,
      milestone: typeof o.milestone === 'string' ? o.milestone.trim() : '',
      killCriteria:
        typeof o.kill_criteria === 'string'
          ? o.kill_criteria.trim()
          : typeof o.killCriteria === 'string'
            ? o.killCriteria.trim()
            : '',
    };
  });
  const valid = stages.filter((s) => s !== null);
  if (valid.length === 0) return null;
  return { stages: valid, generatedAt: Date.now(), source: 'ai' };
}

export function RoadmapPanel({
  idea,
  settings,
  onRoadmap,
  onToggleCheck,
}: {
  idea: Idea;
  settings: AISettings;
  onRoadmap: (r: Roadmap) => void;
  onToggleCheck: (stageIdx: number, itemId: string) => void;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roadmap = idea.roadmap;
  const hasKey = !!settings.apiKey.trim();

  const handleGenerate = () => {
    setError(null);
    onRoadmap(generateRoadmap(idea));
  };

  const handleEnrich = async () => {
    setEnriching(true);
    setError(null);
    try {
      const { system, user } = buildRoadmapPrompt(idea, settings.tone);
      const text = await chatCompletion({
        baseUrl: resolveBaseUrl(settings.providerId, settings.customBaseUrl),
        apiKey: settings.apiKey.trim(),
        model: resolveModel(settings.providerId, settings.model),
        system,
        user,
        timeoutMs: 90000,
      });
      const normalized = normalizeEnriched(extractJson(text));
      if (normalized) {
        onRoadmap(normalized);
      } else {
        setError(
          'AI roadmap could not be parsed — keeping the current roadmap. Try again.',
        );
      }
    } catch (e) {
      setError(e instanceof AIError ? e.message : `Roadmap enrichment failed: ${String(e)}`);
    } finally {
      setEnriching(false);
    }
  };

  if (!roadmap) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon="kanban"
          art="kanban"
          title="No roadmap yet"
          hint="Generate the 7-stage billion-dollar roadmap for this idea."
        />
        <PrimaryButton onClick={handleGenerate} className="w-full">
          <Icon name="sparkles" className="w-4 h-4" />
          Generate roadmap
        </PrimaryButton>
      </div>
    );
  }

  const overall = roadmapProgress(roadmap);

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-bold text-ivory">Overall progress</span>
          <span className="text-sm font-bold text-gold-400">{overall}%</span>
        </div>
        <ProgressBar value={overall} />
        <p className="mt-2 text-[11px] text-muted">
          {roadmap.source === 'ai' ? 'Enriched by AI' : 'Template'} · generated{' '}
          {new Date(roadmap.generatedAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
        </p>
      </div>

      <div className="space-y-3">
        {roadmap.stages.map((stage, si) => {
          const sp = stageProgress(stage);
          const isOpen = !!open[si];
          return (
            <div key={`${stage.stage}-${si}`} className="overflow-hidden rounded-2xl border border-ink-700 bg-ink-900">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [si]: !o[si] }))}
                aria-expanded={isOpen}
                className="flex min-h-[60px] w-full items-center gap-3 p-4 text-left"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-800 text-xs font-bold text-gold-400">
                  {si + 1}
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-bold text-ivory">{stage.stage}</span>
                  <span className="mt-1 block">
                    <ProgressBar value={sp} />
                  </span>
                </span>
                <span className="text-xs font-semibold text-muted">{sp}%</span>
                <Icon
                  name="chevronDown"
                  className={`w-4 h-4 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>

              <div
                className={`grid transition-all duration-300 ease-in-out ${
                  isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                }`}
              >
                <div className="overflow-hidden" inert={!isOpen}>
                  <div className="space-y-3 border-t border-ink-700 p-4">
                    {stage.objective && (
                      <p className="text-sm leading-relaxed text-muted">{stage.objective}</p>
                    )}

                    <div className="space-y-2">
                      {stage.checklist.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onToggleCheck(si, item.id)}
                          className="flex min-h-[44px] w-full items-center gap-2.5 rounded-xl bg-ink-800 px-3 py-2.5 text-left transition active:scale-[0.99]"
                        >
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
                              item.done
                                ? 'border-gold-400 bg-gold-400 text-ink-950'
                                : 'border-ink-600 text-transparent'
                            }`}
                          >
                            <Icon name="check" className="w-3.5 h-3.5" />
                          </span>
                          <span
                            className={`text-sm leading-snug ${
                              item.done ? 'text-muted line-through' : 'text-ivory'
                            }`}
                          >
                            {item.text}
                          </span>
                        </button>
                      ))}
                    </div>

                    {stage.milestone && (
                      <div className="rounded-xl border border-gold-400/30 bg-gold-400/5 p-3">
                        <p className="text-xs font-bold uppercase tracking-wider text-gold-400">
                          Milestone
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-ivory">{stage.milestone}</p>
                      </div>
                    )}

                    {stage.killCriteria && (
                      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
                        <p className="text-xs font-bold uppercase tracking-wider text-red-300">
                          Kill criteria
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-muted">
                          {stage.killCriteria}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <GhostButton onClick={handleGenerate} className="flex-1">
          <Icon name="refresh" className="w-4 h-4" />
          Regenerate template
        </GhostButton>
        <PrimaryButton
          onClick={handleEnrich}
          disabled={!hasKey || enriching}
          className="flex-1"
        >
          {enriching ? <Spinner className="w-4 h-4" /> : <Icon name="sparkles" className="w-4 h-4" />}
          {enriching ? 'Enriching…' : 'Enrich roadmap with AI'}
        </PrimaryButton>
      </div>
      {!hasKey && (
        <p className="text-center text-xs text-muted">Add an API key in Settings to enrich with AI.</p>
      )}
    </div>
  );
}
