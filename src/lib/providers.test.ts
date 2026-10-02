import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, getPreset, resolveBaseUrl, resolveModel } from './providers';

describe('resolveBaseUrl', () => {
  it('trims trailing slashes from a custom base URL', () => {
    expect(resolveBaseUrl('custom', 'https://x.example.com///')).toBe('https://x.example.com');
    expect(resolveBaseUrl('custom', 'https://x.example.com/v1/')).toBe(
      'https://x.example.com/v1',
    );
  });

  it('trims surrounding whitespace too', () => {
    expect(resolveBaseUrl('custom', '  https://x.example.com/  ')).toBe(
      'https://x.example.com',
    );
  });

  it('returns the preset base URL for known providers', () => {
    expect(resolveBaseUrl('openai', '')).toBe('https://api.openai.com/v1');
  });
});

describe('getPreset fallback', () => {
  it('falls back to a preset instead of crashing on unknown ids', () => {
    const preset = getPreset('not-a-provider');
    expect(PROVIDER_PRESETS).toContainEqual(preset);
    expect(preset.id).toBe('together');
  });

  it('unknown provider ids resolve to the fallback preset base URL', () => {
    expect(resolveBaseUrl('not-a-provider', '')).toBe(PROVIDER_PRESETS[3].baseUrl);
  });
});

describe('resolveModel', () => {
  it('returns the typed model when one is given', () => {
    expect(resolveModel('groq', 'my-custom-model')).toBe('my-custom-model');
  });

  it('returns the preset default when model is blank', () => {
    expect(resolveModel('openai', '')).toBe('gpt-4o-mini');
    expect(resolveModel('openai', '   ')).toBe('gpt-4o-mini');
  });

  it('falls back to the fallback preset default for unknown providers', () => {
    expect(resolveModel('not-a-provider', '')).toBe(PROVIDER_PRESETS[3].defaultModel);
  });
});
