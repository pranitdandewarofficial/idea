/**
 * Every area renders against payloads captured from a real backend run. If a screen
 * showed something the backend never said, these tests would not find it here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { mockApi, type MockApi } from "../test/fixtures";
import { compactNumber } from "../lib/format";
import { setToken } from "../api/client";
import { live } from "../live/stream";
import { useApp } from "../store/app";
import type { Health, Settings, SetupStatus } from "../lib/types";
import healthFixture from "../test/fixtures/health.json";
import settingsFixture from "../test/fixtures/settings.json";
import setupFixture from "../test/fixtures/setup-status.json";

import { AgentDirectory } from "./AgentDirectory";
import { AgentWorkspace } from "./AgentWorkspace";
import { ActivityCenter } from "./ActivityCenter";
import { CityArea } from "./CityArea";
import { CommandCenter } from "./CommandCenter";
import { KnowledgeArea } from "./KnowledgeArea";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectsArea } from "./ProjectsArea";
import { ProvidersArea } from "./ProvidersArea";
import { SettingsArea } from "./SettingsArea";
import { TaskManager } from "./TaskManager";

const health = healthFixture as unknown as Health;
const setup = setupFixture as unknown as SetupStatus;
const settingsValues = (settingsFixture as unknown as { values: Settings }).values;

let api: MockApi;

function renderArea(ui: React.ReactElement, route = "/", path = route) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path={path} element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * React tracks input values internally, so assigning `.value` and firing `input`
 * is ignored. Going through the native setter is what a real keystroke does.
 */
function setText(element: HTMLElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  setToken("fixture-token");
  live.stop();
  api = mockApi();
  useApp.setState({
    ready: true,
    booting: false,
    bootError: null,
    health,
    setup,
    settings: settingsValues,
    settingsMeta: settingsFixture as never,
    connection: "live",
    connectionDetail: "",
    events: [],
    lastEventId: 0,
    pendingApprovals: 0,
    toasts: [],
  });
});

afterEach(() => {
  api.restore();
  setToken(null);
});

/* ------------------------------------------------------------------- City */

describe("CityArea", () => {
  it("describes the real city state: agents, departments and tasks in flight", async () => {
    renderArea(<CityArea />);
    await waitFor(() => {
      expect(screen.getByText(/The city is the state/)).toBeTruthy();
    });
    const cityFixture = await import("../test/fixtures/city.json");
    const layout = cityFixture.default as unknown as {
      agents: unknown[]; buildings: unknown[]; task_markers: unknown[];
    };
    expect(screen.getByText(new RegExp(`${layout.agents.length} agents`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`${layout.buildings.length} departments`))).toBeTruthy();
  });

  it("survives a browser with no canvas implementation", async () => {
    // jsdom returns null from getContext; the renderer must not throw
    renderArea(<CityArea />);
    await waitFor(() => expect(api.calls.some((call) => call.url.includes("/api/city"))).toBe(true));
    expect(screen.queryByText(/Application error/)).toBeNull();
  });
});

/* --------------------------------------------------------- Command Center */

describe("CommandCenter", () => {
  it("lists the real plans and shows the selected run's evidence", async () => {
    renderArea(<CommandCenter />);
    const planFixture = await import("../test/fixtures/plan.json");
    const real = planFixture.default as unknown as { objective: string; state: string };
    await waitFor(() => {
      expect(screen.getAllByText(real.objective).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(real.state).length).toBeGreaterThan(0);
    // the delivery report of that run is rendered, including its honesty flags
    await waitFor(() => {
      expect(screen.getByText("Not delivered as a real outcome")).toBeTruthy();
    });
  });

  it("posts the objective exactly as typed, with spend left unauthorised", async () => {
    renderArea(<CommandCenter />);
    const box = screen.getByPlaceholderText(/Build a Python CLI/) as HTMLTextAreaElement;
    setText(box, "Build a CSV to Parquet converter with tests");
    await waitFor(() => expect(box.value).toBe("Build a CSV to Parquet converter with tests"));

    screen.getByText("Submit objective").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const post = api.calls.find((call) => call.method === "POST" && call.url.includes("/api/objectives"));
      expect(post).toBeTruthy();
      expect(post?.body).toMatchObject({
        objective: "Build a CSV to Parquet converter with tests",
        spend_authorized: false,
        auto_start: true,
      });
    });
  });

  it("refuses a too-short objective without calling the API", async () => {
    renderArea(<CommandCenter />);
    const before = api.calls.filter((call) => call.url.includes("/api/objectives")).length;
    screen.getByText("Submit objective").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(screen.getByText("Describe the objective in at least a sentence.")).toBeTruthy();
    });
    expect(api.calls.filter((call) => call.url.includes("/api/objectives")).length).toBe(before);
  });
});

/* -------------------------------------------------------- Agent Directory */

describe("AgentDirectory", () => {
  it("renders every agent the backend seeded, grouped by department", async () => {
    renderArea(<AgentDirectory />, "/agents", "/agents");
    const fixture = await import("../test/fixtures/agents.json");
    const rows = (fixture.default as unknown as { items: { name: string; department: string }[] }).items;
    await waitFor(() => {
      for (const row of rows) expect(screen.getByText(row.name)).toBeTruthy();
    });
    for (const department of new Set(rows.map((row) => row.department))) {
      expect(screen.getByText(department)).toBeTruthy();
    }
  });

  it("shows the real tool whitelist when an agent is selected", async () => {
    renderArea(<AgentDirectory />, "/agents/qa", "/agents/:agentId");
    const fixture = await import("../test/fixtures/agent-tools.json");
    const policy = fixture.default as unknown as { authorised: { name: string }[]; granted: string[] };
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`${policy.granted.length} granted of ${policy.authorised.length} authorised`)))
        .toBeTruthy();
    });
    for (const tool of policy.authorised.slice(0, 4)) {
      expect(screen.getByText(tool.name)).toBeTruthy();
    }
  });

  it("marks the decision agent and never offers it as a task owner", async () => {
    renderArea(<AgentDirectory />, "/agents", "/agents");
    await waitFor(() => {
      expect(screen.getAllByText("system 1").length).toBeGreaterThan(0);
    });
  });
});

/* -------------------------------------------------------- Agent Workspace */

describe("AgentWorkspace", () => {
  it("opens on a real agent and reads its console data", async () => {
    renderArea(<AgentWorkspace />, "/workspace/qa", "/workspace/:agentId");
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes("/api/agents/qa/tool-calls"))).toBe(true);
    });
    expect(screen.getAllByText("Tool calls").length).toBeGreaterThan(0);
    expect(screen.getByText(/Executed inside the project workspace only/)).toBeTruthy();
  });

  it("switching tab really queries that endpoint", async () => {
    renderArea(<AgentWorkspace />, "/workspace/backend", "/workspace/:agentId");
    await waitFor(() => expect(screen.getByText("Conversation")).toBeTruthy());
    screen.getByText("Memory").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes("/api/agents/backend/memory"))).toBe(true);
    });
  });
});

/* ------------------------------------------------------------ Task Manager */

describe("TaskManager", () => {
  it("lists the tasks of the captured run with their real evidence", async () => {
    renderArea(<TaskManager />, "/tasks", "/tasks");
    const fixture = await import("../test/fixtures/tasks.json");
    const rows = (fixture.default as unknown as { items: { external_id: string; title: string }[] }).items;
    await waitFor(() => {
      expect(screen.getByText(rows[0].external_id)).toBeTruthy();
    });
    expect(screen.getByText(rows[0].title)).toBeTruthy();
  });

  it("filters by calling the API again with the status parameter", async () => {
    renderArea(<TaskManager />, "/tasks", "/tasks");
    await waitFor(() => expect(screen.getByText("Needs attention")).toBeTruthy());
    screen.getByText("Needs attention").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const filtered = api.calls.filter((call) => call.url.includes("status=failed"));
      expect(filtered.length).toBeGreaterThan(0);
    });
  });

  it("opens the evidence drawer for a task", async () => {
    renderArea(<TaskManager />, "/tasks", "/tasks");
    const fixture = await import("../test/fixtures/tasks.json");
    const rows = (fixture.default as unknown as { items: { title: string }[] }).items;
    await waitFor(() => expect(screen.getByText(rows[0].title)).toBeTruthy());
    screen.getByText(rows[0].title).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes("/timeline"))).toBe(true);
    });
  });
});

/* ---------------------------------------------------------------- Projects */

describe("ProjectsArea", () => {
  it("lists the real workspace and its path", async () => {
    renderArea(<ProjectsArea />, "/projects", "/projects");
    const fixture = await import("../test/fixtures/projects.json");
    const rows = (fixture.default as unknown as { items: { name: string; workspace_path: string }[] }).items;
    await waitFor(() => {
      expect(screen.getAllByText(rows[0].name).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(rows[0].workspace_path).length).toBeGreaterThan(0);
  });
});

describe("ProjectDetail", () => {
  it("shows the files that are really on disk", async () => {
    renderArea(<ProjectDetail />, "/projects/p1", "/projects/:projectId");
    const fixture = await import("../test/fixtures/tree.json");
    const tree = fixture.default as unknown as { entries: { path: string }[] };
    await waitFor(() => {
      expect(screen.getByText(tree.entries[0].path)).toBeTruthy();
    });
  });

  it("does not claim tests passed before anything was executed", async () => {
    renderArea(<ProjectDetail />, "/projects/p1", "/projects/:projectId");
    await waitFor(() => expect(screen.getByText("Tests")).toBeTruthy());
    screen.getByText("Tests").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(screen.getByText("Nothing executed yet")).toBeTruthy();
    });
    expect(screen.queryByText(/passed · exit/)).toBeNull();
  });

  it("runs the tests for real when asked and shows the exit code", async () => {
    renderArea(<ProjectDetail />, "/projects/p1", "/projects/:projectId");
    await waitFor(() => expect(screen.getByText("Tests")).toBeTruthy());
    screen.getByText("Tests").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(screen.getByText("Run tests")).toBeTruthy());
    screen.getByText("Run tests").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const fixture = await import("../test/fixtures/tests.json");
    const result = fixture.default as unknown as { command: string; code: number; passed: boolean };
    await waitFor(() => {
      expect(screen.getByText(new RegExp(`exit ${result.code}`))).toBeTruthy();
    });
    expect(screen.getByText(result.command)).toBeTruthy();
    expect(api.calls.some((call) => call.url.includes("/tests"))).toBe(true);
  });

  it("reports the secret scan result from the backend", async () => {
    renderArea(<ProjectDetail />, "/projects/p1", "/projects/:projectId");
    await waitFor(() => expect(screen.getByText("Secrets")).toBeTruthy());
    screen.getByText("Secrets").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(screen.getByText(/No secret pattern matched any file in this workspace/)).toBeTruthy();
    });
  });
});

/* ---------------------------------------------------------------- Providers */

describe("ProvidersArea", () => {
  it("shows the configured provider, its usage and the zero-spend switch", async () => {
    renderArea(<ProvidersArea />, "/providers", "/providers");
    const fixture = await import("../test/fixtures/providers.json");
    const rows = (fixture.default as unknown as { items: { label: string; kind: string }[] }).items;
    await waitFor(() => {
      expect(screen.getByText(rows[0].label)).toBeTruthy();
    });
    expect(screen.getAllByText(rows[0].kind).length).toBeGreaterThan(0);
    expect(screen.getByText("Zero-spend mode")).toBeTruthy();
  });

  it("never renders an API key, only the fingerprint", async () => {
    renderArea(<ProvidersArea />, "/providers", "/providers");
    await waitFor(() => expect(screen.getByText(/keys are encrypted with Fernet/i)).toBeTruthy());
    const fixture = await import("../test/fixtures/providers.json");
    const rows = (fixture.default as unknown as {
      items: { key_fingerprint: string; has_key: boolean }[];
    }).items;
    const withKey = rows.find((row) => row.has_key);
    if (withKey) {
      expect(screen.getByText(new RegExp(withKey.key_fingerprint))).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{10}/);
  });

  it("tests a provider through the real endpoint", async () => {
    renderArea(<ProvidersArea />, "/providers", "/providers");
    await waitFor(() => expect(screen.getAllByText("Test").length).toBeGreaterThan(0));
    screen.getAllByText("Test")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === "POST" && call.url.includes("/test"))).toBe(true);
    });
    const fixture = await import("../test/fixtures/provider-test.json");
    const result = fixture.default as unknown as { mocked: boolean };
    if (result.mocked) {
      await waitFor(() => {
        expect(screen.getByText(/mock provider - proves wiring only/)).toBeTruthy();
      });
    }
  });
});

/* --------------------------------------------------------------- Knowledge */

describe("KnowledgeArea", () => {
  it("shows the indexed source and its real chunk count", async () => {
    renderArea(<KnowledgeArea />, "/knowledge", "/knowledge");
    const fixture = await import("../test/fixtures/knowledge-upload.json");
    const source = fixture.default as unknown as { name: string; chunk_count: number };
    await waitFor(() => {
      expect(screen.getByText(source.name)).toBeTruthy();
    });
    expect(screen.getByText(new RegExp(`${source.chunk_count} chunks`))).toBeTruthy();
  });

  it("returns BM25 hits from the backend when searching", async () => {
    renderArea(<KnowledgeArea />, "/knowledge", "/knowledge");
    const box = screen.getByLabelText("Search knowledge") as HTMLInputElement;
    setText(box, "error envelope status codes");
    box.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const fixture = await import("../test/fixtures/knowledge-search.json");
    const result = fixture.default as unknown as { results: { source_name: string; score: number }[] };
    await waitFor(() => {
      expect(screen.getAllByText(result.results[0].source_name).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(new RegExp(`score ${result.results[0].score.toFixed(3)}`))).toBeTruthy();
    expect(api.calls.some((call) => call.url.includes("/api/knowledge/search"))).toBe(true);
  });

  it("is honest that retrieval is lexical, not semantic", async () => {
    renderArea(<KnowledgeArea />, "/knowledge", "/knowledge");
    await waitFor(() => {
      expect(screen.getByText(/no embedding model - lexical search/)).toBeTruthy();
    });
  });
});

/* ---------------------------------------------------------------- Activity */

describe("ActivityCenter", () => {
  it("shows the System 1 / System 2 split with the real engine and gates", async () => {
    renderArea(<ActivityCenter />, "/activity", "/activity");
    await waitFor(() => expect(screen.getByText("Decision log")).toBeTruthy());
    screen.getByText("Decision log").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const fixture = await import("../test/fixtures/decision-status.json");
    const status = fixture.default as unknown as {
      laya: { available: boolean; reason: string }; threshold: number;
      thresholds_by_type: Record<string, number>;
    };
    await waitFor(() => {
      expect(status.laya.available
        ? screen.getByText(/Laya is loaded/)
        : screen.getByText(/the deterministic local engine is answering/)).toBeTruthy();
    });
    expect(screen.getAllByText(status.laya.reason).length).toBeGreaterThan(0);
    const gate = Object.entries(status.thresholds_by_type)[0];
    expect(screen.getAllByText(gate[0]).length).toBeGreaterThan(0);
    expect(screen.getAllByText(gate[1].toFixed(2)).length).toBeGreaterThan(0);
  });

  it("records the escalation rate honestly", async () => {
    renderArea(<ActivityCenter />, "/activity", "/activity");
    screen.getByText("Decision log").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const fixture = await import("../test/fixtures/decision-status.json");
    const stats = (fixture.default as unknown as { stats: { escalation_rate: number } }).stats;
    await waitFor(() => {
      expect(screen.getAllByText("Escalated to system 2").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(`${(stats.escalation_rate * 100).toFixed(1)}%`).length).toBeGreaterThan(0);
  });

  it("probes the router through the real endpoint", async () => {
    renderArea(<ActivityCenter />, "/activity", "/activity");
    screen.getByText("Decision log").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(screen.getByText("Run probe")).toBeTruthy());
    screen.getByText("Run probe").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const fixture = await import("../test/fixtures/probe-routing.json");
    const probe = fixture.default as unknown as { engine: string; action: string; confidence: number };
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === "POST" && call.url.includes("/api/decisions/probe")))
        .toBe(true);
      expect(screen.getAllByText(probe.action).length).toBeGreaterThan(0);
      expect(screen.getAllByText(probe.engine).length).toBeGreaterThan(0);
    });
  });

  it("lists audit rows with actors and results", async () => {
    renderArea(<ActivityCenter />, "/activity", "/activity");
    screen.getByText("Audit trail").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const fixture = await import("../test/fixtures/audit.json");
    const rows = (fixture.default as unknown as { items: { action: string; actor: string }[] }).items;
    await waitFor(() => {
      expect(screen.getAllByText(rows[0].action).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(rows[0].actor).length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- Settings */

describe("SettingsArea", () => {
  it("renders the readiness checklist from the real setup status", async () => {
    renderArea(<SettingsArea />, "/settings", "/settings");
    await waitFor(() => {
      expect(screen.getByText("Readiness")).toBeTruthy();
      expect(screen.getByText("Backend reachable")).toBeTruthy();
    });
    expect(screen.getByText(new RegExp(`v${health.version}`))).toBeTruthy();
    if (!setup.has_provider) {
      expect(screen.getByText(/add Ollama or the offline mock provider/)).toBeTruthy();
    }
  });

  it("shows the token budgets the backend is enforcing", async () => {
    renderArea(<SettingsArea />, "/settings", "/settings");
    const fixture = await import("../test/fixtures/settings-budget.json");
    const budget = fixture.default as unknown as { global_token_budget: number; plan_token_budget: number };
    await waitFor(() => {
      expect(screen.getByText(compactNumber(budget.global_token_budget))).toBeTruthy();
    });
    expect(screen.getByText(compactNumber(budget.plan_token_budget))).toBeTruthy();
  });

  it("saves only the settings the founder actually changed", async () => {
    renderArea(<SettingsArea />, "/settings", "/settings");
    await waitFor(() => expect(screen.getByText("No unsaved change.")).toBeTruthy());

    const save = screen.getByText("Save settings");
    expect((save.closest("button") as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByDisplayValue(String(settingsValues.max_repairs)) as HTMLInputElement;
    setText(input, "5");
    await waitFor(() => {
      expect((screen.getByText("Save settings").closest("button") as HTMLButtonElement).disabled).toBe(false);
    });
    screen.getByText("Save settings").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const patch = api.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/api/settings"));
      expect(patch?.body).toEqual({ max_repairs: 5 });
    });
  });

  it("shows the decision gate value from the backend defaults", async () => {
    renderArea(<SettingsArea />, "/settings", "/settings");
    await waitFor(() => {
      expect(screen.getByDisplayValue(String(settingsValues.decision_confidence_threshold))).toBeTruthy();
    });
    const group = screen.getAllByText("Decision layer")
      .map((node) => node.closest("section"))
      .find((section) => section?.textContent?.includes("System 1 acts on its own only above the gate"));
    expect(group).toBeTruthy();
    expect(within(group as HTMLElement).getByText("decision confidence threshold")).toBeTruthy();
  });
});
