/**
 * Fixture-driven API mocking for the area tests.
 *
 * Every JSON file in `src/test/fixtures/` was captured from a real run of the
 * backend (see backend/tests/test_06_e2e_run.py and the README in that folder),
 * so a screen test asserts against genuine payloads rather than invented ones.
 */
import { vi } from "vitest";

import agents from "./fixtures/agents.json";
import agentDetail from "./fixtures/agent-detail.json";
import agentMemory from "./fixtures/agent-memory.json";
import agentTools from "./fixtures/agent-tools.json";
import approvals from "./fixtures/approvals.json";
import audit from "./fixtures/audit.json";
import auditActors from "./fixtures/audit-actors.json";
import calibration from "./fixtures/calibration.json";
import city from "./fixtures/city.json";
import decisions from "./fixtures/decisions.json";
import decisionStatus from "./fixtures/decision-status.json";
import decisionTypes from "./fixtures/decision-types.json";
import deliveryReport from "./fixtures/delivery-report.json";
import diff from "./fixtures/diff.json";
import eventKinds from "./fixtures/event-kinds.json";
import events from "./fixtures/events.json";
import fileResponse from "./fixtures/file.json";
import gitLog from "./fixtures/git-log.json";
import health from "./fixtures/health.json";
import knowledgeReindex from "./fixtures/knowledge-reindex.json";
import knowledgeSearch from "./fixtures/knowledge-search.json";
import knowledgeStats from "./fixtures/knowledge-stats.json";
import knowledgeUpload from "./fixtures/knowledge-upload.json";
import objectives from "./fixtures/objectives.json";
import plan from "./fixtures/plan.json";
import planBudget from "./fixtures/plan-budget.json";
import planCheckpoints from "./fixtures/plan-checkpoints.json";
import planDag from "./fixtures/plan-dag.json";
import plans from "./fixtures/plans.json";
import planTimeline from "./fixtures/plan-timeline.json";
import previewStatus from "./fixtures/preview-status.json";
import project from "./fixtures/project.json";
import projects from "./fixtures/projects.json";
import probeGuardrail from "./fixtures/probe-guardrail.json";
import probeRouting from "./fixtures/probe-routing.json";
import providerDetail from "./fixtures/provider-detail.json";
import providerKinds from "./fixtures/provider-kinds.json";
import providerTest from "./fixtures/provider-test.json";
import providerUsage from "./fixtures/provider-usage.json";
import providers from "./fixtures/providers.json";
import agentTasks from "./fixtures/agent-tasks.json";
import agentToolCalls from "./fixtures/agent-tool-calls.json";
import agentMessages from "./fixtures/agent-messages.json";
import agentToolsLaya from "./fixtures/agent-tools-laya.json";
import runs from "./fixtures/runs.json";
import secretsScan from "./fixtures/secrets-scan.json";
import settings from "./fixtures/settings.json";
import settingsBudget from "./fixtures/settings-budget.json";
import setupStatus from "./fixtures/setup-status.json";
import taskDetail from "./fixtures/task-detail.json";
import tasks from "./fixtures/tasks.json";
import taskTimeline from "./fixtures/task-timeline.json";
import tests from "./fixtures/tests.json";
import tree from "./fixtures/tree.json";

export interface Route {
  method?: string;
  pattern: RegExp;
  body: unknown;
  status?: number;
}

/** Longest-match-first routing table, keyed on the pathname (query ignored). */
export const ROUTES: Route[] = [
  { pattern: /^\/api\/health$/, body: health },
  { pattern: /^\/api\/setup\/status$/, body: setupStatus },
  { pattern: /^\/api\/settings\/budget$/, body: settingsBudget },
  { pattern: /^\/api\/settings$/, body: settings },
  { pattern: /^\/api\/agents$/, body: agents },
  { pattern: /^\/api\/agents\/laya\/tools$/, body: agentToolsLaya },
  { pattern: /^\/api\/agents\/[^/]+\/tools$/, body: agentTools },
  { pattern: /^\/api\/agents\/[^/]+\/tasks$/, body: agentTasks },
  { pattern: /^\/api\/agents\/[^/]+\/tool-calls$/, body: agentToolCalls },
  { pattern: /^\/api\/agents\/[^/]+\/messages$/, body: agentMessages },
  { pattern: /^\/api\/agents\/[^/]+\/memory$/, body: agentMemory },
  { pattern: /^\/api\/agents\/[^/]+$/, body: agentDetail },
  { pattern: /^\/api\/tasks$/, body: tasks },
  { pattern: /^\/api\/tasks\/[^/]+\/timeline$/, body: taskTimeline },
  { pattern: /^\/api\/tasks\/[^/]+$/, body: taskDetail },
  { pattern: /^\/api\/plans$/, body: plans },
  { pattern: /^\/api\/plans\/[^/]+\/dag$/, body: planDag },
  { pattern: /^\/api\/plans\/[^/]+\/budget$/, body: planBudget },
  { pattern: /^\/api\/plans\/[^/]+\/checkpoints$/, body: planCheckpoints },
  { pattern: /^\/api\/plans\/[^/]+\/timeline$/, body: planTimeline },
  { pattern: /^\/api\/plans\/[^/]+\/report$/, body: deliveryReport },
  { pattern: /^\/api\/plans\/[^/]+$/, body: plan },
  { pattern: /^\/api\/objectives$/, body: objectives },
  { pattern: /^\/api\/projects$/, body: projects },
  { pattern: /^\/api\/projects\/[^/]+\/tree$/, body: tree },
  { pattern: /^\/api\/projects\/[^/]+\/file$/, body: fileResponse },
  { pattern: /^\/api\/projects\/[^/]+\/diff$/, body: diff },
  { pattern: /^\/api\/projects\/[^/]+\/git\/log$/, body: gitLog },
  { pattern: /^\/api\/projects\/[^/]+\/tests$/, body: tests },
  { pattern: /^\/api\/projects\/[^/]+\/preview$/, body: previewStatus },
  { pattern: /^\/api\/projects\/[^/]+\/secrets-scan$/, body: secretsScan },
  { pattern: /^\/api\/projects\/[^/]+$/, body: project },
  { pattern: /^\/api\/providers\/kinds$/, body: providerKinds },
  { pattern: /^\/api\/providers\/usage\/global$/, body: (settings as { usage: unknown }).usage },
  { pattern: /^\/api\/providers$/, body: providers },
  { pattern: /^\/api\/providers\/[^/]+\/test$/, method: "POST", body: providerTest },
  { pattern: /^\/api\/providers\/[^/]+\/models$/, body: { items: [], source: "live", count: 0 } },
  { pattern: /^\/api\/providers\/[^/]+\/usage$/, body: providerUsage },
  { pattern: /^\/api\/providers\/[^/]+$/, body: providerDetail },
  { pattern: /^\/api\/knowledge\/search$/, body: knowledgeSearch },
  { pattern: /^\/api\/knowledge\/stats$/, body: knowledgeStats },
  { pattern: /^\/api\/knowledge\/upload$/, method: "POST", body: knowledgeUpload },
  { pattern: /^\/api\/knowledge\/[^/]+\/reindex$/, method: "POST", body: knowledgeReindex },
  { pattern: /^\/api\/knowledge$/, body: { items: [knowledgeUpload], count: 1 } },
  { pattern: /^\/api\/decisions\/status$/, body: decisionStatus },
  { pattern: /^\/api\/decisions\/types$/, body: decisionTypes },
  { pattern: /^\/api\/decisions\/calibration$/, body: calibration },
  { pattern: /^\/api\/decisions\/probe$/, method: "POST", body: probeRouting },
  { pattern: /^\/api\/decisions$/, body: decisions },
  { pattern: /^\/api\/events\/kinds$/, body: eventKinds },
  { pattern: /^\/api\/events\/export$/, body: events },
  { pattern: /^\/api\/events$/, body: events },
  { pattern: /^\/api\/audit\/actors$/, body: auditActors },
  { pattern: /^\/api\/audit$/, body: audit },
  { pattern: /^\/api\/approvals$/, body: approvals },
  { pattern: /^\/api\/runs$/, body: runs },
  { pattern: /^\/api\/city$/, body: city },
];

export interface MockCall {
  url: string;
  method: string;
  body: unknown;
}

export interface MockApi {
  calls: MockCall[];
  restore: () => void;
  /** Override one route for a single test (e.g. to make a call fail). */
  override: (pattern: RegExp, body: unknown, status?: number) => void;
}

/**
 * Stubs `fetch` with the captured fixtures. Anything not in the table answers with
 * the real 404 envelope, so a screen cannot silently render invented data.
 */
export function mockApi(extra: Route[] = []): MockApi {
  const routes = [...extra, ...ROUTES];
  const calls: MockCall[] = [];
  const overrides: Route[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0];
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* FormData or plain text */
      }
    }
    calls.push({ url, method, body });

    const route = [...overrides, ...routes].find(
      (candidate) => candidate.pattern.test(path) && (!candidate.method || candidate.method === method),
    );
    if (!route) {
      return new Response(JSON.stringify({
        error: {
          code: "not_found", message: `No fixture for ${method} ${path}`, context: {}, request_id: "fixture",
        },
      }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    calls,
    override: (pattern, responseBody, status) => overrides.push({ pattern, body: responseBody, status }),
    restore: () => vi.unstubAllGlobals(),
  };
}

export {
  agentDetail, agentMemory, agentTasks, agentTools, agentToolCalls, agentToolsLaya, agents, approvals,
  audit, calibration, city, decisions, decisionStatus, decisionTypes, deliveryReport, events, health,
  knowledgeSearch, knowledgeStats, knowledgeUpload, plan, plans, probeGuardrail, probeRouting, project,
  projects, providerDetail, providerKinds, providerTest, secretsScan, settings, settingsBudget,
  setupStatus, tasks, tests, tree,
};
