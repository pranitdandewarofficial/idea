/** Versioned localStorage persistence for IdeaForge. Key: ideaforge:v1 */

import { DEFAULT_SETTINGS, type AISettings, type AppState, type Idea } from './types';

export const STORAGE_KEY = 'ideaforge:v1';
const CURRENT_VERSION = 1;

interface StoredEnvelope {
  version: number;
  ideas: Idea[];
  settings: AISettings;
}

export function defaultState(): AppState {
  return { ideas: [], settings: { ...DEFAULT_SETTINGS } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Load state from localStorage; migrates older versions; falls back to defaults. */
export function loadState(storage: Pick<Storage, 'getItem'> = localStorage): AppState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return defaultState();
    const version = typeof parsed.version === 'number' ? parsed.version : 0;
    if (version > CURRENT_VERSION) return defaultState(); // from the future; don't corrupt
    const ideas = Array.isArray(parsed.ideas) ? (parsed.ideas as Idea[]) : [];
    const settings = isObject(parsed.settings)
      ? { ...DEFAULT_SETTINGS, ...(parsed.settings as Partial<AISettings>) }
      : { ...DEFAULT_SETTINGS };
    return { ideas: sanitizeIdeas(ideas), settings };
  } catch {
    return defaultState();
  }
}

/** Persist state to localStorage. Returns false if it failed (e.g. quota). */
export function saveState(
  state: AppState,
  storage: Pick<Storage, 'setItem'> = localStorage,
): boolean {
  try {
    const envelope: StoredEnvelope = {
      version: CURRENT_VERSION,
      ideas: state.ideas,
      settings: state.settings,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

function sanitizeIdeas(ideas: Idea[]): Idea[] {
  return ideas
    .filter((i) => isObject(i) && typeof i.id === 'string' && typeof i.title === 'string')
    .map((i) => ({
      ...i,
      tags: Array.isArray(i.tags) ? i.tags : [],
      starred: !!i.starred,
      stage: i.stage ?? 'captured',
      createdAt: typeof i.createdAt === 'number' ? i.createdAt : Date.now(),
      updatedAt: typeof i.updatedAt === 'number' ? i.updatedAt : Date.now(),
    }));
}

/** Export the full state as a pretty JSON string (backup file). */
export function exportBackup(state: AppState): string {
  return JSON.stringify({ app: 'ideaforge', version: CURRENT_VERSION, ...state }, null, 2);
}

/** Import a backup string; throws on invalid content. */
export function importBackup(raw: string): AppState {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('Not a valid IdeaForge backup.');
  const ideas = Array.isArray(parsed.ideas) ? (parsed.ideas as Idea[]) : [];
  const settings = isObject(parsed.settings)
    ? { ...DEFAULT_SETTINGS, ...(parsed.settings as Partial<AISettings>) }
    : { ...DEFAULT_SETTINGS };
  return { ideas: sanitizeIdeas(ideas), settings };
}

/** Rough size estimate of the persisted payload in bytes. */
export function estimateStorageBytes(state: AppState): number {
  return new Blob([JSON.stringify(state)]).size;
}
