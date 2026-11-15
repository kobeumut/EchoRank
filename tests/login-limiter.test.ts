import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  configureLoginLimiters, DatabaseFailureStore, FallbackFailureStore, type FailureStore, globalLoginLimiter, loginLimiter, MemoryFailureStore,
} from "@/lib/rate-limit";

const WINDOW = 60_000;
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

beforeEach(async () => {
  await prisma.loginThrottle.deleteMany();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  configureLoginLimiters(null);
});

describe("DatabaseFailureStore (shared across instances)", () => {
  it("two app instances share one counter", async () => {
    // Two separate store objects stand in for two processes behind a load balancer: both see the same rows.
    const a = new DatabaseFailureStore("test", 3, WINDOW);
    const b = new DatabaseFailureStore("test", 3, WINDOW);
    await a.fail("203.0.113.9", T0);
    await b.fail("203.0.113.9", T0 + 1_000);
    expect(await a.retryAfter("203.0.113.9", T0 + 2_000)).toBe(0);
    await a.fail("203.0.113.9", T0 + 2_000);
    expect(await b.retryAfter("203.0.113.9", T0 + 3_000)).toBe(57); // locked out on the other instance too
    expect(await b.retryAfter("198.51.100.1", T0 + 3_000)).toBe(0);
    await b.reset("203.0.113.9");
    expect(await a.retryAfter("203.0.113.9", T0 + 3_000)).toBe(0);
  });

  it("counts concurrent failures, opens a new window after expiry and prunes old rows", async () => {
    const store = new DatabaseFailureStore("test", 5, WINDOW);
    await Promise.all(Array.from({ length: 5 }, () => store.fail("burst", T0)));
    expect(await store.retryAfter("burst", T0)).toBeGreaterThan(0);
    expect(await store.retryAfter("burst", T0 + WINDOW)).toBe(0); // window over
    await store.fail("other", T0 + WINDOW + 1);
    const rows = await prisma.loginThrottle.findMany();
    expect(rows).toHaveLength(1); // the expired "burst" row was pruned when the new window started
    expect(rows[0]).toMatchObject({ failures: 1 });
  });

  it("stores hashed keys, not client addresses", async () => {
    await new DatabaseFailureStore("scope", 3, WINDOW).fail("192.0.2.44", T0);
    const [row] = await prisma.loginThrottle.findMany();
    expect(row.key).toBe(createHash("sha256").update("scope:192.0.2.44").digest("hex"));
    expect(JSON.stringify(row)).not.toContain("192.0.2.44");
  });
});

describe("fallback and configuration", () => {
  const broken: FailureStore = {
    retryAfter: async () => { throw new Error("database is down"); },
    fail: async () => { throw new Error("database is down"); },
    reset: async () => { throw new Error("database is down"); },
  };

  it("falls back to per-process counters when the shared store fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new FallbackFailureStore(broken, new MemoryFailureStore(2, WINDOW));
    await store.fail("ip", T0);
    await store.fail("ip", T0);
    expect(await store.retryAfter("ip", T0 + 1_000)).toBe(59);
    await store.reset("ip");
    expect(await store.retryAfter("ip", T0 + 1_000)).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1); // logged once, not per request
  });

  it("the default login limiters persist to the database; LOGIN_RATE_LIMIT_STORE=memory keeps them in-process", async () => {
    await loginLimiter.fail("client-a");
    await globalLoginLimiter.fail("*");
    expect(await prisma.loginThrottle.count()).toBe(2);

    vi.stubEnv("LOGIN_RATE_LIMIT_STORE", "memory");
    await loginLimiter.fail("client-b");
    expect(await prisma.loginThrottle.count()).toBe(2);
    await loginLimiter.reset("client-b");
  });

  it("accepts a custom store (e.g. Redis) via configureLoginLimiters", async () => {
    const calls: string[] = [];
    const custom: FailureStore = {
      retryAfter: async (key) => (calls.push(`retry:${key}`), 0),
      fail: async (key) => void calls.push(`fail:${key}`),
      reset: async (key) => void calls.push(`reset:${key}`),
    };
    configureLoginLimiters({ perClient: custom, global: custom });
    await loginLimiter.fail("x");
    await globalLoginLimiter.retryAfter("*");
    expect(calls).toEqual(["fail:x", "retry:*"]);
    expect(await prisma.loginThrottle.count()).toBe(0);
  });
});
