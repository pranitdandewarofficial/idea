/** Extract and normalize structured validation JSON from model output. */

import type { Critique, Score, Severity, ValidationResult, Verdict } from './types';

const clamp1to10 = (n: number): number =>
  Math.min(10, Math.max(1, Math.round(Number.isFinite(n) ? n : 5)));

const isSeverity = (s: unknown): s is Severity => s === 'low' || s === 'medium' || s === 'high';
const isVerdict = (s: unknown): s is Verdict => s === 'PURSUE' || s === 'PIVOT' || s === 'KILL';

/**
 * Find the first balanced {...} block in text and JSON.parse it.
 * Handles markdown fences and leading/trailing commentary.
 * Returns null when nothing parseable is found.
 */
export function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null; // unbalanced / truncated
}

function asText(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function normalizeScore(raw: unknown): Score {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const market = clamp1to10(Number(s.market));
  const moat = clamp1to10(Number(s.moat));
  const timing = clamp1to10(Number(s.timing));
  const monetization = clamp1to10(Number(s.monetization));
  const overall = clamp1to10((market + moat + timing + monetization) / 4);
  return { market, moat, timing, monetization, overall };
}

function normalizeCritiques(raw: unknown): Critique[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((c) => {
    const o = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
    return {
      point: asText(o.point, 'Unclear weakness identified.'),
      solution: asText(o.solution, 'No solution provided — treat this as an open question.'),
      severity: isSeverity(o.severity) ? o.severity : 'medium',
    };
  });
}

/**
 * Normalize extracted JSON into a ValidationResult.
 * Returns null if the payload is not usable (caller falls back to raw text).
 */
export function normalizeValidation(
  payload: unknown,
  meta: { source: 'ai'; model?: string; tone?: ValidationResult['tone'] },
): ValidationResult | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const critiques = normalizeCritiques(o.critiques);
  if (critiques.length === 0) return null;
  const verdict: Verdict = isVerdict(o.verdict) ? o.verdict : 'PIVOT';
  return {
    source: meta.source,
    summary: asText(o.summary, 'Validation completed.'),
    score: normalizeScore(o.scores ?? o.score),
    critiques,
    verdict,
    verdictReason: asText(o.verdict_reason ?? o.verdictReason, 'See the full analysis.'),
    createdAt: Date.now(),
    model: meta.model,
    tone: meta.tone,
  };
}
