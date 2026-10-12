/**
 * The HTTP client: relative URLs only, the real error envelope, and a token that
 * lives in memory (never localStorage, never a cookie).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, bootstrap, describeError, getToken, request, setToken, wsUrl } from "./client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("token handling", () => {
  afterEach(() => setToken(null));

  it("keeps the token in memory and trims it", () => {
    setToken("  abc123  ");
    expect(getToken()).toBe("abc123");
    expect(window.localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("treats an empty token as no token", () => {
    setToken("   ");
    expect(getToken()).toBeNull();
  });

  it("builds a same-origin ws URL, wss on https", () => {
    setToken("t0ken");
    expect(wsUrl()).toBe(`ws://${window.location.host}/ws?token=t0ken`);
  });
});

describe("request", () => {
  beforeEach(() => setToken("test-token"));
  afterEach(() => {
    setToken(null);
    vi.restoreAllMocks();
  });

  it("sends the bearer header and parses JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, version: "1.0.0" }));
    vi.stubGlobal("fetch", fetchMock);

    const body = await request<{ ok: boolean }>("/api/health");
    expect(body.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/health");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    vi.unstubAllGlobals();
  });

  it("never sends an Authorization header for an anonymous boot call", async () => {
    setToken(null);
    const fetchMock = vi.fn(async () => jsonResponse(200, { api_token: "fresh", api_base: "http://127.0.0.1:8000" }));
    vi.stubGlobal("fetch", fetchMock);
    const status = await bootstrap();
    expect(status.token).toBe("fresh");
    expect(getToken()).toBe("fresh");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("turns the backend error envelope into an ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, {
      error: {
        code: "tool_not_permitted",
        message: "rhea may not use: delete_file.",
        context: { agent_id: "rhea", unknown: ["delete_file"] },
        request_id: "req-42",
      },
    }, { "x-request-id": "req-42" })));

    const error = await api.get("/api/agents/rhea").catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("tool_not_permitted");
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).requestId).toBe("req-42");
    expect((error as ApiError).context).toEqual({ agent_id: "rhea", unknown: ["delete_file"] });
    expect(describeError(error)).toBe("rhea may not use: delete_file.");
    vi.unstubAllGlobals();
  });

  it("survives a non-JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    const error = await request("/api/health").catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("http_502");
    expect(describeError(error)).toContain("502");
    vi.unstubAllGlobals();
  });

  it("omits empty query parameters and stringifies the rest", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/tasks", { status: "", agent: undefined, plan: null, limit: 50, ok: true });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/tasks?limit=50&ok=true");
    vi.unstubAllGlobals();
  });

  it("serialises a JSON body and a FormData body differently", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/objectives", { objective: "build it" });
    let [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ objective: "build it" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const form = new FormData();
    form.append("tags", "api");
    await api.upload("/api/knowledge/upload", form);
    [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("passes query parameters on POST (zero-spend uses one)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { zero_spend: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/settings/zero-spend", undefined, { enabled: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/zero-spend?enabled=true");
    expect(init.method).toBe("POST");
    vi.unstubAllGlobals();
  });
});

describe("describeError", () => {
  it("handles anything thrown", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError({ weird: true })).toBe("[object Object]");
  });
});
