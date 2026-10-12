/**
 * Boot: the app must not render a single screen until it has really talked to the
 * backend, and when it cannot, it must say so and show the exact command to fix it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { mockApi, type MockApi } from "./test/fixtures";

// `live` and the store are module singletons, and the store caches its boot
// promise, so every test gets a fresh module registry.
let App: typeof import("./App").default;
let useApp: typeof import("./store/app").useApp;
let live: typeof import("./live/stream").live;
let api: MockApi;

beforeEach(async () => {
  vi.resetModules();
  api = mockApi();
  ({ default: App } = await import("./App"));
  ({ useApp } = await import("./store/app"));
  ({ live } = await import("./live/stream"));
  useApp.setState({ ready: false, booting: false, bootError: null, events: [], lastEventId: 0 });
});

afterEach(() => {
  live.stop();
  api.restore();
  vi.unstubAllGlobals();
});

async function renderApp(route = "/", settle = true) {
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
  if (settle) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return result;
}

describe("boot", () => {
  it("shows the connecting state before it has any data", async () => {
    await renderApp("/", false);
    expect(screen.getByText(/Connecting to the local backend/)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Areas" })).toBeNull();
  });

  it("adopts the local token from /api/setup/status and authenticates every later call", async () => {
    await renderApp("/");
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Areas" })).toBeTruthy();
    });

    const calls = api.calls.map((call) => call.url);
    expect(calls.some((url) => url.includes("/api/setup/status"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/health"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/settings"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/events"))).toBe(true);
  });

  it("renders the shell and the city once the backend answers", async () => {
    await renderApp("/");
    await waitFor(() => {
      expect(useApp.getState().ready).toBe(true);
    });
    expect(screen.getByText("PRANIT AI CITY")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Areas" })).toBeTruthy();
    // the city area really fetched its layout
    expect(api.calls.some((call) => call.url.includes("/api/city"))).toBe(true);
  });

  it("starts the live stream only after the boot succeeded", async () => {
    await renderApp("/");
    await waitFor(() => {
      expect(useApp.getState().ready).toBe(true);
    });
    expect(live.mode).not.toBe("idle");
  });

  it("loads the route it was given, not always the city", async () => {
    await renderApp("/providers");
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Areas" })).toBeTruthy();
    });
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes("/api/providers"))).toBe(true);
    });
  });

  it("sends an unknown route back to the city", async () => {
    await renderApp("/does-not-exist");
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: "Areas" })).toBeTruthy();
    });
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes("/api/city"))).toBe(true);
    });
  });
});

describe("boot failure", () => {
  it("reports the real reason and the exact command to fix it", async () => {
    api.restore();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await renderApp("/");
    await waitFor(() => {
      expect(screen.getByText("The frontend cannot reach the backend")).toBeTruthy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Failed to fetch/)).toBeTruthy();
    expect(screen.getByText(/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000/)).toBeTruthy();
    expect(screen.getByText(/proxies/)).toBeTruthy();
    expect(useApp.getState().ready).toBe(false);
  });

  it("surfaces the backend's own error envelope instead of a generic message", async () => {
    api.restore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "unauthorized", message: "A valid access token is required.", context: {}, request_id: "r-1",
      },
    }), { status: 401, headers: { "content-type": "application/json" } })));

    await renderApp("/");
    await waitFor(() => {
      expect(screen.getByText(/A valid access token is required/)).toBeTruthy();
    });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("recovers when Retry is pressed and the backend is up", async () => {
    api.restore();
    let healthy = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!healthy) throw new TypeError("Failed to fetch");
      const url = String(input);
      if (url.includes("/api/setup/status")) {
        return new Response(JSON.stringify({ api_token: "recovered-token", api_base: "http://127.0.0.1:8000" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/health")) {
        return new Response(JSON.stringify({ ok: true, version: "1.0.0" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await renderApp("/");
    await waitFor(() => {
      expect(screen.getByText("The frontend cannot reach the backend")).toBeTruthy();
    });

    healthy = true;
    // From here the backend answers normally, so let the fixture router serve the
    // real payloads instead of the degenerate stub above.
    api.restore();
    api = mockApi();
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => {
      expect(useApp.getState().ready).toBe(true);
    });
  });

  it("offers a manual token entry for a token that was rotated on disk", async () => {
    api.restore();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("pasted-token");

    await renderApp("/");
    await waitFor(() => {
      expect(screen.getByText("Enter token manually")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Enter token manually"));
    expect(prompt).toHaveBeenCalled();
    prompt.mockRestore();
  });
});
