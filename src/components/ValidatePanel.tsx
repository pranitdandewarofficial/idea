/** Validate tab: AI validation, offline heuristic, score bars, critiques, raw fallback. */

import { useState } from 'react';
import type { AISettings, Idea, Severity, ValidationResult } from '../lib/types';
import { AIError, chatCompletion } from '../lib/ai';
import { analyzeHeuristic } from '../lib/heuristic';
import { extractJson, normalizeValidation } from '../lib/parse';
import { buildValidationPrompt } from '../lib/prompts';
import { resolveBaseUrl, resolveModel } from '../lib/providers';
import {
  EmptyState,
  ErrorBanner,
  GhostButton,
  Icon,
  PrimaryButton,
  ScoreBar,
  SkeletonCard,
  Spinner,
  VerdictBadge,
} from './ui';

const SEVERITY_STYLES: Record<Severity, string> = {
  high: 'border-red-500/40 bg-red-500/10 text-red-300',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  low: 'border-ink-600 bg-ink-800 text-muted',
};

export function ValidatePanel({
  idea,
  settings,
  onValidation,
}: {
  idea: Idea;
  settings: AISettings;
  onValidation: (v: ValidationResult) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);

  const hasKey = !!settings.apiKey.trim();
  const validation = idea.validation;

  const resolveCall = () => ({
    baseUrl: resolveBaseUrl(settings.providerId, settings.customBaseUrl),
    apiKey: settings.apiKey.trim(),
    model: resolveModel(settings.providerId, settings.model),
  });

  const runAI = async () => {
    setRunning(true);
    setError(null);
    try {
      const { system, user } = buildValidationPrompt(idea, settings.tone);
      const text = await chatCompletion({ ...resolveCall(), system, user });
      const payload = extractJson(text);
      const normalized = normalizeValidation(payload, {
        source: 'ai',
        model: resolveCall().model,
        tone: settings.tone,
      });
      if (normalized) {
        setRawText(null);
        onValidation(normalized);
      } else {
        setRawText(text);
      }
    } catch (e) {
      setError(e instanceof AIError ? e.message : `Validation failed: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const runHeuristic = () => {
    setRunning(true);
    setError(null);
    try {
      const v = analyzeHeuristic({
        title: idea.title,
        description: idea.description,
        tags: idea.tags,
      });
      setRawText(null);
      onValidation(v);
    } catch (e) {
      setError(`Smart analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  if (!validation && !rawText) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon="zap"
          art="zap"
          title="Not validated yet"
          hint="Get a brutal, first-principles teardown of this idea."
        />
        <PrimaryButton onClick={runAI} disabled={!hasKey || running} className="w-full">
          {running ? <Spinner /> : <Icon name="sparkles" className="w-4 h-4" />}
          {running ? 'Validating…' : 'Validate with AI'}
        </PrimaryButton>
        {!hasKey && (
          <p className="text-center text-xs text-muted">Add an API key in Settings to enable this.</p>
        )}
        <GhostButton onClick={runHeuristic} disabled={running} className="w-full">
          <Icon name="shield" className="w-4 h-4" />
          Run Smart Analysis (offline)
        </GhostButton>
        {running && (
          <div className="space-y-3" role="status" aria-label="Analyzing idea">
            <SkeletonCard lines={3} />
            <SkeletonCard lines={4} />
          </div>
        )}
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {rawText && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Icon name="alert" className="w-4 h-4 text-amber-300" />
            <p className="text-sm font-semibold text-amber-200">
              AI replied, but the output was not valid JSON — showing raw text.
            </p>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-ink-950 p-3 text-xs leading-relaxed text-muted">
            {rawText}
          </pre>
        </div>
      )}

      {validation && (
        <>
          <div className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={validation.verdict} />
              <span className="text-[11px] text-muted">
                {validation.source === 'ai'
                  ? `AI · ${validation.model ?? 'unknown model'}`
                  : 'Smart Analysis · offline'}
                {' · '}
                {new Date(validation.createdAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-ivory">{validation.summary}</p>
            <p className="mt-2 text-sm text-muted">
              <span className="font-semibold text-ivory">Verdict: </span>
              {validation.verdictReason}
            </p>
          </div>

          <div className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
            <h4 className="mb-3 text-sm font-bold text-ivory">Scores</h4>
            <div className="space-y-3">
              <ScoreBar label="Market" value={validation.score.market} />
              <ScoreBar label="Moat" value={validation.score.moat} />
              <ScoreBar label="Timing" value={validation.score.timing} />
              <ScoreBar label="Monetization" value={validation.score.monetization} />
              <ScoreBar label="Overall" value={validation.score.overall} />
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-bold text-ivory">
              Brutal critiques ({validation.critiques.length})
            </h4>
            {validation.critiques.map((c, i) => (
              <div key={i} className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
                <span
                  className={`mb-2 inline-block rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${SEVERITY_STYLES[c.severity]}`}
                >
                  {c.severity}
                </span>
                <p className="text-sm leading-relaxed text-ivory">{c.point}</p>
                <div className="mt-2 rounded-xl bg-ink-800 p-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-gold-400">
                    Solution
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{c.solution}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex gap-2">
        <GhostButton onClick={runAI} disabled={!hasKey || running} className="flex-1">
          {running ? <Spinner className="w-4 h-4" /> : <Icon name="refresh" className="w-4 h-4" />}
          Re-run AI
        </GhostButton>
        <GhostButton onClick={runHeuristic} disabled={running} className="flex-1">
          <Icon name="shield" className="w-4 h-4" />
          Re-run offline
        </GhostButton>
      </div>
      {!hasKey && (
        <p className="text-center text-xs text-muted">Add an API key in Settings to use AI.</p>
      )}
    </div>
  );
}
