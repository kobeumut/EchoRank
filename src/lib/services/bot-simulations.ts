// Live AI crawler simulation: fetches the site's own URLs with AI bot identities and records whether each bot gets
// real server-rendered content, a WAF/CAPTCHA wall or an empty client-side (CSR) shell. AI crawlers do not run
// JavaScript, so a page that only renders in the browser is invisible to them even when robots.txt allows them.
//
// Every request targets the tracked site (same host or subdomain), every hop is checked against private networks,
// bodies are capped at 2 MB and each request times out after 15 s.
//
// Diagnostic `reasons` are machine codes (`blocked_by_cloudflare`, `empty_mount_#root`, ...); only the request-level error
// text (time-out / failure) is human-readable and is written in the caller's `locale` (default English).
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { OUTBOUND_TIMEOUT_MS, pinnedFetch } from "../distribution/net";
import { HttpError } from "../http";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { serverT } from "../i18n/request";
import { queryBool } from "../validation";
import { getSiteOrThrow } from "./sites";

/**
 * Published crawler user agents. Google-Extended and Applebot-Extended are robots.txt control tokens without their own
 * fetcher: Google and Apple crawl with Googlebot / Applebot, so a WAF rule must allow those agents.
 */
export const AI_BOTS = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  PerplexityBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Google-Extended": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.0.0 Safari/537.36",
  "Applebot-Extended": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
  /** Control request: a block only bots get points at a bot rule, not a site-wide outage. */
  Browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
} as const;
export type BotName = keyof typeof AI_BOTS;
export const BOT_NAMES = Object.keys(AI_BOTS) as [BotName, ...BotName[]];
export const DEFAULT_BOTS: BotName[] = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"];

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 4;
const BLOCK_STATUSES = new Set([401, 403, 406, 429, 451, 503]);
/** Response headers worth keeping for diagnosis (never cookies). */
const KEEP_HEADERS = [
  "server", "content-type", "content-length", "content-encoding", "cache-control", "cf-ray", "cf-cache-status", "cf-mitigated",
  "x-cache", "via", "x-iinfo", "x-cdn", "x-sucuri-id", "x-sucuri-block", "x-amzn-waf-action", "x-datadome", "x-robots-tag",
  "location", "retry-after", "x-powered-by",
];

// ---------------------------------------------------------------- response analysis (pure)

export type ResponseAnalysis = {
  isBlocked: boolean;
  blockedBy: string | null;
  isCsrShell: boolean;
  tokenCount: number;
  diagnostics: { textChars: number; scriptBytes: number; shellSelector: string | null; reasons: string[] };
};

const WAF_RULES: { vendor: string; test: (h: Headers, body: string, status: number) => boolean }[] = [
  {
    vendor: "cloudflare",
    test: (h, b, s) =>
      h.get("cf-mitigated") === "challenge" ||
      ((/cloudflare/i.test(h.get("server") ?? "") || h.has("cf-ray")) &&
        (BLOCK_STATUSES.has(s) || /challenge-platform|cf-turnstile|cf_chl_/i.test(b)) &&
        /Just a moment|Attention Required|cf-chl|challenge-platform|cf-turnstile|cf-error-details|Sorry, you have been blocked/i.test(b)),
  },
  { vendor: "imperva", test: (h, b) => /_Incapsula_Resource|Incapsula incident ID/i.test(b) || (/incapsula/i.test(h.get("x-cdn") ?? "") && /Request unsuccessful/i.test(b)) },
  { vendor: "akamai", test: (h, b, s) => s === 403 && (/AkamaiGHost/i.test(h.get("server") ?? "") || /errors\.edgesuite\.net|Reference&#32;&#35;|Reference #\d/i.test(b)) },
  { vendor: "aws_waf", test: (h, b, s) => !!h.get("x-amzn-waf-action") || (s === 403 && /awselb|cloudfront/i.test(`${h.get("server")} ${h.get("via")}`) && /Request blocked|Request could not be satisfied/i.test(b)) },
  { vendor: "sucuri", test: (h, b) => h.has("x-sucuri-block") || /Sucuri WebSite Firewall - Access Denied/i.test(b) },
  { vendor: "datadome", test: (h, b, s) => BLOCK_STATUSES.has(s) && (h.has("x-datadome") || /captcha-delivery\.com/i.test(b)) },
  { vendor: "captcha", test: (_h, b) => /hcaptcha\.com\/1\/api\.js|www\.google\.com\/recaptcha\/api\.js|challenges\.cloudflare\.com\/turnstile/i.test(b) && visibleText(b).length < 400 },
];

const MOUNTS: [string, RegExp][] = [
  ["#root", /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i],
  ["#app", /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i],
  ["#__next", /<div[^>]+id=["']__next["'][^>]*>\s*<\/div>/i],
  ["#__nuxt", /<div[^>]+id=["']__nuxt["'][^>]*>\s*<\/div>/i],
  ["#svelte", /<div[^>]+id=["']svelte["'][^>]*>\s*<\/div>/i],
  ["app-root", /<app-root[^>]*>\s*<\/app-root>/i],
];

/** Text an HTML-only reader sees: no scripts, styles, templates, noscript fallbacks or tags. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&[a-z#0-9]+;/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
}

export function analyzeResponse(status: number | null, headers: Headers, body: string): ResponseAnalysis {
  const reasons: string[] = [];
  const text = status === null ? "" : visibleText(body);
  const scriptBytes = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].reduce((n, m) => n + m[1].length, 0);
  const bundles = (body.match(/<script\b[^>]*\bsrc=/gi) ?? []).length;
  let blockedBy: string | null = null;
  if (status === null) blockedBy = "network";
  else {
    blockedBy = WAF_RULES.find((r) => r.test(headers, body, status))?.vendor ?? null;
    if (!blockedBy && BLOCK_STATUSES.has(status)) blockedBy = "http_status";
  }
  if (blockedBy) reasons.push(blockedBy === "http_status" ? `HTTP ${status}` : `blocked_by_${blockedBy}`);

  const isHtml = /html/i.test(headers.get("content-type") ?? "") || /<html|<body|<div/i.test(body.slice(0, 2000));
  const shellSelector = MOUNTS.find(([, re]) => re.test(body))?.[0] ?? null;
  let isCsrShell = false;
  if (!blockedBy && status !== null && status < 400 && isHtml) {
    const thin = text.length < 300;
    if (thin && shellSelector) reasons.push(`empty_mount_${shellSelector}`);
    if (thin && bundles > 0 && scriptBytes + bundles * 1000 > text.length * 5) reasons.push("script_heavy_thin_text");
    isCsrShell = thin && (!!shellSelector || reasons.includes("script_heavy_thin_text"));
  }
  if (!blockedBy && status !== null && status >= 400) reasons.push(`HTTP ${status}`);
  return {
    isBlocked: !!blockedBy,
    blockedBy,
    isCsrShell,
    tokenCount: Math.ceil(text.length / 4),
    diagnostics: { textChars: text.length, scriptBytes, shellSelector, reasons },
  };
}

// ---------------------------------------------------------------- live probe

export type ProbeResult = ResponseAnalysis & {
  url: string;
  botName: BotName;
  statusCode: number | null;
  bytes: number;
  loadTimeMs: number;
  headers: Record<string, string>;
  finalUrl: string;
  error: string | null;
};

async function readCapped(res: Response): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (bytes < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES)), bytes };
}

export async function probe(url: string, botName: BotName, locale: Locale = DEFAULT_LOCALE): Promise<ProbeResult> {
  const t = serverT(locale);
  const started = performance.now();
  const headers = new Headers();
  let status: number | null = null;
  let body = "";
  let bytes = 0;
  let error: string | null = null;
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await pinnedFetch(current, { // every hop: validated, DNS-pinned connection
        redirect: "manual",
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        headers: { "user-agent": AI_BOTS[botName], accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
        await res.body?.cancel();
        current = new URL(location, current).href;
        continue;
      }
      status = res.status;
      res.headers.forEach((v, k) => headers.set(k, v));
      ({ text: body, bytes } = await readCapped(res));
      break;
    }
  } catch (err) {
    error = err instanceof HttpError ? err.message
      : (err as Error).name === "TimeoutError" ? t("botsim.error.timeout")
      : t("botsim.error.requestFailed", { message: (err as Error).message }).slice(0, 300);
  }
  const analysis = analyzeResponse(status, headers, body);
  if (error) analysis.diagnostics.reasons.push(error);
  return {
    url, botName, statusCode: status, bytes, finalUrl: current, error,
    loadTimeMs: Math.round(performance.now() - started),
    headers: Object.fromEntries(KEEP_HEADERS.filter((h) => headers.has(h)).map((h) => [h, headers.get(h)!.slice(0, 500)])),
    ...analysis,
  };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- API

export const botSimulationInputSchema = z
  .object({
    /** Absolute URLs or paths on the site; default: home page + up to 4 most recently crawled pages. */
    urls: z.array(z.string().trim().min(1).max(2_048)).min(1).max(10).optional(),
    bots: z.array(z.enum(BOT_NAMES)).min(1).max(BOT_NAMES.length).optional(),
    /** Adds the Browser control request (default true). */
    includeBaseline: z.boolean().default(true),
  })
  .strict()
  .default({ includeBaseline: true });

export const botSimulationQuerySchema = z.object({
  runId: z.string().max(64).optional(),
  bot: z.enum(BOT_NAMES).optional(),
  blocked: queryBool.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const hostOf = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, "");

/** Resolves user input against the site and rejects anything outside its host (or subdomains). */
export function resolveSiteUrls(siteUrl: string, urls: string[]): string[] {
  const root = hostOf(siteUrl);
  return [...new Set(urls.map((raw) => {
    let u: URL;
    try {
      u = new URL(raw, siteUrl);
    } catch {
      throw new HttpError(400, `Invalid URL: ${raw}`);
    }
    const h = hostOf(u.href);
    if (!/^https?:$/.test(u.protocol) || (h !== root && !h.endsWith(`.${root}`))) {
      throw new HttpError(400, `URL is not on the tracked site: ${raw}`);
    }
    u.hash = "";
    return u.href;
  }))];
}

type Row = { url: string; botName: string; statusCode: number | null; isBlocked: boolean; blockedBy: string | null; isCsrShell: boolean; tokenCount: number; loadTimeMs: number };

/** Per-bot verdicts + bot-only blocks (bot blocked where the Browser control got through). */
export function summarizeRun(rows: Row[]) {
  const bots = [...new Set(rows.map((r) => r.botName))];
  const perBot = bots.map((botName) => {
    const mine = rows.filter((r) => r.botName === botName);
    return {
      botName,
      checked: mine.length,
      blocked: mine.filter((r) => r.isBlocked).length,
      csrShells: mine.filter((r) => r.isCsrShell).length,
      ok: mine.filter((r) => !r.isBlocked && !r.isCsrShell && r.statusCode !== null && r.statusCode < 400).length,
      avgTokens: mine.length ? Math.round(mine.reduce((n, r) => n + r.tokenCount, 0) / mine.length) : 0,
      avgLoadTimeMs: mine.length ? Math.round(mine.reduce((n, r) => n + r.loadTimeMs, 0) / mine.length) : 0,
      blockedBy: [...new Set(mine.map((r) => r.blockedBy).filter(Boolean))],
    };
  });
  const browserOk = new Set(rows.filter((r) => r.botName === "Browser" && !r.isBlocked).map((r) => r.url));
  const botOnlyBlocks = rows
    .filter((r) => r.botName !== "Browser" && r.isBlocked && browserOk.has(r.url))
    .map((r) => ({ url: r.url, botName: r.botName, statusCode: r.statusCode, blockedBy: r.blockedBy }));
  return { perBot, botOnlyBlocks, csrShellUrls: [...new Set(rows.filter((r) => r.isCsrShell).map((r) => r.url))] };
}

// ponytail: one simulation per site per Node process; use a shared lock before multi-replica deployment.
const running = new Set<string>();

export async function runBotSimulation(siteId: string, input: z.infer<typeof botSimulationInputSchema>, locale: Locale = DEFAULT_LOCALE) {
  const site = await getSiteOrThrow(siteId);
  let urls = input.urls;
  if (!urls) {
    const pages = await prisma.crawledPage.findMany({
      where: { siteId, statusCode: { gte: 200, lt: 300 } },
      orderBy: [{ crawledAt: "desc" }, { depth: "asc" }],
      take: 4,
      select: { url: true },
    });
    urls = [site.url, ...pages.map((p) => p.url)];
  }
  const targets = resolveSiteUrls(site.url, urls).slice(0, 10);
  const bots = [...new Set([...(input.bots ?? DEFAULT_BOTS), ...(input.includeBaseline ? (["Browser"] as BotName[]) : [])])];
  if (running.has(siteId)) throw new HttpError(409, "A bot simulation is already running for this site");
  running.add(siteId);
  try {
    const runId = randomUUID();
    const tasks = targets.flatMap((url) => bots.map((botName) => ({ url, botName })));
    const results = await pool(tasks, CONCURRENCY, (task) => probe(task.url, task.botName, locale));
    const checkedAt = new Date();
    await prisma.botSimulationRecord.createMany({
      data: results.map((r) => ({
        siteId, runId, checkedAt,
        url: r.url, botName: r.botName, statusCode: r.statusCode,
        isBlocked: r.isBlocked, blockedBy: r.blockedBy, isCsrShell: r.isCsrShell,
        tokenCount: r.tokenCount, bytes: r.bytes, loadTimeMs: r.loadTimeMs,
        headers: r.headers as Prisma.InputJsonValue,
        diagnostics: { ...r.diagnostics, finalUrl: r.finalUrl, error: r.error } as Prisma.InputJsonValue,
      })),
    });
    const records = await prisma.botSimulationRecord.findMany({ where: { siteId, runId }, orderBy: [{ url: "asc" }, { botName: "asc" }] });
    return { runId, checkedAt, urls: targets, bots, summary: summarizeRun(records), records };
  } finally {
    running.delete(siteId);
  }
}

/** Latest (or a given) run's summary and the matching records, newest first. */
export async function listBotSimulations(siteId: string, q: z.infer<typeof botSimulationQuerySchema>) {
  await getSiteOrThrow(siteId);
  const runId = q.runId ?? (await prisma.botSimulationRecord.findFirst({ where: { siteId }, orderBy: { checkedAt: "desc" }, select: { runId: true } }))?.runId;
  if (!runId) return { runId: null, checkedAt: null, summary: null, items: [], total: 0 };
  const where: Prisma.BotSimulationRecordWhereInput = {
    siteId, runId,
    ...(q.bot ? { botName: q.bot } : {}),
    ...(q.blocked !== undefined ? { isBlocked: q.blocked } : {}),
  };
  const [all, items, total] = await Promise.all([
    prisma.botSimulationRecord.findMany({ where: { siteId, runId } }),
    prisma.botSimulationRecord.findMany({ where, orderBy: [{ url: "asc" }, { botName: "asc" }], take: q.limit, skip: q.offset }),
    prisma.botSimulationRecord.count({ where }),
  ]);
  if (!all.length) return { runId, checkedAt: null, summary: null, items: [], total: 0 };
  return { runId, checkedAt: all[0].checkedAt, summary: summarizeRun(all), items, total };
}
