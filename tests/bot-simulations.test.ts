import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AI_BOTS, analyzeResponse, resolveSiteUrls, summarizeRun, visibleText } from "@/lib/services/bot-simulations";
import * as route from "@/app/api/sites/[id]/simulation/bots/route";
import { ctx, req, resetDb } from "./helpers";

const BASE = "https://shop.example.com";
const ARTICLE = `<html><head><title>Espresso</title><script>window.x=1</script></head><body><main><h1>Espresso rehberi</h1><p>${"Espresso, basınçla demlenen yoğun bir kahvedir. ".repeat(20)}</p></main></body></html>`;
const SHELL = `<html><head><script src="/static/app.4f1.js"></script></head><body><div id="root"></div><noscript>Enable JavaScript</noscript></body></html>`;
const CF = `<html><head><title>Just a moment...</title></head><body><div id="cf-wrapper">Checking your browser</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`;
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

const seen: { url: string; ua: string }[] = [];
function mockSite() {
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const ua = (init?.headers as Record<string, string>)["user-agent"];
    seen.push({ url: url.href, ua });
    expect(init?.redirect).toBe("manual");
    if (ua.includes("GPTBot")) return html(CF, 403, { server: "cloudflare", "cf-ray": "8abc-IST", "cf-mitigated": "challenge", "set-cookie": "secret=1" });
    if (url.pathname === "/app") return ua.includes("ClaudeBot") ? html(SHELL) : html(ARTICLE);
    if (url.pathname === "/old") return new Response(null, { status: 301, headers: { location: "/blog/espresso" } });
    return html(ARTICLE, 200, { server: "nginx" });
  }));
}

beforeEach(async () => {
  await resetDb();
  seen.length = 0;
  vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true"); // no DNS in tests
  mockSite();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => prisma.$disconnect());

const post = async (siteId: string, body?: unknown) => {
  const res = await route.POST(req(`/api/sites/${siteId}/simulation/bots`, { method: "POST", body }), ctx(siteId));
  return { status: res.status, body: await res.json() };
};
const get = async (siteId: string, qs = "") => {
  const res = await route.GET(req(`/api/sites/${siteId}/simulation/bots${qs}`), ctx(siteId));
  return { status: res.status, body: await res.json() };
};

describe("response analysis", () => {
  it("detects WAF challenges by vendor", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(analyzeResponse(403, h({ server: "cloudflare", "cf-ray": "1" }), CF)).toMatchObject({ isBlocked: true, blockedBy: "cloudflare" });
    expect(analyzeResponse(200, h({ "cf-mitigated": "challenge" }), CF).blockedBy).toBe("cloudflare");
    expect(analyzeResponse(403, h({}), "<html>Request unsuccessful. Incapsula incident ID: 123</html>").blockedBy).toBe("imperva");
    expect(analyzeResponse(403, h({ server: "AkamaiGHost" }), "<html>Access Denied</html>").blockedBy).toBe("akamai");
    expect(analyzeResponse(403, h({ "x-amzn-waf-action": "block" }), "").blockedBy).toBe("aws_waf");
    expect(analyzeResponse(403, h({ "x-sucuri-block": "1" }), "").blockedBy).toBe("sucuri");
    expect(analyzeResponse(403, h({ "x-datadome": "protected" }), "").blockedBy).toBe("datadome");
    expect(analyzeResponse(429, h({}), "slow down").blockedBy).toBe("http_status");
    expect(analyzeResponse(null, h({}), "").blockedBy).toBe("network");
    expect(analyzeResponse(404, h({}), "<html>missing</html>")).toMatchObject({ isBlocked: false, isCsrShell: false });
  });

  it("flags empty client-rendered shells but not server-rendered pages", () => {
    const shell = analyzeResponse(200, new Headers({ "content-type": "text/html" }), SHELL);
    expect(shell).toMatchObject({ isBlocked: false, isCsrShell: true });
    expect(shell.diagnostics.shellSelector).toBe("#root");
    expect(shell.diagnostics.reasons).toContain("empty_mount_#root");
    const ssr = analyzeResponse(200, new Headers({ "content-type": "text/html" }), ARTICLE);
    expect(ssr.isCsrShell).toBe(false);
    expect(ssr.tokenCount).toBe(Math.ceil(visibleText(ARTICLE).length / 4));
    expect(visibleText(ARTICLE)).not.toMatch(/window\.x|Espresso rehberi.*<|<title>/);
  });

  it("keeps requests on the tracked site", () => {
    expect(resolveSiteUrls(BASE, ["/a#x", `${BASE}/a`, "https://blog.shop.example.com/p", "https://www.shop.example.com/"])).toEqual([
      `${BASE}/a`, "https://blog.shop.example.com/p", "https://www.shop.example.com/",
    ]);
    expect(() => resolveSiteUrls(BASE, ["https://evil.test/"])).toThrow(/not on the tracked site/);
    expect(() => resolveSiteUrls(BASE, ["https://shop.example.com.evil.test/"])).toThrow(/not on the tracked site/);
    expect(() => resolveSiteUrls(BASE, ["ftp://shop.example.com/"])).toThrow();
  });

  it("separates bot-only blocks from site-wide failures", () => {
    const row = (botName: string, url: string, isBlocked: boolean) =>
      ({ url, botName, statusCode: isBlocked ? 403 : 200, isBlocked, blockedBy: isBlocked ? "cloudflare" : null, isCsrShell: false, tokenCount: 10, loadTimeMs: 5 });
    const s = summarizeRun([row("GPTBot", "/a", true), row("Browser", "/a", false), row("GPTBot", "/b", true), row("Browser", "/b", true)]);
    expect(s.botOnlyBlocks).toEqual([{ url: "/a", botName: "GPTBot", statusCode: 403, blockedBy: "cloudflare" }]);
    expect(s.perBot.find((b) => b.botName === "GPTBot")).toMatchObject({ checked: 2, blocked: 2, ok: 0 });
  });
});

describe("GET/POST /api/sites/[id]/simulation/bots", () => {
  it("runs a live simulation as each AI bot and stores one record per url x bot", async () => {
    const site = await prisma.site.create({ data: { url: BASE, title: "Shop" } });
    const { status, body } = await post(site.id, { urls: ["/app", "/old"], bots: ["GPTBot", "ClaudeBot", "PerplexityBot"] });
    expect(status).toBe(201);
    expect(body.bots).toEqual(["GPTBot", "ClaudeBot", "PerplexityBot", "Browser"]);
    expect(body.records).toHaveLength(8);
    expect(new Set(seen.map((s) => s.ua))).toEqual(new Set([AI_BOTS.GPTBot, AI_BOTS.ClaudeBot, AI_BOTS.PerplexityBot, AI_BOTS.Browser]));

    const rec = (url: string, bot: string) => body.records.find((r: { url: string; botName: string }) => r.url === `${BASE}${url}` && r.botName === bot);
    expect(rec("/app", "GPTBot")).toMatchObject({ statusCode: 403, isBlocked: true, blockedBy: "cloudflare" });
    expect(rec("/app", "GPTBot").headers).toMatchObject({ "cf-mitigated": "challenge", server: "cloudflare" });
    expect(rec("/app", "GPTBot").headers["set-cookie"]).toBeUndefined();
    expect(rec("/app", "ClaudeBot")).toMatchObject({ statusCode: 200, isBlocked: false, isCsrShell: true });
    expect(rec("/app", "PerplexityBot")).toMatchObject({ statusCode: 200, isCsrShell: false });
    expect(rec("/app", "PerplexityBot").tokenCount).toBeGreaterThan(100);
    // redirect followed
    expect(rec("/old", "PerplexityBot")).toMatchObject({ statusCode: 200 });
    expect(rec("/old", "PerplexityBot").diagnostics.finalUrl).toBe(`${BASE}/blog/espresso`);

    expect(body.summary.botOnlyBlocks.map((b: { botName: string }) => b.botName)).toEqual(["GPTBot", "GPTBot"]);
    expect(body.summary.csrShellUrls).toEqual([`${BASE}/app`]);

    const latest = await get(site.id);
    expect(latest.body).toMatchObject({ runId: body.runId, total: 8 });
    expect((await get(site.id, "?blocked=true")).body.items).toHaveLength(2);
    expect((await get(site.id, "?bot=ClaudeBot")).body.items).toHaveLength(2);
  });

  it("defaults to the home page plus crawled pages and the five AI bots", async () => {
    const site = await prisma.site.create({ data: { url: BASE, title: "Shop" } });
    await prisma.crawledPage.create({ data: { siteId: site.id, url: `${BASE}/blog/espresso`, statusCode: 200 } });
    await prisma.crawledPage.create({ data: { siteId: site.id, url: `${BASE}/gone`, statusCode: 404 } });
    const { body } = await post(site.id, { includeBaseline: false });
    expect(body.urls).toEqual([`${BASE}/`, `${BASE}/blog/espresso`]);
    expect(body.bots).toEqual(["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"]);
    expect(body.records).toHaveLength(10);
  });

  it("refuses private-network redirects and off-site URLs", async () => {
    vi.unstubAllEnvs();
    const site = await prisma.site.create({ data: { url: "https://93.184.215.14", title: "Public" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })));
    const { status, body } = await post(site.id, { urls: ["/"], bots: ["GPTBot"], includeBaseline: false });
    expect(status).toBe(201);
    expect(body.records[0]).toMatchObject({ statusCode: null, isBlocked: true, blockedBy: "network" });
    expect(body.records[0].diagnostics.error).toMatch(/private network/);
    expect(fetch).toHaveBeenCalledTimes(1);

    expect((await post(site.id, { urls: ["https://evil.test/"] })).status).toBe(400);
    expect((await post(site.id, { bots: ["EvilBot"] })).status).toBe(400);
    expect((await post(site.id, { urls: Array.from({ length: 11 }, (_, i) => `/p${i}`) })).status).toBe(400);
    expect((await get(site.id, "?blocked=maybe")).status).toBe(400);
    expect((await get(site.id)).body).toMatchObject({ runId: expect.any(String) });
    expect((await post("missing")).status).toBe(404);
  });
});
