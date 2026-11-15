"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Params, Translator } from "@/lib/i18n/translate";

/**
 * Translator used by the non-hook helpers in this module (`apiFetch`, `errorMessage`). It is registered by
 * `ToastProvider` (mounted under `I18nProvider` in the root layout) so callers outside React components
 * keep their simple `errorMessage(err)` signature and still get messages in the active locale.
 */
let activeTranslator: Translator | null = null;
export function setApiTranslator(t: Translator | null) {
  activeTranslator = t;
}

/** Catalog entry (key + params) behind a locally generated error message, so it can be re-translated later. */
type MessageSpec = { key: string; params?: Params };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    /** Set when `message` is one of our own fallbacks (not text returned by the server). */
    public spec?: MessageSpec,
  ) {
    super(message);
  }
}

/** Fallback messages (catalog keys) for HTTP statuses when the server sent no `error` text. */
const STATUS_MESSAGE_KEYS: Record<number, string> = {
  401: "shared.api.status.401",
  403: "shared.api.status.403",
  404: "shared.api.status.404",
  409: "shared.api.status.409",
  503: "shared.api.status.503",
};

function localize(spec: MessageSpec, t: Translator | null = activeTranslator): string {
  return t ? t(spec.key, spec.params) : spec.key;
}

function fallbackError(status: number, spec: MessageSpec, details?: unknown): ApiError {
  return new ApiError(status, localize(spec), details, spec);
}

function redirectToLogin() {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/** Same-origin JSON fetch; non-2xx throws ApiError with the API's `error` text. 401 sends the user to /login. */
export async function apiFetch<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...rest,
    headers: { accept: "application/json", ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  const body: unknown = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    const details = body && typeof body === "object" ? (body as { details?: unknown }).details : undefined;
    if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
      throw new ApiError(res.status, (body as { error: string }).error, details);
    }
    const key = STATUS_MESSAGE_KEYS[res.status];
    throw fallbackError(res.status, key ? { key } : { key: "shared.api.requestFailed", params: { status: res.status } }, details);
  }
  return body as T;
}

/** User-facing text for any thrown value. Pass `t` to force a translator; otherwise the registered one is used. */
export function errorMessage(err: unknown, t: Translator | null = activeTranslator): string {
  if (err instanceof ApiError) return err.spec ? localize(err.spec, t) : err.message;
  if (err instanceof TypeError) return localize({ key: "shared.api.network" }, t);
  return err instanceof Error ? err.message : String(err);
}

export type ApiState<T> = {
  data: T | undefined;
  error: unknown;
  /** True only until the first response (keeps showing data during refreshes). */
  loading: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
  mutate: (updater: (prev: T | undefined) => T | undefined) => void;
};

/**
 * Minimal data hook: fetches `url` (null = skip), refetches when `url` or `version` changes, optional polling.
 * Responses from superseded requests are discarded.
 */
export function useApi<T>(
  url: string | null,
  opts: {
    /** Polling interval; a function receives the current data (0 = no polling). */
    pollMs?: number | ((data: T | undefined) => number);
    version?: unknown;
    parse?: "json" | "text";
    /** Called after each successful fetch with the previous and new data (event-style, outside render). */
    onData?: (prev: T | undefined, next: T) => void;
  } = {},
): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!url);
  const [refreshing, setRefreshing] = useState(false);
  const [prevUrl, setPrevUrl] = useState(url);
  const seq = useRef(0);
  const dataRef = useRef<T | undefined>(undefined);
  const onDataRef = useRef(opts.onData);
  useEffect(() => {
    onDataRef.current = opts.onData;
  });

  // New resource: drop stale data so the skeleton shows (state adjustment during render).
  if (prevUrl !== url) {
    setPrevUrl(url);
    setData(undefined);
    setError(null);
    setLoading(!!url);
  }

  const load = useCallback(async () => {
    if (!url) return;
    const id = ++seq.current;
    setRefreshing(true);
    try {
      const result =
        opts.parse === "text"
          ? ((await fetch(url, { credentials: "same-origin", cache: "no-store" }).then(async (r) => {
              if (!r.ok) {
                if (r.status === 401) redirectToLogin();
                const key = STATUS_MESSAGE_KEYS[r.status];
                throw fallbackError(r.status, key ? { key } : { key: "shared.api.httpStatus", params: { status: r.status } });
              }
              return r.text();
            })) as T)
          : await apiFetch<T>(url);
      if (id !== seq.current) return;
      const prev = dataRef.current;
      dataRef.current = result;
      setData(result);
      setError(null);
      onDataRef.current?.(prev, result);
    } catch (err) {
      if (id !== seq.current) return;
      setError(err);
    } finally {
      if (id === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [url, opts.parse]);

  useEffect(() => {
    // Data fetching subscribes to an external system; load() flips `refreshing` before awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (url) void load();
  }, [url, load, opts.version]);

  const pollMs = typeof opts.pollMs === "function" ? opts.pollMs(data) : opts.pollMs;
  useEffect(() => {
    if (!url || !pollMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => clearInterval(t);
  }, [url, pollMs, load]);

  const mutate = useCallback((updater: (prev: T | undefined) => T | undefined) => {
    setData((prev) => {
      const next = updater(prev);
      dataRef.current = next;
      return next;
    });
  }, []);
  return { data, error, loading, refreshing, reload: load, mutate };
}
