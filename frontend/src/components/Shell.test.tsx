/**
 * The shell renders the ten real areas and the live connection state, and the
 * approval drawer lists what GET /api/approvals actually returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Shell } from "./Shell";
import { setToken } from "../api/client";
import { useApp } from "../store/app";
import { live } from "../live/stream";
import type { Health, Settings } from "../lib/types";
import healthFixture from "../test/fixtures/health.json";
import settingsFixture from "../test/fixtures/settings.json";

const health = healthFixture as unknown as Health;
const settings = (settingsFixture as unknown as { values: Settings }).values;

function renderShell(route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Shell />
    </MemoryRouter>,
  );
}

describe("<Shell />", () => {
  beforeEach(() => {
    setToken("test-token");
    live.stop();
    useApp.setState({
      ready: true,
      booting: false,
      bootError: null,
      health,
      settings,
      settingsMeta: settingsFixture as never,
      connection: "live",
      connectionDetail: "",
      events: [],
      lastEventId: 0,
      pendingApprovals: 0,
      toasts: [],
    });
  });

  it("offers exactly the ten areas from the brief", () => {
    renderShell("/");
    const nav = screen.getByRole("navigation", { name: "Areas" });
    const labels = [...nav.querySelectorAll("a")].map((link) => link.textContent?.trim());
    expect(labels).toEqual([
      "City", "Command Center", "Agent Directory", "Agent Workspace", "Task Manager",
      "Projects", "AI Providers", "Knowledge Center", "Activity Center", "Settings",
    ]);
  });

  it("reports the real backend version and sandbox tier", () => {
    renderShell("/");
    expect(screen.getByText(`v${health.version} · py ${health.python}`)).toBeTruthy();
    expect(screen.getByText(`sandbox tier ${health.sandbox_tier}`)).toBeTruthy();
  });

  it("shows zero-spend state from the settings the backend returned", () => {
    renderShell("/");
    expect(screen.getByText(settings.zero_spend ? "zero spend on" : "spend allowed")).toBeTruthy();
  });

  it("shows which engine is answering System-1 decisions", () => {
    renderShell("/");
    expect(screen.getByText(new RegExp(`system 1: ${health.decision_engine}`))).toBeTruthy();
  });

  it("marks the active area", () => {
    renderShell("/providers");
    const active = screen.getByRole("navigation", { name: "Areas" })
      .querySelector('a[aria-current="page"]');
    expect(active?.textContent?.trim()).toBe("AI Providers");
  });

  it("opens the approval drawer and lists a pending gate from the API", async () => {
    const approvals = {
      items: [{
        id: "ap-1", plan_id: "p-1", task_id: "t-1", requested_by: "noor", action: "run_shell: git push origin main",
        detail: { command: "git push origin main", reason: "pushing to a remote needs a human" },
        risk: "high", risk_score: 0.82, status: "pending", decided_at: null, decision_note: null,
        created_at: new Date().toISOString(),
      }],
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/approvals/")) {
        return new Response(JSON.stringify({ decided: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(approvals), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderShell("/");
    screen.getByRole("button", { name: /Approvals/ }).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText("run_shell: git push origin main")).toBeTruthy();
    });
    expect(screen.getByText(/requested by noor/)).toBeTruthy();
    expect(screen.getByText(/high · 0.82/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Approval gates" })).toBeTruthy();

    // deciding really posts to the endpoint
    const approve = screen.getByRole("button", { name: /Approve/ });
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const called = fetchMock.mock.calls.some(([url]) => String(url).includes("/api/approvals/ap-1/decision"));
      expect(called).toBe(true);
    });
    vi.unstubAllGlobals();
  });

  it("shows an honest empty drawer when nothing is waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    renderShell("/");
    screen.getByRole("button", { name: /Approvals/ }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(screen.getByText("Nothing waiting")).toBeTruthy();
    });
    vi.unstubAllGlobals();
  });

  it("surfaces a failing approvals request instead of showing an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "unauthorized", message: "A valid access token is required.", context: {}, request_id: "r1" },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    renderShell("/");
    screen.getByRole("button", { name: /Approvals/ }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(screen.getByText("A valid access token is required.")).toBeTruthy();
    });
    vi.unstubAllGlobals();
  });

  it("renders toasts pushed by the live stream", async () => {
    renderShell("/");
    useApp.getState().pushToast({ title: "task.failed", body: "t3 · pytest exited 1", tone: "danger" });
    await waitFor(() => {
      expect(screen.getByText("task.failed")).toBeTruthy();
      expect(screen.getByText("t3 · pytest exited 1")).toBeTruthy();
    });
  });
});
