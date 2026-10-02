import { describe, it, expect } from 'vitest';
import { extractJson, normalizeValidation } from './parse';

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a": 1, "b": "x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses JSON inside ```json fences', () => {
    const text = 'Here is the result:\n```json\n{"a": 1}\n```';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it('parses JSON with leading commentary text', () => {
    const text = 'Sure! After thinking it over, here is my analysis:\n{"verdict": "PURSUE"}';
    expect(extractJson(text)).toEqual({ verdict: 'PURSUE' });
  });

  it('returns null for truncated JSON (unbalanced braces)', () => {
    expect(extractJson('{"a": 1, "b": {"c": 2')).toBeNull();
  });

  it('returns null when there are no braces at all', () => {
    expect(extractJson('no json here, just words')).toBeNull();
  });

  it('handles nested braces and braces inside strings', () => {
    const text = '{"text": "hello { world }", "nested": {"k": "}"}}';
    expect(extractJson(text)).toEqual({ text: 'hello { world }', nested: { k: '}' } });
  });

  it('returns null for a balanced-but-invalid candidate', () => {
    expect(extractJson('{not valid json}')).toBeNull();
  });
});

describe('normalizeValidation', () => {
  it('normalizes a valid payload: clamps scores, passes verdict through', () => {
    const payload = {
      summary: 'Looks solid.',
      scores: { market: 99, moat: -3, timing: 5, monetization: 10 },
      critiques: [{ point: 'weak moat', solution: 'build data moat', severity: 'extreme' }],
      verdict: 'PURSUE',
      verdict_reason: 'Strong across the board.',
    };
    const result = normalizeValidation(payload, { source: 'ai' });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('ai');
    expect(result!.score.market).toBe(10); // 99 clamped
    expect(result!.score.moat).toBe(1); // -3 clamped
    expect(result!.score.timing).toBe(5);
    expect(result!.score.monetization).toBe(10);
    expect(result!.score.overall).toBe(7); // rounded mean of (10+1+5+10)/4 = 6.5
    expect(result!.verdict).toBe('PURSUE');
    expect(result!.critiques[0].severity).toBe('medium'); // invalid severity -> medium
    expect(result!.critiques[0].point).toBe('weak moat');
    expect(result!.critiques[0].solution).toBe('build data moat');
  });

  it('returns null when critiques are missing', () => {
    expect(normalizeValidation({ summary: 'x', scores: {} }, { source: 'ai' })).toBeNull();
    expect(normalizeValidation({ critiques: [] }, { source: 'ai' })).toBeNull();
  });

  it('defaults missing verdict to PIVOT', () => {
    const result = normalizeValidation(
      { critiques: [{ point: 'p', solution: 's', severity: 'low' }] },
      { source: 'ai' },
    );
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('PIVOT');
  });

  it('overall equals the rounded mean of the four clamped scores', () => {
    const result = normalizeValidation(
      {
        scores: { market: 8, moat: 8, timing: 8, monetization: 7 },
        critiques: [{ point: 'p', solution: 's' }],
      },
      { source: 'ai' },
    );
    expect(result!.score.overall).toBe(8); // 31/4 = 7.75 -> 8
  });

  it('returns null for non-object payloads', () => {
    expect(normalizeValidation(null, { source: 'ai' })).toBeNull();
    expect(normalizeValidation('string', { source: 'ai' })).toBeNull();
  });
});
