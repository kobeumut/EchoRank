"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  401: "Oturum gerekli. Lütfen tekrar giriş yapın.",
  403: "Bu işlem için yetkiniz yok.",
  404: "Kayıt bulunamadı.",
  409: "Çakışma: işlem şu anda yapılamıyor.",
  503: "Servis yapılandırılmamış veya geçici olarak kullanılamıyor.",
};

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
    const msg =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : STATUS_MESSAGES[res.status] ?? `İstek başarısız (HTTP ${res.status})`;
    throw new ApiError(res.status, msg, body && typeof body === "object" ? (body as { details?: unknown }).details : undefined);
  }
  return body as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return "Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.";
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
                throw new ApiError(r.status, STATUS_MESSAGES[r.status] ?? `HTTP ${r.status}`);
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
