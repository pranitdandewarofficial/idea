/**
 * Offline "Smart Analysis" — rule/template-based heuristic validation used when
 * no API key is configured. Genuinely useful: keyword-driven scoring across the
 * same 4 dimensions as AI validation, plus targeted critiques that each ship
 * with a concrete solution framework.
 */

import type { Critique, Score, ValidationResult, Verdict } from './types';

const clamp = (n: number) => Math.min(10, Math.max(1, Math.round(n)));

function countMatches(text: string, words: string[]): number {
  let n = 0;
  for (const w of words) {
    if (text.includes(w)) n++;
  }
  return n;
}

interface SignalResult {
  score: number;
  evidence: string[];
  gaps: string[];
}

/* ---------------- market signals ---------------- */
const MARKET_POS = [
  'b2b', 'enterprise', 'saas', 'subscription', 'marketplace', 'platform',
  'businesses', 'companies', 'teams', 'developers', 'creators', 'freelancers',
  'india', 'global', 'us', 'users', 'customers', 'clients', 'merchants', 'sellers',
  'students', 'patients', 'recurring', 'paid', 'premium',
];
const MARKET_VAGUE = ['everyone', 'anyone', 'people', 'world', 'all', 'mass'];

function marketSignals(text: string, title: string): SignalResult {
  const pos = countMatches(text, MARKET_POS);
  const vague = countMatches(text, MARKET_VAGUE);
  const score = clamp(5 + pos * 0.7 - vague * 0.9 + (title.length > 4 ? 0.5 : 0));
  const evidence: string[] = [];
  const gaps: string[] = [];
  if (pos >= 6) evidence.push('Clear target audience and buyer language detected.');
  else if (pos >= 3) evidence.push('Some audience signals present.');
  else gaps.push('No clear target customer named — who exactly pays, and why them?');
  if (vague >= 2) gaps.push('Audience sounds like "everyone" — big markets start narrow.');
  if (!text.includes('pay') && !text.includes('price') && !text.includes('subscription'))
    gaps.push('No mention of willingness to pay or pricing.');
  return { score, evidence, gaps };
}

/* ---------------- moat signals ---------------- */
const MOAT_POS = [
  'network effect', 'proprietary', 'data moat', 'patent', 'exclusive', 'integration',
  'workflow', 'switching cost', 'community', 'brand', 'ai model', 'trained on',
  'partnership', 'license', 'api', 'ecosystem', 'algorithm',
];
const MOAT_WEAK = ['just an app', 'simple app', 'basic', 'clone', 'like uber but', 'like zomato but'];

function moatSignals(text: string): SignalResult {
  const pos = countMatches(text, MOAT_POS);
  const weak = countMatches(text, MOAT_WEAK);
  const score = clamp(4.5 + pos * 1.1 - weak * 1.4);
  const evidence: string[] = [];
  const gaps: string[] = [];
  if (pos >= 2) evidence.push('Defensibility signals found (data, network, integrations).');
  else gaps.push('No clear moat — what stops a funded copycat from rebuilding this in 3 months?');
  if (weak > 0) gaps.push('"X but for Y" framing needs a 10x difference, not a feature.');
  return { score, evidence, gaps };
}

/* ---------------- timing signals ---------------- */
const TIMING_POS = [
  'ai', 'llm', 'gpt', 'automation', '2025', '2026', 'post-covid', 'upi', 'gst',
  'regulation', '5g', 'smartphone', 'remote work', 'creator economy', 'd2c',
  'quick commerce', 'ev', 'fintech', 'edtech', 'healthtech', 'genai',
];
const TIMING_NEG = ['already exists', 'saturated', 'everyone is doing', 'late'];

function timingSignals(text: string): SignalResult {
  const pos = countMatches(text, TIMING_POS);
  const neg = countMatches(text, TIMING_NEG);
  const score = clamp(5 + pos * 0.8 - neg * 1.2);
  const evidence: string[] = [];
  const gaps: string[] = [];
  if (pos >= 2) evidence.push('Rides a current wave — the "why now" is plausible.');
  else gaps.push('No clear "why now" — why is this idea better timed today than 5 years ago?');
  if (neg > 0) gaps.push('You flagged crowded timing yourself — differentiation becomes critical.');
  return { score, evidence, gaps };
}

/* ---------------- monetization signals ---------------- */
const MON_POS = [
  'subscription', 'saas', 'commission', 'fee', 'freemium', 'ads', 'advertising',
  'marketplace fee', 'transaction', 'b2b', 'enterprise', 'licensing', 'per seat',
  'per user', 'margin', 'ltv', 'cac', 'revenue share',
];
const MON_NEG = ['free', 'no revenue', 'later monetize', 'just grow users'];

function monetizationSignals(text: string): SignalResult {
  const pos = countMatches(text, MON_POS);
  const neg = countMatches(text, MON_NEG);
  const score = clamp(4.5 + pos * 1.0 - neg * 1.1);
  const evidence: string[] = [];
  const gaps: string[] = [];
  if (pos >= 2) evidence.push('A revenue model is articulated.');
  else gaps.push('Revenue model is fuzzy — how does money actually enter the bank?');
  if (neg > 0) gaps.push('"Monetize later" is a plan to burn cash — define the first paid unit.');
  return { score, evidence, gaps };
}

/* ---------------- critique bank ---------------- */

interface CritiqueTemplate {
  test: (ctx: AnalysisCtx) => boolean;
  point: string;
  solution: string;
  severity: Critique['severity'];
}

interface AnalysisCtx {
  ideaTitle: string;
  descLen: number;
  scores: Score;
  gaps: string[];
}

function fill(template: string, title: string): string {
  return template.replaceAll('{TITLE}', title);
}

const CRITIQUE_TEMPLATES: CritiqueTemplate[] = [
  {
    test: (c) => c.descLen < 60,
    point:
      'The idea is too thinly described to evaluate — a one-liner hides the hard parts (who pays, for what, why you win).',
    solution:
      'Write the 1-sentence value prop: "We help [specific user] achieve [outcome] by [mechanism], unlike [alternative]." Then expand each bracket into a paragraph. If a bracket stays empty, that is your riskiest assumption — test it first.',
    severity: 'high',
  },
  {
    test: (c) => c.scores.moat <= 5,
    point:
      'No defensible moat is visible. If "{TITLE}" works, a funded team can clone the surface in one quarter.',
    solution:
      'Pick ONE moat to build from day one: (a) proprietary data that compounds with usage, (b) workflow lock-in via integrations users cannot rip out, or (c) a community/network effect. Design your MVP so the moat starts accumulating on user #1.',
    severity: 'high',
  },
  {
    test: (c) => c.scores.market <= 5,
    point:
      'The buyer and their wallet are unclear. "Big market" claims without a named first customer are fantasy.',
    solution:
      'Name 10 real humans or companies who would buy in month one. Cold-message 5 of them this week with a landing page (The Mom Test rules: ask about their problem, never pitch your solution). No interest = market signal, not a marketing problem.',
    severity: 'high',
  },
  {
    test: (c) => c.scores.monetization <= 5,
    point:
      'The path to revenue is hand-wavy. Ideas die not from bad products but from no one paying.',
    solution:
      'Define the first paid unit and its price today (e.g. ₹499/mo per seat). Pre-sell to 3 customers before writing serious code — a deposit, even ₹100, beats 100 survey "yes". If nobody prepays, pivot the offer, not the tech.',
    severity: 'medium',
  },
  {
    test: (c) => c.scores.timing <= 5,
    point:
      'The "why now" is missing. Great ideas at the wrong time are just expensive lessons.',
    solution:
      'Write the 3 tailwinds making this possible NOW (tech shift, behavior shift, regulation shift) and 1 headwind. If you cannot name 2 real tailwinds, the timing is not on your side — shrink scope to a wedge where timing IS favorable.',
    severity: 'medium',
  },
  {
    test: (c) => c.gaps.length >= 5,
    point:
      'Multiple fundamentals are unproven at once (audience, moat, revenue, timing). Stacked unknowns kill startups.',
    solution:
      'Rank your unknowns by "what kills us if wrong". Attack only the #1 unknown this week with the cheapest possible test (interview, fake-door landing page, concierge MVP). One unknown at a time — that is the whole game.',
    severity: 'high',
  },
  {
    test: (c) => c.scores.market >= 7 && c.scores.monetization >= 7,
    point:
      'Even with a real market and revenue path, the first 10 customers will be brutally hard — distribution beats product.',
    solution:
      'Before building, pick ONE acquisition channel you can personally execute (cold outbound, community, content, partnerships). Spend 2 weeks getting 100 conversations through it. Channel validated first, product second.',
    severity: 'low',
  },
];

export interface HeuristicInput {
  title: string;
  description: string;
  tags: string[];
}

/** Run the offline heuristic analysis. Deterministic, no network. */
export function analyzeHeuristic(input: HeuristicInput): ValidationResult {
  const title = input.title.trim() || 'Untitled idea';
  const text = `${input.title} ${input.description} ${input.tags.join(' ')}`.toLowerCase();
  const descLen = input.description.trim().length;

  const market = marketSignals(text, input.title);
  const moat = moatSignals(text);
  const timing = timingSignals(text);
  const monetization = monetizationSignals(text);

  const score: Score = {
    market: market.score,
    moat: moat.score,
    timing: timing.score,
    monetization: monetization.score,
    overall: clamp((market.score + moat.score + timing.score + monetization.score) / 4),
  };

  const allGaps = [...market.gaps, ...moat.gaps, ...timing.gaps, ...monetization.gaps];
  const ctx: AnalysisCtx = { ideaTitle: title, descLen, scores: score, gaps: allGaps };

  const critiques: Critique[] = CRITIQUE_TEMPLATES.filter((t) => t.test(ctx))
    .slice(0, 5)
    .map((t) => ({ point: fill(t.point, title), solution: t.solution, severity: t.severity }));

  // Always have at least 3 critiques
  if (critiques.length < 3) {
    critiques.push({
      point: 'Assumption risk: the idea has not been stress-tested against real users yet.',
      solution:
        'Run 5 problem interviews this week (The Mom Test format). You are done when you can quote 3 users describing the pain in their own words — not agreeing with your pitch.',
      severity: 'medium',
    });
  }
  if (critiques.length < 3) {
    critiques.push({
      point: 'Competitive blind spot: "no competitors" usually means you have not looked hard enough.',
      solution:
        'List 5 direct and indirect competitors, including the "do nothing / spreadsheet / WhatsApp" alternative. For each, write why a customer would switch to you. If you cannot, find the wedge.',
      severity: 'medium',
    });
  }

  const verdict: Verdict = score.overall >= 7 ? 'PURSUE' : score.overall >= 5 ? 'PIVOT' : 'KILL';
  const verdictReason =
    verdict === 'PURSUE'
      ? 'Strong signals across dimensions — validate fast and build the MVP.'
      : verdict === 'PIVOT'
        ? 'Core has promise but key gaps need reshaping before committing.'
        : 'Too many fundamental gaps — kill or radically reframe this idea.';

  const summary =
    `Offline smart analysis of "${title}": ` +
    `overall ${score.overall}/10 ` +
    `(market ${score.market}, moat ${score.moat}, timing ${score.timing}, monetization ${score.monetization}). ` +
    verdictReason;

  return {
    source: 'heuristic',
    summary,
    score,
    critiques,
    verdict,
    verdictReason,
    createdAt: Date.now(),
  };
}
