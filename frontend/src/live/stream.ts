/**
 * Live connection to the backend event bus.
 *
 * Transport order: WebSocket (/ws) -> Server-Sent Events (/api/events/stream) ->
 * HTTP polling (/api/events?since=).  Each fallback is only used after the
 * previous one actually failed, and the current mode is published so the UI can
 * show the truth instead of a decorative "live" dot.
 */
import { api, getToken, wsUrl } from "../api/client";
import { useApp } from "../store/app";
import type { AppEvent } from "../lib/types";

export type StreamMode = "websocket" | "sse" | "polling" | "idle";

type Listener = (event: AppEvent) => void;

const PING_INTERVAL_MS = 25_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;

class LiveStream {
  private ws: WebSocket | null = null;
  private source: EventSource | null = null;
  private pollTimer: number | null = null;
  private pingTimer: number | null = null;
  private retryTimer: number | null = null;
  private listeners = new Set<Listener>();
  private attempts = 0;
  private stopped = true;
  mode: StreamMode = "idle";

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.teardownSocket();
    this.teardownSource();
    this.mode = "idle";
    useApp.getState().setConnection("offline", "stream stopped");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): void {
    if (this.stopped) return;
    this.teardownSocket();
    this.teardownSource();
    if (this.attempts >= 3) {
      this.connectSse();
      return;
    }
    this.connectWs();
  }

  private connectWs(): void {
    this.mode = "websocket";
    useApp.getState().setConnection(this.attempts === 0 ? "connecting" : "reconnecting", "websocket");
    let socket: WebSocket;
    try {
      const since = useApp.getState().lastEventId;
      socket = new WebSocket(`${wsUrl("/ws")}${since ? `&since=${since}` : ""}`);
    } catch (error) {
      this.scheduleRetry(`websocket constructor failed: ${String(error)}`);
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.attempts = 0;
      useApp.getState().setConnection("live", "websocket");
      this.pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = (message) => {
      try {
        this.dispatch(JSON.parse(String(message.data)) as AppEvent);
      } catch {
        /* a malformed frame must not kill the stream */
      }
    };

    socket.onerror = () => {
      /* onclose follows and carries the retry */
    };

    socket.onclose = (event) => {
      this.clearPing();
      if (this.stopped) return;
      const reason = event.code === 4401 ? "invalid token" : `websocket closed (${event.code})`;
      this.scheduleRetry(reason);
    };
  }

  private connectSse(): void {
    this.mode = "sse";
    useApp.getState().setConnection("reconnecting", "server-sent events");
    const token = getToken();
    const since = useApp.getState().lastEventId;
    const url = `/api/events/stream?since=${since}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch (error) {
      this.scheduleRetry(`eventsource failed: ${String(error)}`);
      return;
    }
    this.source = source;
    source.onopen = () => {
      this.attempts = 0;
      useApp.getState().setConnection("live", "server-sent events");
    };
    source.onmessage = (message) => {
      try {
        this.dispatch(JSON.parse(message.data) as AppEvent);
      } catch {
        /* ignore */
      }
    };
    source.onerror = () => {
      if (this.stopped) return;
      this.teardownSource();
      this.scheduleRetry("server-sent events failed");
    };
  }

  private startPolling(): void {
    this.mode = "polling";
    useApp.getState().setConnection("reconnecting", "polling");
    const tick = async () => {
      if (this.stopped) return;
      try {
        const body = await api.get<{ items: AppEvent[]; last_id: number }>("/api/events", {
          since: useApp.getState().lastEventId,
          limit: 200,
        });
        body.items.forEach((event) => this.dispatch(event));
        useApp.getState().setConnection("live", "polling");
        this.attempts = 0;
      } catch (error) {
        useApp.getState().setConnection("offline", `polling failed: ${String(error)}`);
      }
      if (!this.stopped) this.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
  }

  private scheduleRetry(reason: string): void {
    this.attempts += 1;
    useApp.getState().setConnection("reconnecting", reason);
    if (this.attempts >= 6) {
      this.startPolling();
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempts, 5));
    this.clearTimers();
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private dispatch(event: AppEvent): void {
    if (!event || typeof event.kind !== "string") return;
    if (event.kind === "ws.pong") return;
    useApp.getState().ingestEvents([event]);
    this.listeners.forEach((listener) => listener(event));
  }

  private teardownSocket(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.clearPing();
  }

  private teardownSource(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export const live = new LiveStream();
