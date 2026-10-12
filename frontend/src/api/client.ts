/**
 * The single HTTP client. Every call goes to a relative URL so the browser never
 * needs to know where the backend lives (the Vite proxy forwards /api and /ws).
 *
 * The access token is fetched from the local backend at boot and kept in memory
 * only - it is never written to localStorage, sessionStorage or a cookie.
 */

let token: string | null = null;

export function setToken(value: string | null): void {
  token = value && value.trim() ? value.trim() : null;
}

export function getToken(): string | null {
  return token;
}

export class ApiError extends Error {
  code: string;
  status: number;
  context: Record<string, unknown>;
  requestId: string;

  constructor(status: number, code: string, message: string, context: Record<string, unknown>, requestId: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.context = context ?? {};
    this.requestId = requestId ?? "";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

function withQuery(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(withQuery(path, options.query), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : options.form,
    signal: options.signal,
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string; context?: Record<string, unknown>; request_id?: string } })?.error;
    throw new ApiError(
      response.status,
      envelope?.code ?? `http_${response.status}`,
      envelope?.message ?? (typeof payload === "string" ? payload : response.statusText),
      envelope?.context ?? {},
      envelope?.request_id ?? response.headers.get("x-request-id") ?? "",
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"], signal?: AbortSignal) =>
    request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions["query"]) =>
    request<T>(path, { method: "POST", body, query }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  del: <T>(path: string, query?: RequestOptions["query"]) =>
    request<T>(path, { method: "DELETE", query }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", form }),
};

/**
 * Boot sequence: read the local setup status (the only unauthenticated endpoint
 * that returns the token) and adopt it. Returns the status so the UI can show
 * the real first-run state.
 */
export async function bootstrap(): Promise<{ token: string | null; apiBase: string }> {
  const status = await request<{ api_token: string | null; api_base: string }>("/api/setup/status");
  setToken(status.api_token);
  return { token: status.api_token, apiBase: status.api_base };
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function wsUrl(path = "/ws"): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${window.location.host}${path}${qs}`;
}
