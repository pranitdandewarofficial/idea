import { describe, it, expect } from 'vitest';
import { analyzeHeuristic, type HeuristicInput } from './heuristic';
import type { Score } from './types';

function assertScoresInRange(score: Score): void {
  for (const key of ['market', 'moat', 'timing', 'monetization', 'overall'] as const) {
    expect(score[key], `score.${key}`).toBeGreaterThanOrEqual(1);
    expect(score[key], `score.${key}`).toBeLessThanOrEqual(10);
  }
}

describe('analyzeHeuristic', () => {
  const input: HeuristicInput = {
    title: 'Freelancer invoicing app',
    description:
      'An invoicing tool for Indian freelancers with UPI reminders, GST invoices, and automatic late-fee nudges.',
    tags: ['fintech', 'saas'],
  };

  it('returns bounded scores, >=3 critiques with point+solution, a valid verdict, heuristic source', () => {
    const result = analyzeHeuristic(input);
    assertScoresInRange(result.score);
    expect(result.source).toBe('heuristic');
    expect(['PURSUE', 'PIVOT', 'KILL']).toContain(result.verdict);
    expect(result.critiques.length).toBeGreaterThanOrEqual(3);
    for (const c of result.critiques) {
      expect(c.point.trim().length).toBeGreaterThan(0);
      expect(c.solution.trim().length).toBeGreaterThan(0);
    }
    expect(typeof result.summary).toBe('string');
    expect(typeof result.verdictReason).toBe('string');
  });

  it('is deterministic: same input twice -> same verdict and scores', () => {
    const a = analyzeHeuristic(input);
    const b = analyzeHeuristic(input);
    expect(a.verdict).toBe(b.verdict);
    expect(a.score).toEqual(b.score);
    expect(a.critiques.map((c) => c.point)).toEqual(b.critiques.map((c) => c.point));
  });

  it('scores a strong idea highly (PURSUE or PIVOT, overall >= 6)', () => {
    const strong: HeuristicInput = {
      title: 'Acme billing SaaS',
      description:
        'B2B SaaS subscription platform for billing automation with a proprietary data moat, ' +
        'network effects across accounting firms, and AI-powered dunning. Clear pricing at ' +
        '499 per seat per month. Named customers already paying: Acme Corp and Beta Ltd.',
      tags: ['b2b', 'saas', 'fintech'],
    };
    const result = analyzeHeuristic(strong);
    assertScoresInRange(result.score);
    expect(result.score.overall).toBeGreaterThanOrEqual(6);
    expect(['PURSUE', 'PIVOT']).toContain(result.verdict);
  });

  it('kills or pivots an empty/vague idea with a "thinly described" critique', () => {
    const vague: HeuristicInput = { title: 'AppX', description: 'abcde', tags: [] };
    const result = analyzeHeuristic(vague);
    expect(['KILL', 'PIVOT']).toContain(result.verdict);
    const hasThinCritique = result.critiques.some(
      (c) => c.point.includes('thinly') || c.point.includes('one-liner'),
    );
    expect(hasThinCritique).toBe(true);
  });
});
