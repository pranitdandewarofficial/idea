/** Billion-dollar roadmap: built-in stage templates + progress math. */

import type { Idea, Roadmap, RoadmapStage } from './types';

interface StageTemplate {
  stage: string;
  objective: string;
  checklist: string[];
  milestone: string;
  killCriteria: string;
}

const STAGE_TEMPLATES: StageTemplate[] = [
  {
    stage: 'Idea',
    objective: 'Sharpen the idea into a falsifiable thesis about a painful problem.',
    checklist: [
      'Write the 1-sentence value prop: who, what outcome, by what mechanism',
      'Name the 3 riskiest assumptions (kill-ordered)',
      'List 5 competitors including the "do nothing" alternative',
      'Define the ideal first 10 customers by name',
      'Write the "why now" — 2 tailwinds making this possible today',
    ],
    milestone: 'A one-page thesis any smart stranger can understand and attack.',
    killCriteria:
      'Kill if you cannot name 10 specific first customers or 2 real tailwinds after 3 days of research.',
  },
  {
    stage: 'Validation',
    objective: 'Prove the problem is real and painful before writing serious code.',
    checklist: [
      'Run 10 problem interviews (Mom Test: ask about their life, not your idea)',
      'Build a fake-door landing page describing the offer + pricing',
      'Drive 200 targeted visitors to the page',
      'Get 20 email signups or 3 pre-payments',
      'Document the top 3 objections verbatim',
    ],
    milestone: '20 signups or 3 pre-payments from strangers, not friends.',
    killCriteria:
      'Kill if <5% of targeted visitors convert or nobody will prepay even a token amount after 2 weeks.',
  },
  {
    stage: 'MVP',
    objective: 'Ship the smallest thing that delivers the core value and proves it works.',
    checklist: [
      'Cut scope to ONE core job-to-be-done',
      'Ship a concierge or no-code version first if possible',
      'Onboard 10 real users manually (do things that do not scale)',
      'Instrument the single key action (activation event)',
      'Fix onboarding until 5 of 10 users complete the core action unaided',
    ],
    milestone: '10 users completing the core action without hand-holding.',
    killCriteria:
      'Kill if after 6 weeks of iteration nobody uses it twice unprompted.',
  },
  {
    stage: 'PMF',
    objective: 'Find the repeatable loop where users pull the product out of you.',
    checklist: [
      'Measure week-4 retention for your first 50 users',
      'Run the Sean Ellis test: would 40%+ be "very disappointed" without it?',
      'Identify your power users and interview 10 of them',
      'Double down on the single use case with the best retention',
      'Kill features nobody uses; simplify relentlessly',
    ],
    milestone: '40%+ "very disappointed" score and a visible retention curve flattening.',
    killCriteria:
      'Kill/pivot if retention decays to ~0 by week 4 after 3 months of real effort.',
  },
  {
    stage: 'GTM',
    objective: 'Find one repeatable, scalable acquisition channel.',
    checklist: [
      'Test 3 channels for 2 weeks each with fixed budgets',
      'Measure CAC and payback period per channel honestly',
      'Pick ONE winner and go deep — ignore the rest',
      'Build the channel playbook (who does what, weekly cadence)',
      'Reach 100 paying customers through the winning channel',
    ],
    milestone: '100 paying customers with known CAC and a repeatable playbook.',
    killCriteria:
      'Kill if CAC payback exceeds 12 months on every channel and the product cannot be sold cheaper to serve.',
  },
  {
    stage: 'Revenue',
    objective: 'Turn growth into a healthy economic engine with pricing power.',
    checklist: [
      'Raise prices 20% on new customers and measure conversion impact',
      'Get gross margins above 70% (or a credible path there)',
      'Reach positive unit economics: LTV > 3x CAC',
      'Add one expansion revenue lever (upsell, seats, usage)',
      'Build a 13-week cash runway forecast and update it weekly',
    ],
    milestone: 'LTV:CAC above 3:1 and a clear path to profitability.',
    killCriteria:
      'Kill if unit economics stay negative after pricing, packaging, and cost experiments.',
  },
  {
    stage: 'Scale',
    objective: 'Build the moat, team, and systems that compound for 10x.',
    checklist: [
      'Identify the compounding moat (data, network, workflow lock-in) and feed it',
      'Hire for the 2 roles that unblock growth, not for headcount',
      'Document the operating cadence (weekly metrics review, quarterly planning)',
      'Open the second growth lever (new segment, geography, or product line)',
      'Set the billion-dollar frame: what must be true to 10x from here?',
    ],
    milestone: 'A second growth lever working and a team that runs without the founder in every loop.',
    killCriteria:
      'Kill the scaling push (not the company) if growth stalls 2 quarters straight — go back to PMF work.',
  },
];

/** Rough domain detection from title/description/tags for template personalization. */
export function detectDomain(idea: Pick<Idea, 'title' | 'description' | 'tags'>): string {
  const text = `${idea.title} ${idea.description} ${idea.tags.join(' ')}`.toLowerCase();
  const domains: [string, string[]][] = [
    ['AI', ['ai', 'llm', 'gpt', 'machine learning', 'chatbot', 'genai']],
    ['fintech', ['fintech', 'payment', 'upi', 'lending', 'bank', 'wallet', 'invest']],
    ['edtech', ['edtech', 'learn', 'course', 'student', 'tutor', 'exam', 'school']],
    ['healthtech', ['health', 'fitness', 'doctor', 'patient', 'medical', 'wellness']],
    ['devtools', ['developer', 'devtool', 'api', 'sdk', 'code', 'deploy', 'cli']],
    ['consumer social', ['social', 'community', 'creator', 'content', 'video', 'reels']],
    ['e-commerce', ['ecommerce', 'e-commerce', 'd2c', 'marketplace', 'seller', 'shop']],
    ['SaaS', ['saas', 'b2b', 'enterprise', 'workflow', 'productivity', 'crm']],
  ];
  for (const [domain, keywords] of domains) {
    if (keywords.some((k) => text.includes(k))) return domain;
  }
  return 'startup';
}

/**
 * Generate the 7-stage roadmap, lightly personalized with the idea's title/domain.
 * Deterministic (template source). IDs are stable per stage+index.
 */
export function generateRoadmap(idea: Pick<Idea, 'title' | 'description' | 'tags'>): Roadmap {
  const title = idea.title.trim() || 'your idea';
  const domain = detectDomain(idea);
  const stages: RoadmapStage[] = STAGE_TEMPLATES.map((t, si) => ({
    stage: t.stage,
    objective: `${t.objective} (applied to "${title}", a ${domain} play)`,
    checklist: t.checklist.map((text, i) => ({
      id: `s${si}_c${i}`,
      text,
      done: false,
    })),
    milestone: t.milestone,
    killCriteria: t.killCriteria,
  }));
  return { stages, generatedAt: Date.now(), source: 'template' };
}

/** Overall roadmap progress 0-100 from checklist completion. */
export function roadmapProgress(roadmap: Roadmap | undefined): number {
  if (!roadmap) return 0;
  let total = 0;
  let done = 0;
  for (const s of roadmap.stages) {
    for (const c of s.checklist) {
      total++;
      if (c.done) done++;
    }
  }
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** Progress for a single stage 0-100. */
export function stageProgress(stage: RoadmapStage): number {
  const total = stage.checklist.length;
  if (total === 0) return 0;
  const done = stage.checklist.filter((c) => c.done).length;
  return Math.round((done / total) * 100);
}
