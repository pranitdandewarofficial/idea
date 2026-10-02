/** Core domain types for IdeaForge. */

export type StageId =
  | 'captured'
  | 'validating'
  | 'mvp'
  | 'pmf'
  | 'gtm'
  | 'scaling';

export const STAGES: { id: StageId; label: string; blurb: string }[] = [
  { id: 'captured', label: 'Captured', blurb: 'Raw ideas, not yet validated' },
  { id: 'validating', label: 'Validating', blurb: 'Running validation on the idea' },
  { id: 'mvp', label: 'MVP', blurb: 'Building the minimum viable product' },
  { id: 'pmf', label: 'PMF', blurb: 'Hunting product-market fit' },
  { id: 'gtm', label: 'GTM', blurb: 'Go-to-market and growth' },
  { id: 'scaling', label: 'Scaling', blurb: 'Revenue and scale engine' },
];

export interface Score {
  market: number; // 1-10
  moat: number; // 1-10
  timing: number; // 1-10
  monetization: number; // 1-10
  overall: number; // 1-10
}

export type Severity = 'low' | 'medium' | 'high';

export interface Critique {
  point: string;
  solution: string;
  severity: Severity;
}

export type Verdict = 'PURSUE' | 'PIVOT' | 'KILL';

export interface ValidationResult {
  source: 'ai' | 'heuristic';
  summary: string;
  score: Score;
  critiques: Critique[];
  verdict: Verdict;
  verdictReason: string;
  createdAt: number;
  model?: string;
  tone?: Tone;
}

export interface RoadmapChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface RoadmapStage {
  stage: string;
  objective: string;
  checklist: RoadmapChecklistItem[];
  milestone: string;
  killCriteria: string;
}

export interface Roadmap {
  stages: RoadmapStage[];
  generatedAt: number;
  source: 'template' | 'ai';
}

export interface VoiceNote {
  mime: string;
  dataUrl: string;
  durationSec: number;
}

export interface Idea {
  id: string;
  title: string;
  description: string;
  tags: string[];
  starred: boolean;
  stage: StageId;
  createdAt: number;
  updatedAt: number;
  voiceNote?: VoiceNote;
  validation?: ValidationResult;
  roadmap?: Roadmap;
}

export type Tone = 'professional' | 'hinglish';

export interface AISettings {
  providerId: string;
  customBaseUrl: string;
  apiKey: string;
  model: string;
  tone: Tone;
}

export interface AppState {
  ideas: Idea[];
  settings: AISettings;
}

export function newIdea(title: string, description: string, tags: string[]): Idea {
  const now = Date.now();
  return {
    id: `idea_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim(),
    description: description.trim(),
    tags: tags.map((t) => t.trim()).filter(Boolean),
    starred: false,
    stage: 'captured',
    createdAt: now,
    updatedAt: now,
  };
}

export const DEFAULT_SETTINGS: AISettings = {
  providerId: 'gemini',
  customBaseUrl: '',
  apiKey: '',
  model: '',
  tone: 'professional',
};
