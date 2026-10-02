import { describe, it, expect } from 'vitest';
import {
  STORAGE_KEY,
  defaultState,
  exportBackup,
  importBackup,
  loadState,
  saveState,
} from './store';
import { DEFAULT_SETTINGS, type AppState, type Idea } from './types';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function sampleIdea(): Idea {
  return {
    id: 'idea_abc123',
    title: 'Test Idea',
    description: 'A description',
    tags: ['saas', 'b2b'],
    starred: true,
    stage: 'captured',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  };
}

describe('loadState', () => {
  it('returns defaults when storage is empty', () => {
    const state = loadState(new MemoryStorage());
    expect(state).toEqual(defaultState());
    expect(state.ideas).toEqual([]);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('restores ideas + settings, merging settings over DEFAULT_SETTINGS', () => {
    const storage = new MemoryStorage();
    const idea = sampleIdea();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        ideas: [idea],
        settings: { apiKey: 'sk-test' },
      }),
    );
    const state = loadState(storage);
    expect(state.ideas).toEqual([idea]);
    expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, apiKey: 'sk-test' });
  });

  it('returns defaults on corrupt JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{this is not valid json');
    expect(loadState(storage)).toEqual(defaultState());
  });

  it('returns defaults when stored version is newer than current', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, ideas: [sampleIdea()], settings: {} }),
    );
    expect(loadState(storage)).toEqual(defaultState());
  });

  it('returns empty ideas when ideas is not an array', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ideas: 'nope', settings: {} }));
    const state = loadState(storage);
    expect(state.ideas).toEqual([]);
  });
});

describe('saveState round-trip', () => {
  it('saves and loads back identical state via a fake in-memory storage', () => {
    const storage = new MemoryStorage();
    const state: AppState = {
      ideas: [sampleIdea()],
      settings: { ...DEFAULT_SETTINGS, apiKey: 'sk-x', providerId: 'openai' },
    };
    expect(saveState(state, storage)).toBe(true);
    const loaded = loadState(storage);
    expect(loaded).toEqual(state);
  });
});

describe('export/import backup', () => {
  it('exportBackup produces a JSON string tagged with the app name', () => {
    const state = defaultState();
    const raw = exportBackup(state);
    expect(typeof raw).toBe('string');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.app).toBe('ideaforge');
  });

  it('importBackup(exportBackup(s)) deep-equals the original ideas', () => {
    const state: AppState = {
      ideas: [sampleIdea(), { ...sampleIdea(), id: 'idea_two', tags: [] }],
      settings: { ...DEFAULT_SETTINGS, tone: 'hinglish' },
    };
    const restored = importBackup(exportBackup(state));
    expect(restored.ideas).toEqual(state.ideas);
    expect(restored.settings).toEqual(state.settings);
  });

  it("importBackup('garbage') throws", () => {
    expect(() => importBackup('garbage')).toThrow();
  });
});

describe('sanitize', () => {
  it('fills missing tags with []', () => {
    const storage = new MemoryStorage();
    const { tags: _omitted, ...rest } = sampleIdea();
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ideas: [rest], settings: {} }));
    const state = loadState(storage);
    expect(state.ideas).toHaveLength(1);
    expect(state.ideas[0].tags).toEqual([]);
  });

  it('drops ideas without a string id/title', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, ideas: [{ id: 42 }, sampleIdea()], settings: {} }),
    );
    const state = loadState(storage);
    expect(state.ideas).toHaveLength(1);
    expect(state.ideas[0].id).toBe('idea_abc123');
  });
});
