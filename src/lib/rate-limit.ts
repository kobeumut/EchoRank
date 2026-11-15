// Tiny in-memory failure limiter (per process; behind several instances each keeps its own counters).
// Used to slow down guessing of API_TOKEN on POST /api/auth.

const WINDOW_MS = 15 * 60_000;
const MAX_ENTRIES = 5_000;

type Entry = { failures: number; windowStart: number };

export class FailureLimiter {
  private entries = new Map<string, Entry>();

  constructor(
    private maxFailures: number,
    private windowMs = WINDOW_MS,
  ) {}

  private current(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && now - entry.windowStart >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Seconds the caller must wait, or 0 when the key may try again. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.current(key, now);
    if (!entry || entry.failures < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000));
  }

  fail(key: string, now = Date.now()): void {
    if (this.entries.size >= MAX_ENTRIES) {
      for (const [k, e] of this.entries) if (now - e.windowStart >= this.windowMs) this.entries.delete(k);
      if (this.entries.size >= MAX_ENTRIES) this.entries.clear(); // bound memory against key spraying
    }
    const entry = this.current(key, now);
    if (entry) entry.failures += 1;
    else this.entries.set(key, { failures: 1, windowStart: now });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}

/** 10 wrong tokens per client per 15 minutes; the global cap stops distributed guessing with spoofed client keys. */
export const loginLimiter = new FailureLimiter(10);
export const globalLoginLimiter = new FailureLimiter(200);

/** Best-effort client key: first `x-forwarded-for` hop, `x-real-ip`, else a shared bucket. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip")?.trim() || "local").slice(0, 64);
}
