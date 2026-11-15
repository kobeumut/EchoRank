import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  analyzeBloat,
  analyzeRender,
  BOT_PROFILES,
  botSimulationReportSchema,
  buildFixes,
  DEFAULT_BOTS,
  detectProtection,
  estimateTokens,
  type FetchLike,
  fingerprint,
  parseRobots,
  robotsAllows,
  runSiteBotSimulation,
  simulateBots,
  summarizeBotSimulation,
  tokenEfficiency,
  visibleWords,
} from "@/lib/services/bot-simulator";
import * as route from "@/app/api/sites/[id]/bot-simulator/route";
import { ctx, req, resetDb } from "./helpers";

// Python <-> TS contract: real output of services/crawler `geo_crawler.scoring.bot_simulator` (+ its HTML fixtures),
// generated in the default locale (English). The sample pages are Turkish web content on purpose: they are the input
// that exercises the Turkish tokenizer / render paths of both implementations.
const fixture = (name: string) => JSON.parse(readFileSync(path.resolve(__dirname, "fixtures", name), "utf8"));
const PY_REPORT = fixture("bot-simulation-report.json");
const PY_SUMMARY = fixture("bot-simulation-summary.json");
const PAGES: Record<string, { html: string; estimate_tokens: number; visible_words: number }> = fixture("botsim-pages.json");
const html = (name: string) => PAGES[name].html;

const ORIGIN = "https://botsim.example.com";
const CF = { "content-type": "text/html; charset=utf-8", server: "cloudflare", "cf-ray": "8f1c2d3e4f5a6b7c-IST" };
type Handler = (ua: string, url: URL) => Response | Promise<Response>;

/** fetch stand-in: robots.txt + `handler(userAgent, url)`; records every request's headers. */
function fakeFetch(handler: Handler, robots = "User-agent: *\nAllow: /\n") {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const impl: FetchLike = async (u, init) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ url: u, headers });
    const url = new URL(u);
    if (url.pathname === "/robots.txt") return new Response(robots, { headers: { "content-type": "text/plain" } });
    return handler(headers["user-agent"], url);
  };
  return { impl, seen };
}
const page = (body: string, status = 200, headers: Record<string, string> = { "content-type": "text/html" }) =>
  new Response(body, { status, headers });

describe("contract with the Python simulator", () => {
  it("parses the crawler's report and summarizes it identically", () => {
    const report = botSimulationReportSchema.parse(PY_REPORT);
    expect(report.blocked_bots).toEqual(["GPTBot", "ClaudeBot", "PerplexityBot"]);
    expect(summarizeBotSimulation(report)).toEqual(PY_SUMMARY);
  });

  it("token estimator and visible-word counter match the Python implementation", () => {
    for (const [name, p] of Object.entries(PAGES)) {
      expect(estimateTokens(p.html), name).toBe(p.estimate_tokens);
      expect(visibleWords(p.html), name).toBe(p.visible_words);
    }
    // Turkish sample text on purpose: exercises the non-ASCII branch of the estimator (same value as the Python port).
    expect(estimateTokens("Merhaba dünya, bu bir deneme metnidir.")).toBe(11);
    expect(estimateTokens("The quick brown fox jumps over the lazy dog 2026.")).toBe(13);
    // Turkish sample text on purpose (non-ASCII branch).
    expect(estimateTokens(`<div class="x" id="root"></div>\n<p>Şirketimiz İstanbul'da kuruldu.</p>`)).toBe(31);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("detectProtection", () => {
  it.each([
    [403, { server: "cloudflare", "cf-mitigated": "challenge" }, "CF_MANAGED_CHALLENGE", "cloudflare", "challenge"],
    [503, { server: "cloudflare" }, "CF_MANAGED_CHALLENGE", "cloudflare", "challenge"],
    [403, { server: "cloudflare" }, "CF_BLOCK_1020", "cloudflare", "block"],
    [403, { "x-iinfo": "1-2-3" }, "IMPERVA_BLOCK", "imperva", "block"],
    [403, { server: "AkamaiGHost" }, "AKAMAI_BLOCK", "akamai", "block"],
    [403, { "x-datadome": "protected" }, "DATADOME_CAPTCHA", "datadome", "captcha"],
    [200, { server: "cloudflare" }, "TURNSTILE_INTERSTITIAL", "cloudflare", "captcha"],
  ])("HTTP %i %j %s -> %s/%s", (status, headers, name, vendor, kind) => {
    const p = detectProtection(status, headers, html(name));
    expect(p).toMatchObject({ vendor, kind });
    expect(p?.evidence.length).toBeGreaterThan(0);
  });

  it("names Cloudflare challenge types and reads header-only verdicts", () => {
    expect(detectProtection(403, {}, html("CF_MANAGED_CHALLENGE"))?.name).toBe("Cloudflare Managed Challenge");
    expect(detectProtection(503, {}, html("CF_MANAGED_CHALLENGE").replace("cType: 'managed'", "cType: 'non-interactive'"))?.name)
      .toBe("Cloudflare JS Challenge");
    expect(detectProtection(202, { "x-amzn-waf-action": "challenge" }, "")).toMatchObject({ vendor: "aws_waf", kind: "challenge" });
    expect(detectProtection(405, { "X-Amzn-Waf-Action": "captcha" }, "")).toMatchObject({ vendor: "aws_waf", kind: "captcha" });
    expect(detectProtection(403, { "x-vercel-mitigated": "deny" }, "")).toMatchObject({ vendor: "vercel", kind: "block" });
    expect(detectProtection(403, { server: "CloudFront" }, "Request blocked. Generated by cloudfront (CloudFront)"))
      .toMatchObject({ vendor: "aws_waf", kind: "block" });
    expect(detectProtection(429, { "retry-after": "60" }, "slow down")).toMatchObject({ kind: "rate_limit", evidence: ["HTTP 429, Retry-After: 60"] });
    expect(detectProtection(403, { server: "nginx" }, "<h1>403 Forbidden</h1>")).toMatchObject({ vendor: "unknown", kind: "block" });
  });

  it("names protections and evidence in the requested locale (English by default)", () => {
    const body = html("CF_BLOCK_1020");
    expect(detectProtection(403, { server: "cloudflare" }, body)).toMatchObject({ name: "Cloudflare WAF block", evidence: [expect.stringMatching(/^body: '/)] });
    expect(detectProtection(403, { server: "cloudflare" }, body, "tr")).toMatchObject({ name: "Cloudflare WAF engeli", evidence: [expect.stringMatching(/^gövde: '/)] });
    expect(detectProtection(403, { server: "nginx" }, "<h1>403 Forbidden</h1>")?.name).toBe("Server/WAF HTTP 403 block");
    expect(detectProtection(403, { server: "nginx" }, "<h1>403 Forbidden</h1>", "tr")?.name).toBe("Sunucu/WAF HTTP 403 engeli");
    expect(detectProtection(429, {}, "slow down")?.name).toBe("HTTP 429 rate limit");
    expect(detectProtection(429, {}, "slow down", "tr")?.name).toBe("HTTP 429 hız sınırı");
  });

  it("does not flag normal pages", () => {
    expect(detectProtection(200, { server: "cloudflare", "cf-ray": "x" }, html("SSR_PAGE"))).toBeNull();
    expect(detectProtection(200, {}, html("CONTACT_PAGE_WITH_RECAPTCHA"))).toBeNull(); // contact-form CAPTCHA
    expect(detectProtection(404, {}, "<h1>Not found</h1>")).toBeNull();
    expect(fingerprint({ "CF-RAY": "1" })).toBe("cloudflare");
    expect(fingerprint({ server: "Apache" })).toBeNull();
  });
});

describe("render, tokens and bloat", () => {
  it("classifies CSR shells, SSR pages and hydrated frameworks", () => {
    const csr = analyzeRender(html("CSR_SHELL"));
    expect(csr).toMatchObject({ mode: "csr_shell", score: 0, spa_root: { id: "root", empty: true }, noscript_requires_js: true });
    expect(csr.reason).toBe("The #root mount point is empty and the server HTML has only 0 words; content is loaded with JavaScript");
    expect(analyzeRender(html("CSR_SHELL"), "tr").reason).toContain("#root kökü boş, sunucu HTML'inde yalnızca 0 kelime var");
    const ssr = analyzeRender(html("SSR_PAGE"));
    expect(ssr).toMatchObject({ mode: "static", score: 100, h1: "Barista Pro X Espresso Makinesi", reason: "Content is present in the first HTML response" });
    expect(ssr.word_count).toBeGreaterThan(400);
    const next = analyzeRender(html("SSR_PAGE").replace("</body>", '<script id="__NEXT_DATA__" type="application/json">{}</script></body>'));
    expect(next).toMatchObject({ mode: "ssr_hydrated", frameworks: ["nextjs"] });
    const thin = analyzeRender("<html><body><p>Short.</p></body></html>");
    expect(thin).toMatchObject({ mode: "thin", reason: "The server HTML has only 1 word" });
    expect(analyzeRender("<html><body><p>Short.</p></body></html>", "tr").reason).toBe("sunucu HTML'inde yalnızca 1 kelime var");
  });

  it("measures DOM size and embedded JSON state", () => {
    const state = JSON.stringify({ props: { items: Array.from({ length: 1400 }, (_, i) => ({ id: i, d: "x".repeat(80) })) } });
    const divs = Array.from({ length: 900 }, (_, i) => `<div class="c"><span>${i}</span><br></div>`).join("");
    const b = analyzeBloat(html("SSR_PAGE").replace("</main>", `</main>${divs}`)
      .replace("</body>", `<script id="__NEXT_DATA__" type="application/json">${state}</script><script>self.__next_f.push([1,"a"])</script></body>`));
    expect(b.dom_nodes).toBeGreaterThan(2700);
    expect(b.dom_depth).toBeLessThan(10);
    expect(b.json_state.map((s) => s.kind)).toEqual(["__NEXT_DATA__", "Next.js RSC payload"]);
    expect(b.ld_json_bytes).toBeGreaterThan(0);
    expect(b.issues.join(" ")).toMatch(/DOM has \d+ nodes.*Embedded JSON state data is 1\d\d KB/);
    expect(analyzeBloat(html("SSR_PAGE")).issues).toEqual([]);
    // the same page in Turkish (labels and issues follow the locale; sizes do not)
    const tr = analyzeBloat(html("SSR_PAGE").replace("</main>", `</main>${divs}`)
      .replace("</body>", `<script id="__NEXT_DATA__" type="application/json">${state}</script><script>self.__next_f.push([1,"a"])</script></body>`), "tr");
    expect(tr.json_state.map((s) => s.kind)).toEqual(["__NEXT_DATA__", "Next.js RSC yükü"]);
    expect(tr.issues.join(" ")).toMatch(/DOM \d+ düğüm.*gömülü JSON durum verisi 1\d\d KB/);
    expect(tr.dom_nodes).toBe(b.dom_nodes);
  });

  it("scores token efficiency", () => {
    expect(tokenEfficiency(0.2, 50_000, true)).toBe(100);
    expect(tokenEfficiency(0.01, 50_000, true)).toBeCloseTo(40);
    expect(tokenEfficiency(0.2, 50_000, false)).toBe(85);
    expect(tokenEfficiency(0.2, 3_000_000, true)).toBe(80);
  });

  it("evaluates robots.txt with RFC 9309 longest match", () => {
    const g = parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/ok\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow:\n");
    expect(robotsAllows(g, "GPTBot", `${ORIGIN}/`)).toBe(false);
    expect(robotsAllows(g, "PerplexityBot", `${ORIGIN}/private/x`)).toBe(true);
    expect(robotsAllows(g, "ClaudeBot", `${ORIGIN}/private/x`)).toBe(false);
    expect(robotsAllows(g, "ClaudeBot", `${ORIGIN}/private/ok`)).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /*?\nAllow: /blog/$"), "x", "/product?color=1")).toBe(false);
  });
});

describe("simulateBots", () => {
  it("sends the official bot identities without cookies and passes a healthy SSR site", async () => {
    const { impl, seen } = fakeFetch(() => page(html("SSR_PAGE"), 200, { "content-type": "text/html", server: "nginx" }));
    const report = await simulateBots([`${ORIGIN}/`], { fetchImpl: impl, delayMs: 0 });
    expect(report.bots).toEqual(DEFAULT_BOTS);
    const uas = seen.map((s) => s.headers["user-agent"]);
    for (const t of DEFAULT_BOTS) expect(uas).toContain(BOT_PROFILES[t].userAgent);
    const gpt = seen.find((s) => s.headers["user-agent"].includes("GPTBot/1.3"))!;
    expect(gpt.headers).toEqual({ "user-agent": BOT_PROFILES.GPTBot.userAgent, accept: expect.stringContaining("text/html"), "accept-encoding": "gzip, deflate" });
    expect(report.scores.access).toBe(100);
    expect(report.pages[0].results.every((r) => r.outcome === "ok" && r.robots_allowed && !r.silent_block)).toBe(true);
    expect(report.pages[0].ai_view).toMatchObject({ source: "GPTBot", render: { mode: "static" } });
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.findings.filter((f) => f.severity === "critical")).toEqual([]);
    const cf = report.fixes.find((f) => f.id === "cloudflare_waf_skip")!;
    expect(cf.preventive).toBe(true);
    for (const c of ["GPTBot", "ClaudeBot", "PerplexityBot", "Googlebot", "Applebot"]) expect(cf.code).toContain(`"${c}"`);
  });

  it("detects Cloudflare challenges / blocks as silent blocks and builds targeted allow rules", async () => {
    const { impl } = fakeFetch((ua) => {
      if (ua.includes("GPTBot") || ua.includes("ClaudeBot")) return page(html("CF_MANAGED_CHALLENGE"), 403, { ...CF, "cf-mitigated": "challenge" });
      if (ua.includes("PerplexityBot")) return page(html("CF_BLOCK_1020"), 403, CF);
      return page(html("SSR_PAGE"), 200, CF);
    });
    const report = await simulateBots([`${ORIGIN}/`], { fetchImpl: impl, delayMs: 0 });
    const r = Object.fromEntries(report.pages[0].results.map((x) => [x.token, x]));
    expect(r.GPTBot).toMatchObject({ outcome: "challenge", silent_block: true, protection: { vendor: "cloudflare", name: "Cloudflare Managed Challenge" } });
    expect(r.PerplexityBot).toMatchObject({ outcome: "blocked", silent_block: true, reason: "Cloudflare WAF block (HTTP 403)", label: "blocked" });
    expect(r["Google-Extended"]).toMatchObject({ outcome: "ok", general: false });
    expect(report.blocked_bots).toEqual(["GPTBot", "ClaudeBot", "PerplexityBot"]);
    expect(report.vendors).toEqual(["cloudflare"]);
    expect(report.scores.access).toBe(40);
    expect(report.findings.map((f) => f.code).slice(0, 2)).toEqual(["waf_challenge", "waf_block"]);
    expect(report.findings[0].title).toBe("2 AI bots are stuck on a challenge/CAPTCHA page");
    expect(report.findings[1].title).toBe("1 AI bot is rejected by the server/WAF");
    expect(report.findings[1].detail).toBe("Cloudflare WAF block (HTTP 403). robots.txt allows PerplexityBot, yet the request is rejected (silent block).");

    const cf = report.fixes.find((f) => f.id === "cloudflare_waf_skip")!;
    expect(cf).toMatchObject({ recommended: true, preventive: false });
    expect(cf.code).toContain('(http.user_agent contains "GPTBot") or (http.user_agent contains "ClaudeBot") or (http.user_agent contains "PerplexityBot")');
    expect(cf.code).not.toContain("Googlebot");
    const api = JSON.parse(cf.code.split("rules[0]):\n")[1]);
    expect(api).toMatchObject({ action: "skip", action_parameters: { ruleset: "current" } });
    expect(report.fixes.find((f) => f.id === "nginx_allow")!.code).toContain('"~*(GPTBot|ClaudeBot|PerplexityBot)" 1;');
    expect(report.fixes.find((f) => f.id === "apache_allow")!.code).toContain('SetEnvIfNoCase User-Agent "(GPTBot|ClaudeBot|PerplexityBot)" ai_bot');
    expect(report.caveats[0]).toContain("not from the AI providers' IP ranges");
    expect(r["Google-Extended"].note).toBe("Google-Extended is a robots.txt token only; Google fetches content with Googlebot.");
    // same verdicts as the Python simulator on the same responses
    const py = PY_REPORT.pages[0].results.map((x: { token: string; outcome: string }) => [x.token, x.outcome]);
    expect(report.pages[0].results.filter((x) => x.token !== "Applebot-Extended").map((x) => [x.token, x.outcome]))
      .toEqual(py.filter(([t]: string[]) => t !== "Applebot-Extended"));
  });

  it("flags CSR shells, dropped connections, thin bot content and robots.txt disallows", async () => {
    const { impl } = fakeFetch((ua, url) => {
      if (url.pathname === "/app") return page(html("CSR_SHELL"));
      if (ua.includes("ClaudeBot")) return page("<html><body><main><p>Too little content.</p></main></body></html>");
      if (ua.includes("PerplexityBot")) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "socket hang up" } });
      return page(html("SSR_PAGE"));
    }, "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    const report = await simulateBots([`${ORIGIN}/`, `${ORIGIN}/app#x`, `${ORIGIN}/`], { fetchImpl: impl, delayMs: 0 });
    expect(report.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/app`]);
    const home = Object.fromEntries(report.pages[0].results.map((x) => [x.token, x]));
    expect(home.ClaudeBot.outcome).toBe("degraded");
    expect(home.PerplexityBot).toMatchObject({ outcome: "error", silent_block: true, error: "ECONNRESET: socket hang up" });
    expect(home.PerplexityBot.reason).toBe("ECONNRESET: socket hang up (the browser request succeeded → the connection is being dropped for the AI user agent)");
    expect(home.ClaudeBot.reason).toMatch(/^Returned \d+% of the browser's content \(3 words\)$/);
    expect(home.GPTBot).toMatchObject({ robots_allowed: false, accessible: true, silent_block: false });
    const codes = report.findings.map((f) => f.code);
    expect(codes[0]).toBe("waf_block");
    expect(codes).toEqual(expect.arrayContaining(["csr_shell", "content_parity", "robots_disallow"]));
    expect(report.findings.find((f) => f.code === "csr_shell")!.urls).toEqual([`${ORIGIN}/app`]);
    expect(report.fixes.map((f) => f.id)).toContain("ssr_render");
  });

  it("reports a general bot wall, rate limits and unreachable robots.txt", async () => {
    const wall = await simulateBots([`${ORIGIN}/`], {
      fetchImpl: fakeFetch(() => page(html("CF_MANAGED_CHALLENGE"), 403, { ...CF, "cf-mitigated": "challenge" })).impl, delayMs: 0,
    });
    expect(wall.findings[0]).toMatchObject({ code: "general_block" });
    expect(wall.findings[0].detail).toContain("Cloudflare Managed Challenge is shown to all automated clients");
    expect(wall.score).toBe(0);
    expect(wall.pages[0].ai_view).toBeNull();

    const fetchImpl: FetchLike = async (u, init) => {
      if (u.endsWith("/robots.txt")) return new Response("", { status: 503 });
      const ua = (init.headers as Record<string, string>)["user-agent"];
      return ua.includes("GPTBot") ? page("Too Many Requests", 429, { "retry-after": "60" }) : page(html("SSR_PAGE"));
    };
    const rl = await simulateBots([`${ORIGIN}/`], { fetchImpl, delayMs: 0, bots: ["GPTBot", "ChatGPT-User"] });
    expect(rl.robots_status).toBe(503);
    expect(rl.pages[0].results.every((x) => x.robots_allowed === false)).toBe(true);
    expect(rl.findings.map((f) => f.code)).toContain("rate_limited");
  });

  it("measures compressed transfer size and token weight", async () => {
    const body = html("SSR_PAGE").repeat(8);
    const gz = gzipSync(body);
    // fetch() hands back the decoded body; Content-Length still carries the wire size
    const { impl } = fakeFetch(() => page(body, 200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(gz.byteLength) }));
    const report = await simulateBots([`${ORIGIN}/`], { fetchImpl: impl, delayMs: 0, bots: ["GPTBot"] });
    const t = report.pages[0].ai_view!.tokens;
    expect(t).toMatchObject({ compressed: true, content_encoding: "gzip", method: "estimate:cl100k_base" });
    expect(t.transfer_kb).toBeCloseTo(gz.byteLength / 1024, 0);
    expect(t.html_tokens).toBe(estimateTokens(body));
    expect(t.text_tokens).toBeGreaterThan(1000);
  });

  it("writes reasons, findings, caveats and fix comments in Turkish with locale tr (field names and ids stay)", async () => {
    const { impl } = fakeFetch((ua, url) => {
      if (ua.includes("GPTBot")) return page(html("CF_MANAGED_CHALLENGE"), 403, { ...CF, "cf-mitigated": "challenge" });
      if (ua.includes("PerplexityBot")) return page(html("CF_BLOCK_1020"), 403, CF);
      return page(url.pathname === "/app" ? html("CSR_SHELL") : html("SSR_PAGE"), 200, CF);
    }, "User-agent: Applebot-Extended\nDisallow: /\n");
    const report = await simulateBots([`${ORIGIN}/`, `${ORIGIN}/app`], { fetchImpl: impl, delayMs: 0, locale: "tr" });
    const r = Object.fromEntries(report.pages[0].results.map((x) => [x.token, x]));
    expect(r.GPTBot).toMatchObject({ outcome: "challenge", label: "challenge/CAPTCHA", reason: "Cloudflare Managed Challenge (HTTP 403)" });
    expect(r.PerplexityBot).toMatchObject({ outcome: "blocked", label: "engellendi", reason: "Cloudflare WAF engeli (HTTP 403)", protection: { evidence: [expect.stringMatching(/^gövde: /)] } });
    expect(r["Google-Extended"]).toMatchObject({ label: "erişilebilir", reason: "HTTP 200, 544 kelime", note: "Google-Extended yalnızca robots.txt jetonudur; Google içeriği Googlebot ile alır." });
    expect(report.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["waf_challenge", "waf_block", "csr_shell", "robots_disallow"]));
    const byCode = Object.fromEntries(report.findings.map((f) => [f.code, f]));
    expect(byCode.waf_challenge.title).toBe("1 AI botu challenge/CAPTCHA sayfasına takılıyor");
    expect(byCode.waf_block.detail).toContain("robots.txt PerplexityBot için izin verdiği hâlde (sessiz engel).");
    expect(byCode.csr_shell.detail).toBe("#root kökü boş, sunucu HTML'inde yalnızca 0 kelime var; içerik JavaScript ile yükleniyor. AI tarayıcıları JavaScript çalıştırmaz; SSR/SSG veya prerender gerekli.");
    expect(report.caveats[0]).toContain("IP aralıklarından değil");
    const fixes = Object.fromEntries(report.fixes.map((f) => [f.id, f]));
    expect(fixes.cloudflare_waf_skip.title).toBe("Cloudflare WAF: AI botları için Skip kuralı");
    expect(fixes.cloudflare_waf_skip.code).toContain("(listenin EN ÜSTÜNE taşıyın)");
    expect(fixes.nginx_allow.code).toContain("# server { } bloğu — mevcut UA engelinizi AI botları dışında bırakın:");
    expect(fixes.apache_allow.instructions).toBe("Değişiklikten sonra `apachectl configtest && apachectl graceful` çalıştırın.");
    expect(fixes.ssr_render.code).toContain("// AI botları JavaScript çalıştırmaz; https://botsim.example.com/app ilk HTML'de içerik döndürmeli.");
    // the configuration itself is language-independent
    const en = await simulateBots([`${ORIGIN}/`, `${ORIGIN}/app`], { fetchImpl: impl, delayMs: 0 });
    expect(report.findings.map((f) => [f.code, f.severity])).toEqual(en.findings.map((f) => [f.code, f.severity]));
    expect(report.fixes.map((f) => [f.id, f.platform, f.language])).toEqual(en.fixes.map((f) => [f.id, f.platform, f.language]));
    expect(JSON.parse(fixes.cloudflare_waf_skip.code.split("rules[0]):\n")[1])).toEqual(JSON.parse(en.fixes.find((f) => f.id === "cloudflare_waf_skip")!.code.split("rules[0]):\n")[1]));
    expect(botSimulationReportSchema.parse(report)).toBeTruthy();
  });

  it("validates input", async () => {
    await expect(simulateBots([])).rejects.toThrow("At least one URL");
    await expect(simulateBots([ORIGIN], { bots: ["NopeBot"] })).rejects.toThrow("Unknown bot");
    await expect(simulateBots(["ftp://x.test/"])).rejects.toThrow("Unsupported URL");
  });
});

describe("buildFixes", () => {
  it("adds vendor recipes for detected WAFs only", () => {
    const fixes = buildFixes([BOT_PROFILES.GPTBot, BOT_PROFILES["Google-Extended"]], ["akamai", "aws_waf"], ["https://x.test/"]);
    const ids = fixes.map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(["cloudflare_waf_skip", "nginx_allow", "apache_allow"]);
    expect(ids).toEqual(expect.arrayContaining(["aws_waf_allow", "akamai_console", "ssr_render"]));
    const aws = JSON.parse(fixes.find((f) => f.id === "aws_waf_allow")!.code);
    expect(aws.Rules[0].Statement.RegexMatchStatement.RegexString).toBe("(?i)(GPTBot|Googlebot)");
    expect(buildFixes([BOT_PROFILES.GPTBot]).map((f) => f.id)).not.toContain("aws_waf_allow");
    expect(buildFixes([], [])).toEqual([]);
  });

  it("writes the comments inside the generated snippets in the requested locale", () => {
    const en = buildFixes([BOT_PROFILES.GPTBot], ["akamai"], ["https://x.test/"], true);
    const tr = buildFixes([BOT_PROFILES.GPTBot], ["akamai"], ["https://x.test/"], true, false, "tr");
    expect(tr.map((f) => f.id)).toEqual(en.map((f) => f.id));
    const code = (fixes: typeof en, id: string) => fixes.find((f) => f.id === id)!.code;
    expect(code(en, "nginx_allow")).toContain("# rate-limit key: an empty key for AI bots = the limit is not applied");
    expect(code(tr, "nginx_allow")).toContain("# rate limit anahtarı: AI botları için boş anahtar = limit uygulanmaz");
    expect(code(en, "apache_allow")).toContain("# 3) Exempt them from ModSecurity / OWASP CRS scanner detection:");
    expect(code(tr, "apache_allow")).toContain("# 3) ModSecurity / OWASP CRS tarayıcı tespitinden muaf tutun:");
    expect(code(en, "token_diet")).toContain("# Embedded state data (__NEXT_DATA__ / RSC / __NUXT__):");
    expect(code(tr, "token_diet")).toContain("# Gömülü durum verisi (__NEXT_DATA__ / RSC / __NUXT__):");
    expect(code(en, "ssr_render")).toContain("// fetch the data on the server (NOT useEffect + fetch)");
    expect(code(tr, "ssr_render")).toContain("// sunucuda veri çek (useEffect + fetch DEĞİL)");
    expect(code(en, "akamai_console")).toContain("set the action of the 'AI Crawlers'");
    expect(code(tr, "akamai_console")).toContain("aksiyonunu Allow (veya Monitor) yapın");
    expect(en.find((f) => f.id === "akamai_console")!.instructions).toBe("Apply it in the admin console and run the simulation again.");
    expect(tr.find((f) => f.id === "akamai_console")!.instructions).toBe("Yönetim panelinden uygulayın ve simülasyonu tekrar çalıştırın.");
    // the configuration lines are identical in every language
    const strip = (c: string) =>
      c.split("\n").filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("//")).map((l) => l.replace(/\s+# .*$/, ""));
    expect(strip(code(tr, "nginx_allow"))).toEqual(strip(code(en, "nginx_allow")));
    expect(tr.find((f) => f.id === "nginx_allow")!.instructions).toContain("`nginx -t && nginx -s reload`");
  });

  it("produces the same recipes as the Python simulator", () => {
    const py = botSimulationReportSchema.parse(PY_REPORT);
    const ts = buildFixes(py.blocked_bots.map((t) => BOT_PROFILES[t]), py.vendors,
      py.findings.find((f) => f.code === "csr_shell")?.urls ?? [], py.findings.some((f) => f.code === "token_bloat"));
    expect(ts.filter((f) => f.id !== "ssr_render")).toEqual(py.fixes.filter((f) => f.id !== "ssr_render"));
  });
});

describe("site API", () => {
  let siteId = "";
  beforeEach(async () => {
    await resetDb();
    siteId = (await prisma.site.create({ data: { url: ORIGIN, title: "Botsim" } })).id;
    vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true"); // no DNS in tests; the guard has its own test below
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("POST runs a live simulation of the site's homepage", async () => {
    const { impl, seen } = fakeFetch((ua) =>
      ua.includes("ClaudeBot") ? page(html("CF_MANAGED_CHALLENGE"), 403, { ...CF, "cf-mitigated": "challenge" }) : page(html("SSR_PAGE"), 200, CF));
    vi.stubGlobal("fetch", impl);
    const res = await route.POST(req(`/api/sites/${siteId}/bot-simulator`, { method: "POST", body: { bots: ["GPTBot", "ClaudeBot"] } }), ctx(siteId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(botSimulationReportSchema.parse(body).blocked_bots).toEqual(["ClaudeBot"]);
    expect(body.pages[0].url).toBe(`${ORIGIN}/`);
    expect(seen.map((s) => s.url)).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/`]);
  });

  it("POST generates the report text in the request's language (?lang= / cookie / Accept-Language; English by default)", async () => {
    const { impl } = fakeFetch((ua) => (ua.includes("GPTBot") ? page(html("CF_BLOCK_1020"), 403, CF) : page(html("SSR_PAGE"), 200, CF)));
    vi.stubGlobal("fetch", impl);
    const run = async (path: string, headers: Record<string, string> = {}) => {
      const request = req(path, { method: "POST", body: { bots: ["GPTBot"] } });
      for (const [k, v] of Object.entries(headers)) request.headers.set(k, v);
      return (await (await route.POST(request, ctx(siteId))).json()) as { findings: { code: string; title: string }[] };
    };
    const base = `/api/sites/${siteId}/bot-simulator`;
    expect((await run(base)).findings[0].title).toBe("1 AI bot is rejected by the server/WAF");
    expect((await run(`${base}?lang=tr`)).findings[0].title).toBe("1 AI botu sunucu/WAF tarafından reddediliyor");
    expect((await run(base, { cookie: "locale=tr" })).findings[0].title).toBe("1 AI botu sunucu/WAF tarafından reddediliyor");
    expect((await run(base, { "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" })).findings[0].title).toBe("1 AI botu sunucu/WAF tarafından reddediliyor");
    expect((await run(`${base}?lang=en`, { cookie: "locale=tr" })).findings[0].title).toBe("1 AI bot is rejected by the server/WAF");
  });

  it("the default transport refuses internal addresses and redirects into them (SSRF guard)", async () => {
    vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "false");
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }));
    const metadata = (await prisma.site.create({ data: { url: "http://169.254.169.254", title: "Metadata" } })).id;
    const direct = await (await route.POST(req(`/api/sites/${metadata}/bot-simulator`, { method: "POST", body: { bots: ["GPTBot"] } }), ctx(metadata))).json();
    expect(JSON.stringify(direct)).toMatch(/private network/i);
    expect(seen).toEqual([]); // nothing was requested

    const redirected = await prisma.site.create({ data: { url: "https://8.8.8.8", title: "Redirects" } });
    const report = await (await route.POST(req(`/api/sites/${redirected.id}/bot-simulator`, { method: "POST", body: { bots: ["GPTBot"] } }), ctx(redirected.id))).json();
    expect(JSON.stringify(report)).toMatch(/private network/i);
    expect(seen.every((u) => u.startsWith("https://8.8.8.8"))).toBe(true); // the internal hop was never fetched
  });

  it("POST refuses URLs outside the site and invalid input", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const foreign = await route.POST(req(`/api/sites/${siteId}/bot-simulator`, { method: "POST", body: { urls: ["https://evil.test/"] } }), ctx(siteId));
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error).toContain("botsim.example.com");
    const bad = await route.POST(req(`/api/sites/${siteId}/bot-simulator`, { method: "POST", body: { bots: ["NopeBot"] } }), ctx(siteId));
    expect(bad.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    await expect(runSiteBotSimulation(siteId, { urls: ["https://www.botsim.example.com/x"] }, {
      fetchImpl: fakeFetch(() => page(html("SSR_PAGE"))).impl, delayMs: 0, bots: ["GPTBot"],
    })).resolves.toMatchObject({ origin: "https://www.botsim.example.com" });
    const missing = await route.POST(req("/api/sites/nope/bot-simulator", { method: "POST" }), ctx("nope"));
    expect(missing.status).toBe(404);
  });

  it("GET returns the latest audit's simulation summary", async () => {
    const empty = await (await route.GET(req(`/api/sites/${siteId}/bot-simulator`), ctx(siteId))).json();
    expect(empty).toEqual({ auditId: null, completedAt: null, summary: null });
    await prisma.geoAudit.create({ data: { siteId, status: "completed", completedAt: new Date("2026-11-01"), metrics: { botSimulation: { score: 10 } } } });
    const audit = await prisma.geoAudit.create({ data: { siteId, status: "completed", completedAt: new Date("2026-11-08"), metrics: { botSimulation: PY_SUMMARY } } });
    await prisma.geoAudit.create({ data: { siteId, status: "completed", completedAt: new Date("2026-11-09"), metrics: { aiAccess: 90 } } });
    const body = await (await route.GET(req(`/api/sites/${siteId}/bot-simulator`), ctx(siteId))).json();
    expect(body.auditId).toBe(audit.id);
    expect(body.summary).toEqual(PY_SUMMARY);
  });
});
