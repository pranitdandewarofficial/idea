/**
 * The live stream must be honest about how it is connected: WebSocket first, then
 * Server-Sent Events, then polling - and each fallback only after the previous
 * transport really failed. The header renders `live.mode`, so these transitions
 * are user-visible facts, not implementation detail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../api/client";
import { live } from "./stream";
import { useApp } from "../store/app";
import type { AppEvent } from "../lib/types";

/* --------------------------------------------------------- fake transports */

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /* test helpers */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(event: AppEvent | { type: string } | string) {
    this.onmessage?.({ data: typeof event === "string" ? event : JSON.stringify(event) });
  }

  fail(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.({ code });
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  emit(event: AppEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  fail() {
    this.onerror?.();
  }
}

const lastSocket = () => FakeWebSocket.instances.at(-1);
const lastSource = () => FakeEventSource.instances.at(-1);

function event(id: number, kind: string, extra: Partial<AppEvent> = {}): AppEvent {
  return { id, kind, payload: { task_id: `t-${id}` }, priority: "normal", notify: false, ts: null, ...extra };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  FakeEventSource.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  setToken("stream-token");
  useApp.setState({ events: [], lastEventId: 0, connection: "connecting", connectionDetail: "", toasts: [] });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], count: 0, last_id: 0 }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  live.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------- tests */

describe("websocket transport", () => {
  it("connects first, with the token and the last seen event id", () => {
    useApp.setState({ lastEventId: 42 });
    live.start();
    expect(live.mode).toBe("websocket");
    const socket = lastSocket();
    expect(socket).toBeTruthy();
    expect(socket?.url).toContain("/ws?token=stream-token");
    expect(socket?.url).toContain("since=42");
    expect(useApp.getState().connection).toBe("connecting");
  });

  it("reports live only once the socket is actually open", () => {
    live.start();
    expect(useApp.getState().connection).toBe("connecting");
    lastSocket()?.open();
    expect(useApp.getState().connection).toBe("live");
    expect(useApp.getState().connectionDetail).toBe("websocket");
  });

  it("delivers events to subscribers and into the store", () => {
    const seen: AppEvent[] = [];
    const unsubscribe = live.subscribe((item) => seen.push(item));
    live.start();
    lastSocket()?.open();
    lastSocket()?.emit(event(1, "task.started"));
    lastSocket()?.emit(event(2, "tool.result"));

    expect(seen.map((item) => item.kind)).toEqual(["task.started", "tool.result"]);
    const state = useApp.getState();
    expect(state.events.map((item) => item.id)).toEqual([1, 2]);
    expect(state.lastEventId).toBe(2);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const seen: AppEvent[] = [];
    const unsubscribe = live.subscribe((item) => seen.push(item));
    live.start();
    lastSocket()?.open();
    lastSocket()?.emit(event(1, "task.started"));
    unsubscribe();
    lastSocket()?.emit(event(2, "task.failed"));
    expect(seen).toHaveLength(1);
  });

  it("ignores protocol frames and malformed JSON without dropping the stream", () => {
    const seen: AppEvent[] = [];
    live.subscribe((item) => seen.push(item));
    live.start();
    const socket = lastSocket();
    socket?.open();
    socket?.emit({ type: "ws.pong" });
    socket?.emit("{not json at all");
    socket?.emit(event(7, "plan.started"));

    expect(seen.map((item) => item.kind)).toEqual(["plan.started"]);
    expect(useApp.getState().connection).toBe("live");
  });

  it("keeps the socket alive with a ping", () => {
    live.start();
    const socket = lastSocket();
    socket?.open();
    vi.advanceTimersByTime(25_000);
    expect(socket?.sent).toContain(JSON.stringify({ type: "ping" }));
  });

  it("reconnects after a close and says it is reconnecting", () => {
    live.start();
    lastSocket()?.open();
    lastSocket()?.fail(1006);

    expect(useApp.getState().connection).toBe("reconnecting");
    expect(useApp.getState().connectionDetail).toContain("websocket closed (1006)");

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    lastSocket()?.open();
    expect(useApp.getState().connection).toBe("live");
  });

  it("reports an invalid token distinctly", () => {
    live.start();
    lastSocket()?.fail(4401);
    expect(useApp.getState().connectionDetail).toContain("invalid token");
  });
});

describe("fallback to server-sent events", () => {
  it("switches transport only after the websocket really failed three times", () => {
    live.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(live.mode).toBe("websocket");
      lastSocket()?.fail();
      vi.advanceTimersByTime(10_000);
    }
    expect(live.mode).toBe("sse");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(lastSource()?.url).toContain("/api/events/stream?since=");
    expect(lastSource()?.url).toContain("token=stream-token");
    expect(useApp.getState().connection).toBe("reconnecting");
  });

  it("delivers events over SSE and reports the transport", () => {
    live.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastSocket()?.fail();
      vi.advanceTimersByTime(10_000);
    }
    lastSource()?.open();
    expect(useApp.getState().connection).toBe("live");
    expect(useApp.getState().connectionDetail).toBe("server-sent events");

    const seen: AppEvent[] = [];
    live.subscribe((item) => seen.push(item));
    lastSource()?.emit(event(11, "approval.requested", { priority: "high", notify: true }));
    expect(seen.map((item) => item.kind)).toEqual(["approval.requested"]);
    expect(useApp.getState().lastEventId).toBe(11);
  });
});

describe("fallback to polling", () => {
  async function reachPolling() {
    live.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastSocket()?.fail();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(live.mode).toBe("sse");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastSource()?.fail();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(live.mode).toBe("polling");
  }

  it("polls /api/events with the cursor once both push transports failed", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      items: [event(21, "task.completed"), event(22, "plan.finished")], count: 2, last_id: 22,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await reachPolling();
    await vi.advanceTimersByTimeAsync(0);

    const poll = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/events"));
    expect(poll).toBeTruthy();
    expect(useApp.getState().connection).toBe("live");
    expect(useApp.getState().connectionDetail).toBe("polling");
    expect(useApp.getState().events.map((item) => item.id)).toEqual([21, 22]);
  });

  it("keeps polling on an interval and advances the cursor", async () => {
    await reachPolling();
    await vi.advanceTimersByTimeAsync(0);
    const first = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);

    useApp.setState({ lastEventId: 99 });
    await vi.advanceTimersByTimeAsync(5_000);
    const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(lastUrl).toContain("since=99");
  });

  it("reports offline when polling itself fails", async () => {
    await reachPolling();
    fetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useApp.getState().connection).toBe("offline");
    expect(useApp.getState().connectionDetail).toContain("network down");
  });
});

describe("stop", () => {
  it("closes the socket, clears timers and reports idle", () => {
    live.start();
    const socket = lastSocket();
    socket?.open();
    live.stop();

    expect(live.mode).toBe("idle");
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(useApp.getState().connection).toBe("offline");

    // no ping may fire after stop
    const sentBefore = socket?.sent.length ?? 0;
    vi.advanceTimersByTime(60_000);
    expect(socket?.sent.length).toBe(sentBefore);
  });

  it("really stops the polling timer (it used to keep fetching)", async () => {
    live.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastSocket()?.fail();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lastSource()?.fail();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(live.mode).toBe("polling");
    await vi.advanceTimersByTimeAsync(0);

    live.stop();
    const callsAfterStop = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterStop);
  });

  it("is safe to call twice and to start again afterwards", () => {
    live.start();
    live.stop();
    live.stop();
    live.start();
    expect(live.mode).toBe("websocket");
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
  });
});
