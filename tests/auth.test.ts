import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { hasValidSession, isAuthorized, safeEqual, SESSION_COOKIE, SESSION_MAX_AGE, sessionValue } from "@/lib/auth";
import { globalLoginLimiter, loginLimiter } from "@/lib/rate-limit";
import { DELETE, GET, POST } from "@/app/api/auth/route";
import { proxy } from "@/proxy";

const TOKEN = "s3cret-token";

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { host: "localhost:3000", ...(init.body !== undefined && { "content-type": "application/json" }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

afterEach(() => {
  delete process.env.API_TOKEN;
  delete process.env.SESSION_SECRET;
  loginLimiter.reset("local");
  globalLoginLimiter.reset("*");
});

describe("isAuthorized", () => {
  it("accepts bearer token or session cookie; unsafe cookie requests must be same-origin", async () => {
    const cookie = `${SESSION_COOKIE}=${await sessionValue(TOKEN)}`;
    expect(await isAuthorized(request("/api/sites", { headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN)).toBe(true);
    expect(await isAuthorized(request("/api/sites", { headers: { authorization: "Bearer nope" } }), TOKEN)).toBe(false);
    expect(await isAuthorized(request("/api/sites", { headers: { cookie } }), TOKEN)).toBe(true);
    expect(await isAuthorized(request("/api/sites", { headers: { cookie: `${SESSION_COOKIE}=forged` } }), TOKEN)).toBe(false);
    expect(await isAuthorized(request("/api/sites", { headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` } }), TOKEN)).toBe(false); // malformed percent-encoding
    expect(await isAuthorized(request("/api/sites", { method: "POST", headers: { cookie } }), TOKEN)).toBe(false);
    expect(await isAuthorized(request("/api/sites", { method: "POST", headers: { cookie, origin: "https://evil.example" } }), TOKEN)).toBe(false);
    expect(await isAuthorized(request("/api/sites", { method: "POST", headers: { cookie, origin: "http://localhost:3000" } }), TOKEN)).toBe(true);
  });
});

describe("session cookies", () => {
  const withCookie = (value: string) => request("/api/sites", { headers: { cookie: `${SESSION_COOKIE}=${value}` } });

  it("are HMAC-signed, expire, and cannot be tampered with", async () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    const value = await sessionValue(TOKEN, now);
    expect(value).toMatch(/^v2\.\d+\.[0-9a-f]{64}$/);
    expect(value).not.toContain(TOKEN);
    expect(await hasValidSession(withCookie(value), TOKEN, now + 1000)).toBe(true);
    expect(await hasValidSession(withCookie(value), TOKEN, now + (SESSION_MAX_AGE + 1) * 1000)).toBe(false); // expired
    const [v, , signature] = value.split(".");
    expect(await hasValidSession(withCookie(`${v}.${Math.floor(now / 1000) + 10 * SESSION_MAX_AGE}.${signature}`), TOKEN, now)).toBe(false); // extended expiry
    expect(await hasValidSession(withCookie(value), "another-token", now)).toBe(false);
  });

  it("are bound to SESSION_SECRET when it is configured", async () => {
    const plain = await sessionValue(TOKEN);
    process.env.SESSION_SECRET = "an-independent-high-entropy-secret";
    expect(await hasValidSession(withCookie(plain), TOKEN)).toBe(false);
    expect(await hasValidSession(withCookie(await sessionValue(TOKEN)), TOKEN)).toBe(true);
  });

  it("compare in constant time without false positives", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect([safeEqual("abc", "abd"), safeEqual("abc", "ab"), safeEqual("", "a"), safeEqual("a", "")]).toEqual([false, false, false, false]);
  });
});

describe("/api/auth", () => {
  it("rate-limits repeated wrong tokens and recovers after a successful login window", async () => {
    process.env.API_TOKEN = TOKEN;
    const attempt = (token: string) => POST(request("/api/auth", { method: "POST", body: { token }, headers: { origin: "http://localhost:3000" } }), undefined);
    for (let i = 0; i < 10; i++) expect((await attempt("wrong")).status).toBe(401);
    expect((await attempt("wrong")).status).toBe(429);
    expect((await attempt(TOKEN)).status).toBe(429); // even the right token waits while locked out
    loginLimiter.reset("local");
    expect((await attempt(TOKEN)).status).toBe(200);
  });

  it("reports no auth required without API_TOKEN", async () => {
    const res = await GET(request("/api/auth"), undefined);
    expect(await res.json()).toEqual({ required: false, authenticated: true });
  });

  it("exchanges a valid token for an httpOnly session cookie", async () => {
    process.env.API_TOKEN = TOKEN;
    const origin = { origin: "http://localhost:3000" };
    expect((await POST(request("/api/auth", { method: "POST", body: { token: "wrong" }, headers: origin }), undefined)).status).toBe(401);
    expect((await POST(request("/api/auth", { method: "POST", body: { token: TOKEN }, headers: { origin: "https://evil.example" } }), undefined)).status).toBe(403);
    const ok = await POST(request("/api/auth", { method: "POST", body: { token: TOKEN }, headers: origin }), undefined);
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(new RegExp(`${SESSION_COOKIE}=v2\\.\\d+\\.[0-9a-f]{64};`));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).not.toContain(TOKEN);
    const out = await DELETE(request("/api/auth", { method: "DELETE" }), undefined);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("proxy", () => {
  it("is open without API_TOKEN", async () => {
    expect((await proxy(request("/api/sites"))).status).toBe(200);
  });

  it("guards API and dashboard pages when API_TOKEN is set", async () => {
    process.env.API_TOKEN = TOKEN;
    expect((await proxy(request("/api/sites"))).status).toBe(401);
    expect((await proxy(request("/api/health"))).status).toBe(200);
    expect((await proxy(request("/api/auth"))).status).toBe(200);
    expect((await proxy(request("/login"))).status).toBe(200);
    const page = await proxy(request("/sites/abc/graph?x=1"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fsites%2Fabc%2Fgraph%3Fx%3D1");
    const cookie = `${SESSION_COOKIE}=${await sessionValue(TOKEN)}`;
    expect((await proxy(request("/sites/abc", { headers: { cookie } }))).status).toBe(200);
    expect((await proxy(request("/api/sites", { headers: { cookie } }))).status).toBe(200);
    expect((await proxy(request("/api/sites", { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(200);
  });
});
