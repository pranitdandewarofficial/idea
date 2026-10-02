import { describe, it, expect } from 'vitest';
import { detectDomain, generateRoadmap, roadmapProgress } from './roadmap';
import { newIdea, type Roadmap } from './types';

const STAGE_ORDER = ['Idea', 'Validation', 'MVP', 'PMF', 'GTM', 'Revenue', 'Scale'];

describe('generateRoadmap', () => {
  it('produces 7 stages in order with objective, checklist, milestone, killCriteria', () => {
    const roadmap = generateRoadmap(newIdea('Solar CRM', 'CRM for solar installers', ['saas']));
    expect(roadmap.source).toBe('template');
    expect(roadmap.stages).toHaveLength(7);
    expect(roadmap.stages.map((s) => s.stage)).toEqual(STAGE_ORDER);
    roadmap.stages.forEach((stage, si) => {
      expect(stage.objective.trim().length).toBeGreaterThan(0);
      expect(stage.checklist.length).toBeGreaterThanOrEqual(4);
      stage.checklist.forEach((item, i) => {
        expect(item.id).toBe(`s${si}_c${i}`); // stable ids
        expect(item.text.trim().length).toBeGreaterThan(0);
      });
      expect(stage.milestone.trim().length).toBeGreaterThan(0);
      expect(stage.killCriteria.trim().length).toBeGreaterThan(0);
    });
  });
});

describe('detectDomain', () => {
  it('detects fintech from payment language', () => {
    const idea = newIdea('PayBox', 'A UPI payment wallet for small merchants', []);
    expect(detectDomain(idea)).toBe('fintech');
  });

  it('detects devtools from developer language', () => {
    const idea = newIdea('ShipCLI', 'A CLI for developers to deploy code faster', ['devtool']);
    expect(detectDomain(idea)).toBe('devtools');
  });

  it('falls back to startup for random text', () => {
    const idea = newIdea('Mystery box', 'Something vague and undescribed', []);
    expect(detectDomain(idea)).toBe('startup');
  });
});

describe('roadmapProgress', () => {
  it('returns 0 when there is no roadmap', () => {
    expect(roadmapProgress(undefined)).toBe(0);
  });

  it('returns 50 when half the checklist is done', () => {
    const roadmap: Roadmap = {
      stages: [
        {
          stage: 'Idea',
          objective: 'o',
          milestone: 'm',
          killCriteria: 'k',
          checklist: [
            { id: 's0_c0', text: 'a', done: true },
            { id: 's0_c1', text: 'b', done: true },
            { id: 's0_c2', text: 'c', done: false },
            { id: 's0_c3', text: 'd', done: false },
          ],
        },
      ],
      generatedAt: Date.now(),
      source: 'template',
    };
    expect(roadmapProgress(roadmap)).toBe(50);
  });

  it('returns 100 when everything is done', () => {
    const roadmap = generateRoadmap(newIdea('X', 'Y', []));
    for (const s of roadmap.stages) for (const c of s.checklist) c.done = true;
    expect(roadmapProgress(roadmap)).toBe(100);
  });

  it('returns 0 for a fresh generated roadmap', () => {
    expect(roadmapProgress(generateRoadmap(newIdea('X', 'Y', [])))).toBe(0);
  });
});
