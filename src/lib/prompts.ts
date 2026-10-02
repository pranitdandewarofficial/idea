/** Prompt builders for AI validation + roadmap generation. */

import type { Idea, Tone } from './types';

const TONE_INSTRUCTION: Record<Tone, string> = {
  professional:
    'Tone: crisp, professional, direct. No fluff, no motivational filler. ' +
    'First-principles reasoning. Be brutally honest — a bad idea killed fast is a win.',
  hinglish:
    'Tone: Hinglish (Hindi in Roman script mixed with English), bhai-style direct. ' +
    'Seedhi baat, no sugar-coating, thoda desi founder energy. ' +
    'First-principles soch. Ek kharab idea ko jaldi kill karna hi jeet hai.',
};

export const VALIDATION_SCHEMA = `{
  "summary": "2-3 sentence verdict-style summary of the idea",
  "scores": { "market": 1-10, "moat": 1-10, "timing": 1-10, "monetization": 1-10 },
  "critiques": [
    { "point": "brutal, specific critique", "solution": "concrete, actionable solution to fix it", "severity": "low|medium|high" }
  ],
  "verdict": "PURSUE | PIVOT | KILL",
  "verdict_reason": "one sharp sentence explaining the verdict"
}`;

export function buildValidationPrompt(idea: Idea, tone: Tone): { system: string; user: string } {
  const system =
    'You are IdeaForge, a ruthless-but-fair startup idea evaluator. ' +
    TONE_INSTRUCTION[tone] +
    ' You always reply with a single valid JSON object, no markdown fences, no commentary outside the JSON. ' +
    'Score each dimension 1-10 where 1 = terrible, 5 = average, 10 = exceptional. ' +
    'Provide 3 to 5 critiques — and for EVERY critique you MUST give a concrete solution. ' +
    'A critique without a solution is a failure.';

  const user =
    `Evaluate this startup idea and reply ONLY with JSON in exactly this shape:\n` +
    `${VALIDATION_SCHEMA}\n\n` +
    `IDEA TITLE: ${idea.title}\n` +
    `DESCRIPTION: ${idea.description || '(no description provided)'}\n` +
    `TAGS: ${idea.tags.length ? idea.tags.join(', ') : '(none)'}\n\n` +
    `Rules for scoring: market = reachable market size and willingness to pay; ` +
    `moat = defensibility against copycats; timing = why now, why not 5 years ago or later; ` +
    `monetization = clarity and realism of the revenue model. ` +
    `Verdict logic: overall 7.5+ with no high-severity unsolved critique = PURSUE; ` +
    `fixable core with major changes = PIVOT; weak market, weak moat, or no viable monetization = KILL.`;

  return { system, user };
}

export const ROADMAP_SCHEMA = `{
  "stages": [
    {
      "stage": "Idea | Validation | MVP | PMF | GTM | Revenue | Scale",
      "objective": "one-line objective for this stage",
      "checklist": ["concrete, checkable action 1", "action 2", "..."],
      "milestone": "the measurable exit gate of this stage",
      "kill_criteria": "when to kill or pivot the idea at this stage"
    }
  ]
}`;

export function buildRoadmapPrompt(idea: Idea, tone: Tone): { system: string; user: string } {
  const system =
    'You are IdeaForge, a startup execution strategist. ' +
    TONE_INSTRUCTION[tone] +
    ' You reply with a single valid JSON object, no markdown fences, no commentary. ' +
    'Design a 7-stage execution roadmap tailored to the specific idea, not generic advice. ' +
    'Every checklist item must be concrete and checkable. Every stage needs a measurable milestone ' +
    'and explicit kill/pivot criteria — when the founder should stop, not just how to continue.';

  const user =
    `Build the idea-to-billion-dollar execution roadmap for this idea. ` +
    `Reply ONLY with JSON in exactly this shape:\n${ROADMAP_SCHEMA}\n\n` +
    `IDEA TITLE: ${idea.title}\n` +
    `DESCRIPTION: ${idea.description || '(no description provided)'}\n` +
    `TAGS: ${idea.tags.length ? idea.tags.join(', ') : '(none)'}\n\n` +
    `The 7 stages in order: Idea, Validation, MVP, PMF, GTM, Revenue, Scale. ` +
    `Validation = problem interviews + demand tests before building. ` +
    `MVP = smallest thing that proves the core value. PMF = retention + organic pull. ` +
    `GTM = repeatable acquisition channel. Revenue = pricing power + unit economics. ` +
    `Scale = moat, team, systems for 10x. Make it specific to THIS idea.`;

  return { system, user };
}
