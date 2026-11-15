// Failure limiter for POST /api/auth (slows down guessing of API_TOKEN).
//
// The counters live behind a small pluggable `FailureStore` interface:
//   - `DatabaseFailureStore` (default): the `LoginThrottle` table, shared by every app instance that uses the same
//     database (SQLite in development, PostgreSQL in production).
//   - `MemoryFailureStore`: per-process counters. Used when LOGIN_RATE_LIMIT_STORE=memory, and as the automatic
//     fallback for a request whose database call fails (logged once), so a database outage never disables limiting.
//   - Anything else (e.g. Redis): implement `FailureStore` and register it with `configureLoginLimiters`.
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db";

const WINDOW_MS = 15 * 60_000;
const MAX_ENTRIES = 5_000;

export interface FailureStore {
  /** Seconds the caller must wait, or 0 when the key may try again. */
  retryAfter(key: string, now?: number): Promise<number>;
  /** Records one failure for `key`. */
  fail(key: string, now?: number): Promise<void>;
  /** Clears the counters of `key` (after a successful login). */
  reset(key: string): Promise<void>;
}

const waitSeconds = (windowStart: number, windowMs: number, now: number) =>
  Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

type Entry = { failures: number; windowStart: number };

/** Synchronous in-memory fixed-window counter (one process). */
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

  retryAfter(key: string, now = Date.now()): number {
    const entry = this.current(key, now);
    if (!entry || entry.failures < this.maxFailures) return 0;
    return waitSeconds(entry.windowStart, this.windowMs, now);
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

export class MemoryFailureStore implements FailureStore {
  private limiter: FailureLimiter;

  constructor(maxFailures: number, windowMs = WINDOW_MS) {
    this.limiter = new FailureLimiter(maxFailures, windowMs);
  }

  async retryAfter(key: string, now = Date.now()) {
    return this.limiter.retryAfter(key, now);
  }

  async fail(key: string, now = Date.now()) {
    this.limiter.fail(key, now);
  }

  async reset(key: string) {
    this.limiter.reset(key);
  }
}

type ThrottleDb = Pick<PrismaClient, "loginThrottle">;

/**
 * Fixed-window counters in the `LoginThrottle` table, shared across instances. Row keys are SHA-256 hashes of
 * `<scope>:<client key>`, so client addresses are not stored in clear text. Increments are conditional UPDATEs and a
 * new window is a plain INSERT (a concurrent duplicate falls back to the increment), so failures arriving at the
 * same time on several instances are all counted.
 */
export class DatabaseFailureStore implements FailureStore {
  constructor(
    private scope: string,
    private maxFailures: number,
    private windowMs = WINDOW_MS,
    private db: ThrottleDb = prisma,
  ) {}

  private id(key: string) {
    return createHash("sha256").update(`${this.scope}:${key}`).digest("hex");
  }

  async retryAfter(key: string, now = Date.now()) {
    const row = await this.db.loginThrottle.findUnique({ where: { key: this.id(key) } });
    if (!row || now - row.windowStart.getTime() >= this.windowMs || row.failures < this.maxFailures) return 0;
    return waitSeconds(row.windowStart.getTime(), this.windowMs, now);
  }

  async fail(key: string, now = Date.now()) {
    const id = this.id(key);
    const windowFloor = new Date(now - this.windowMs);
    const increment = () => this.db.loginThrottle.updateMany({
      where: { key: id, windowStart: { gt: windowFloor } },
      data: { failures: { increment: 1 } },
    });
    if ((await increment()).count) return;
    try {
      await this.db.loginThrottle.create({ data: { key: id, failures: 1, windowStart: new Date(now) } });
      // A new window started: prune expired rows (at most once per key and window).
      await this.db.loginThrottle.deleteMany({ where: { windowStart: { lte: windowFloor } } });
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err; // the row exists: expired, or created concurrently
    }
    const restarted = await this.db.loginThrottle.updateMany({
      where: { key: id, windowStart: { lte: windowFloor } },
      data: { failures: 1, windowStart: new Date(now) },
    });
    if (!restarted.count) await increment();
  }

  async reset(key: string) {
    await this.db.loginThrottle.deleteMany({ where: { key: this.id(key) } });
  }
}

/** Uses `primary`; if a call fails (e.g. the database is unreachable), that call falls back to `fallback`. */
export class FallbackFailureStore implements FailureStore {
  private warned = false;

  constructor(
    private primary: FailureStore,
    private fallback: FailureStore,
  ) {}

  private async run<T>(op: (store: FailureStore) => Promise<T>): Promise<T> {
    try {
      return await op(this.primary);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[rate-limit] shared login limiter unavailable, using per-process counters: ${(err as Error).message.split("\n")[0]}`);
      }
      return op(this.fallback);
    }
  }

  retryAfter(key: string, now = Date.now()) {
    return this.run((s) => s.retryAfter(key, now));
  }

  async fail(key: string, now = Date.now()) {
    // Count in memory too, so a store that fails intermittently still never under-counts locally.
    await this.fallback.fail(key, now);
    await this.run((s) => (s === this.fallback ? Promise.resolve() : s.fail(key, now)));
  }

  async reset(key: string) {
    await this.fallback.reset(key);
    await this.run((s) => (s === this.fallback ? Promise.resolve() : s.reset(key)));
  }
}

/** Store selection: LOGIN_RATE_LIMIT_STORE=memory | database (default). Resolved per call so tests and ops can switch it. */
class ConfiguredStore implements FailureStore {
  private memory: MemoryFailureStore;
  private shared: FallbackFailureStore;
  custom: FailureStore | null = null;

  constructor(scope: string, maxFailures: number) {
    this.memory = new MemoryFailureStore(maxFailures);
    this.shared = new FallbackFailureStore(new DatabaseFailureStore(scope, maxFailures), new MemoryFailureStore(maxFailures));
  }

  private get store(): FailureStore {
    if (this.custom) return this.custom;
    return process.env.LOGIN_RATE_LIMIT_STORE?.trim().toLowerCase() === "memory" ? this.memory : this.shared;
  }

  retryAfter(key: string, now?: number) {
    return this.store.retryAfter(key, now);
  }

  fail(key: string, now?: number) {
    return this.store.fail(key, now);
  }

  reset(key: string) {
    return this.store.reset(key);
  }
}

const perClient = new ConfiguredStore("login:client", 10);
const globalStore = new ConfiguredStore("login:global", 200);

/** 10 wrong tokens per client per 15 minutes; the global cap (200) stops distributed guessing with spoofed client keys. */
export const loginLimiter: FailureStore = perClient;
export const globalLoginLimiter: FailureStore = globalStore;

/**
 * Plugs in another shared store (for example Redis) for the login limiters, or restores the built-in selection
 * with `null`. Call it once at startup, e.g. from `instrumentation.ts`.
 */
export function configureLoginLimiters(stores: { perClient: FailureStore; global: FailureStore } | null) {
  perClient.custom = stores?.perClient ?? null;
  globalStore.custom = stores?.global ?? null;
}

/** Best-effort client key: first `x-forwarded-for` hop, `x-real-ip`, else a shared bucket. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip")?.trim() || "local").slice(0, 64);
}
