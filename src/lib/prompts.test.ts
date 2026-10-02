import { describe, it, expect } from 'vitest';
import { buildRoadmapPrompt, buildValidationPrompt } from './prompts';
import { newIdea } from './types';

const idea = newIdea('Solar CRM', 'A CRM for solar installers in India', ['saas', 'b2b']);

describe('buildValidationPrompt', () => {
  it('includes the idea title, description, and a JSON instruction', () => {
    const { system, user } = buildValidationPrompt(idea, 'professional');
    expect(user).toContain('Solar CRM');
    expect(user).toContain('A CRM for solar installers in India');
    expect(user).toContain('JSON');
    expect(system).toContain('JSON');
  });

  it('differs by tone: the hinglish version mentions Hinglish/Roman', () => {
    const pro = buildValidationPrompt(idea, 'professional');
    const hinglish = buildValidationPrompt(idea, 'hinglish');
    expect(hinglish.system).toContain('Hinglish');
    expect(hinglish.system).toContain('Roman');
    expect(pro.system).not.toContain('Hinglish');
    expect(pro.system).not.toContain('Roman');
  });
});

describe('buildRoadmapPrompt', () => {
  it('includes the title and lists all 7 stage names', () => {
    const { system, user } = buildRoadmapPrompt(idea, 'professional');
    const combined = `${system}\n${user}`;
    expect(combined).toContain('Solar CRM');
    for (const stage of ['Idea', 'Validation', 'MVP', 'PMF', 'GTM', 'Revenue', 'Scale']) {
      expect(user).toContain(stage);
    }
  });
});
