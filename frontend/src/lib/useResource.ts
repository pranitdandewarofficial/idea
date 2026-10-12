/**
 * Data loading for the screens. There is no mock data anywhere: a panel shows
 * what the backend returned, an error, or an honest empty state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../api/client";
import { live } from "../live/stream";
import type { AppEvent } from "../lib/types";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reloading: boolean;
  reload: () => void;
}

interface Options {
  /** Event kind prefixes that should trigger a refetch, e.g. ["task.", "plan."]. */
  refreshOn?: string[];
  /** Milliseconds to coalesce bursts of events into one refetch. */
  debounce?: number;
  deps?: unknown[];
  enabled?: boolean;
}

export function useResource<T>(loader: () => Promise<T>, options: Options = {}): Resource<T> {
  const { refreshOn = [], debounce = 300, deps = [], enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [reloading, setReloading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(nonce === 0);
    setReloading(nonce > 0);
    loaderRef
      .current()
      .then((result) => {
        if (cancelled || !mounted.current) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled || !mounted.current) return;
        setError(describeError(cause));
      })
      .finally(() => {
        if (cancelled || !mounted.current) return;
        setLoading(false);
        setReloading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, enabled, ...deps]);

  useEffect(() => {
    if (!enabled || refreshOn.length === 0) return;
    let timer: number | null = null;
    const matches = (event: AppEvent) => refreshOn.some((prefix) => event.kind.startsWith(prefix));
    const unsubscribe = live.subscribe((event) => {
      if (!matches(event)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setNonce((n) => n + 1), debounce);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshOn.join("|"), debounce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reloading, reload };
}

/** Polls on an interval while the tab is visible; used for slow-moving facts. */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (delayMs === null) return;
    const id = window.setInterval(() => {
      if (!document.hidden) saved.current();
    }, delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}
