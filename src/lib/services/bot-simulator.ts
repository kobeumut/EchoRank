// Live AI crawler simulation for the web app. Mirrors services/crawler `geo_crawler.scoring.bot_simulator`
// (same bot identities, WAF/challenge signatures, render + token analysis, fix recipes and snake_case report shape),
// so an on-demand run from the API and the crawler's audit run are interchangeable.
//
// robots.txt permission is not access: Cloudflare/Imperva/Akamai/AWS WAF challenges, UA rules and client-side
// rendering silently hand AI crawlers a 403/503, an interstitial or an empty <div id="root">. Requests are made
// from this server, not the vendors' IP ranges — WAFs that verify bots by IP may treat real crawlers differently.
//
// All human-readable text (protection names, evidence, reasons, findings, caveats and the comments inside the generated
// fix recipes) is resolved through the `botsim.*` message catalog in the requested `locale` (default English). Report
// field names, enum values and vendor / finding ids are language-independent. A stored report keeps the language it was
// generated in.
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { prisma } from "../db";
import { fetchPublic } from "../distribution/net";
import { HttpError } from "../http";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { serverT } from "../i18n/request";
import type { Translator } from "../i18n/translate";
import { getSiteOrThrow } from "./sites";

export const SIMULATOR_VERSION = "1.0";
export const TOKENIZER = "cl100k_base";
const MAX_BODY_BYTES = 5_000_000;

// ---------------------------------------------------------------- bot identities

export type BotProfile = {
  token: string; // robots.txt product token
  vendor: string;
  purpose: "training" | "search" | "user";
  userAgent: string;
  crawler: string; // name inside the User-Agent (differs for robots-only tokens)
  /** robots.txt-only token without its own fetcher: the report explains which crawler really fetches the content. */
  robotsOnly?: boolean;
};

const GOOGLEBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.6778.204 Safari/537.36";
const APPLEBOT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)";

const PROFILES: BotProfile[] = [
  { token: "GPTBot", vendor: "OpenAI", purpose: "training", crawler: "GPTBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)" },
  { token: "OAI-SearchBot", vendor: "OpenAI", purpose: "search", crawler: "OAI-SearchBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot" },
  { token: "ChatGPT-User", vendor: "OpenAI", purpose: "user", crawler: "ChatGPT-User",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" },
  { token: "ClaudeBot", vendor: "Anthropic", purpose: "training", crawler: "ClaudeBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { token: "Claude-User", vendor: "Anthropic", purpose: "user", crawler: "Claude-User",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)" },
  { token: "PerplexityBot", vendor: "Perplexity", purpose: "search", crawler: "PerplexityBot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
  { token: "Perplexity-User", vendor: "Perplexity", purpose: "user", crawler: "Perplexity-User",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)" },
  { token: "Google-Extended", vendor: "Google", purpose: "training", crawler: "Googlebot", userAgent: GOOGLEBOT_UA, robotsOnly: true },
  { token: "Applebot-Extended", vendor: "Apple", purpose: "training", crawler: "Applebot", userAgent: APPLEBOT_UA, robotsOnly: true },
];
export const BOT_PROFILES: Record<string, BotProfile> = Object.fromEntries(PROFILES.map((p) => [p.token, p]));
export const BOT_TOKENS = PROFILES.map((p) => p.token) as [string, ...string[]];
export const DEFAULT_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"];

const BOT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7";
// Baseline browser identity of the simulation. The Turkish-first Accept-Language mirrors the Python simulator (request data,
// not UI text) so both produce comparable baselines; bots send no Accept-Language at all.
export const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "accept-encoding": "gzip, deflate",
};

/** Crawlers send no cookies, client hints or Accept-Language. */
export function botHeaders(p: BotProfile): Record<string, string> {
  return { "user-agent": p.userAgent, accept: BOT_ACCEPT, "accept-encoding": "gzip, deflate" };
}

// ---------------------------------------------------------------- WAF / bot-protection detection

export type Protection = { vendor: string; kind: "challenge" | "captcha" | "block" | "rate_limit"; name: string; evidence: string[] };
type HeaderMap = Record<string, string>;

const KEPT_HEADERS = new Set([
  "server", "content-type", "content-encoding", "content-length", "location", "retry-after", "x-robots-tag",
  "cf-ray", "cf-mitigated", "cf-cache-status", "x-vercel-id", "x-vercel-mitigated", "x-amzn-waf-action",
  "x-amz-cf-id", "x-amz-cf-pop", "x-iinfo", "x-cdn", "x-sucuri-id", "x-datadome", "akamai-grn", "x-cache", "via",
]);

const FINGERPRINTS: [string, string, RegExp | null][] = [
  ["cloudflare", "cf-ray", null], ["cloudflare", "server", /cloudflare/i],
  ["vercel", "x-vercel-id", null], ["vercel", "server", /^vercel/i],
  ["aws_waf", "x-amzn-waf-action", null], ["aws_waf", "x-amz-cf-id", null], ["aws_waf", "server", /cloudfront|awselb/i],
  ["imperva", "x-iinfo", null], ["imperva", "x-cdn", /incapsula|imperva/i],
  ["akamai", "akamai-grn", null], ["akamai", "server", /akamai/i],
  ["sucuri", "x-sucuri-id", null], ["sucuri", "server", /sucuri/i],
  ["datadome", "x-datadome", null], ["datadome", "server", /datadome/i],
];

/** `name` is a vendor / product name, or a `botsim.protection.*` catalog key. */
type Sig = [vendor: string, kind: Protection["kind"], name: string, rx: RegExp];
// Strong markers only occur on interstitial / block pages.
const STRONG_BODY: Sig[] = [
  ["cloudflare", "rate_limit", "botsim.protection.cf1015", /error code:?\s*1015|you are being rate limited/],
  ["cloudflare", "challenge", "Cloudflare Challenge", /_cf_chl_opt|\/cdn-cgi\/challenge-platform\/|cf-chl-widget|<title>\s*just a moment\.\.\.\s*<\/title>/],
  ["cloudflare", "block", "botsim.protection.cfBlock", /attention required! \| cloudflare|sorry, you have been blocked|cf-error-details|error code:?\s*10(?:0\d|1\d|20)\b/],
  ["vercel", "challenge", "Vercel Security Checkpoint", /vercel security checkpoint/],
  ["imperva", "block", "botsim.protection.imperva", /incapsula incident id|_incapsula_resource/],
  ["akamai", "block", "botsim.protection.akamai", /errors\.edgesuite\.net|reference\s*(?:&#32;)?(?:#|&#35;)\s*\d+\.[0-9a-f]+\.\d+/],
  ["aws_waf", "challenge", "AWS WAF Challenge/CAPTCHA", /awswaf|aws-waf-token|gokuprops/],
  ["aws_waf", "block", "botsim.protection.awsBlock", /generated by cloudfront \(cloudfront\)/],
  ["datadome", "captcha", "DataDome CAPTCHA", /captcha-delivery\.com/],
  ["perimeterx", "captcha", "HUMAN (PerimeterX) CAPTCHA", /px-captcha|_pxappid|perimeterx/],
  ["sucuri", "block", "botsim.protection.sucuri", /sucuri website firewall|access denied - sucuri/],
  ["ddos-guard", "challenge", "DDoS-Guard Challenge", /ddos-guard/],
];
// Weak markers also appear on normal pages (contact-form CAPTCHAs, copy): interstitial-like pages only.
const WEAK_BODY: Sig[] = [
  ["cloudflare", "captcha", "Cloudflare Turnstile", /challenges\.cloudflare\.com\/turnstile|cf-turnstile/],
  ["unknown", "captcha", "hCaptcha", /hcaptcha\.com\/1\/api\.js|class=["']h-captcha/],
  ["unknown", "captcha", "Google reCAPTCHA", /google\.com\/recaptcha|class=["']g-recaptcha/],
  ["unknown", "block", "botsim.protection.genericBlock", /access denied|bot detected|are you a robot|unusual traffic|verify you are (?:a )?human|enable javascript and cookies to continue/],
];

/** Catalog keys sit in the static signature / marker tables below; plain strings there are vendor or product names. */
const label = (t: Translator, name: string) => (name.startsWith("botsim.") ? t(name) : name);

const lowerKeys = (h: HeaderMap): HeaderMap => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** CDN / WAF vendor in front of the site (null = not recognised). */
export function fingerprint(headers: HeaderMap): string | null {
  const h = lowerKeys(headers);
  for (const [vendor, name, rx] of FINGERPRINTS) if (name in h && (!rx || rx.test(h[name]))) return vendor;
  return null;
}

const TAG_RX = /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<[^>]+>/gi;
export const visibleWords = (body: string) => body.slice(0, 300_000).replace(TAG_RX, " ").split(/\s+/).filter(Boolean).length;

function cfChallengeName(low: string): string {
  const ctype = /ctype\s*:\s*['"]([\w-]+)['"]/.exec(low)?.[1] ?? "";
  if (low.includes("turnstile") && ctype !== "managed" && ctype !== "non-interactive") return "Cloudflare Turnstile";
  return ({ managed: "Cloudflare Managed Challenge", "non-interactive": "Cloudflare JS Challenge",
    interactive: "Cloudflare Interactive Challenge" } as Record<string, string>)[ctype] ?? "Cloudflare Managed Challenge";
}

/** Bot-protection verdict for one response, or null when it is a normal page. Names and evidence are in `locale`. */
export function detectProtection(status: number | null, headers: HeaderMap, body: string, locale: Locale = DEFAULT_LOCALE): Protection | null {
  const t = serverT(locale);
  const h = lowerKeys(headers);
  const low = body.slice(0, 300_000).toLowerCase();
  const vendor = fingerprint(h) ?? "unknown";

  const mitigated = (h["cf-mitigated"] ?? "").toLowerCase();
  if (mitigated) return { vendor: "cloudflare", kind: "challenge", name: cfChallengeName(low), evidence: [`cf-mitigated: ${mitigated}`] };
  const vercel = (h["x-vercel-mitigated"] ?? "").toLowerCase();
  if (vercel)
    return { vendor: "vercel", kind: vercel === "deny" ? "block" : "challenge", name: `Vercel Firewall (${vercel})`, evidence: [`x-vercel-mitigated: ${vercel}`] };
  const wafAction = (h["x-amzn-waf-action"] ?? "").toLowerCase();
  if (wafAction) {
    const kind = wafAction === "captcha" ? "captcha" : wafAction === "challenge" ? "challenge" : "block";
    return { vendor: "aws_waf", kind, name: `AWS WAF ${wafAction.toUpperCase()}`, evidence: [`x-amzn-waf-action: ${wafAction}`] };
  }
  for (const [v, kind, name, rx] of STRONG_BODY) {
    const m = rx.exec(low);
    if (!m) continue;
    if (v === "aws_waf" && kind === "block" && (status ?? 0) < 400) continue;
    return {
      vendor: v, kind, name: v === "cloudflare" && kind === "challenge" ? cfChallengeName(low) : label(t, name),
      evidence: [t("botsim.evidence.body", { match: m[0].slice(0, 60) })],
    };
  }
  const interstitial = (status !== null && status >= 400) || visibleWords(body) < 150;
  if (interstitial)
    for (const [v, kind, name, rx] of WEAK_BODY) {
      const m = rx.exec(low);
      if (m) return { vendor: v === "unknown" ? vendor : v, kind, name: label(t, name), evidence: [t("botsim.evidence.body", { match: m[0].slice(0, 60) })] };
    }
  if (status === 429) {
    const retry = h["retry-after"];
    return { vendor, kind: "rate_limit", name: t("botsim.protection.http429"), evidence: [`HTTP 429${retry ? `, Retry-After: ${retry}` : ""}`] };
  }
  if (status !== null && [401, 403, 406, 451, 503].includes(status))
    return {
      vendor, kind: "block",
      name: t("botsim.protection.httpBlock", { vendor: vendor === "unknown" ? t("botsim.protection.serverWaf") : vendor, status }),
      evidence: [`HTTP ${status}`],
    };
  return null;
}

// ---------------------------------------------------------------- token weight

const PRETOKEN = /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}_]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}_]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

/**
 * cl100k_base (GPT-4) token estimate without BPE tables: the same linear model over pre-tokenizer chunks as the
 * Python simulator, fitted against tiktoken on HTML / Markdown / JSON / Turkish / English (max error ~12%).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let short = 0, longChars = 0, nonAscii = 0, digits = 0, punct = 0, ws = 0;
  for (const m of text.matchAll(PRETOKEN)) {
    const s = m[0].trim();
    if (!s) {
      ws++;
      continue;
    }
    const core = s.replace(/^[^\p{L}\p{N}_]/u, "");
    if (core && /\p{L}$/u.test(core)) {
      if (!isAscii(core)) nonAscii += [...core].length;
      else if (core.length <= 7) short++;
      else longChars += core.length;
    } else if (/^\p{N}+$/u.test(s)) digits++;
    else punct += [...s].length;
  }
  return Math.ceil(0.985 * short + 0.23 * longChars + 0.695 * nonAscii + 1.351 * digits + 0.516 * punct + 0.683 * ws);
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** 0-100: share of HTML tokens that are readable text (10%+ = full marks) minus size / compression penalties. */
export function tokenEfficiency(signalRatio: number, htmlBytes: number, compressed: boolean): number {
  const r = Math.max(signalRatio, 1e-4);
  let score = clamp(40 + (60 * (Math.log10(r) - Math.log10(0.01))) / (Math.log10(0.1) - Math.log10(0.01)));
  if (!compressed && htmlBytes > 20_000) score -= 15;
  if (htmlBytes > 2_000_000) score -= 20;
  else if (htmlBytes > 1_000_000) score -= 10;
  return clamp(score);
}

// ---------------------------------------------------------------- render integrity

const SPA_ROOT_IDS = ["root", "app", "__next", "__nuxt", "___gatsby", "svelte", "main-app", "q-app"];
const HYDRATION_MARKERS: [string, string][] = [
  ["__NEXT_DATA__", "nextjs"], ["self.__next_f", "nextjs-app"], ["__NUXT__", "nuxt"], ["ng-version", "angular"],
  ["data-reactroot", "react"], ["data-server-rendered", "vue-ssr"], ["__remixContext", "remix"],
  ["data-sveltekit", "sveltekit"], ["astro-island", "astro"],
];
// Functional language data: recognises "enable JavaScript" notices on English and Turkish sites, so the Turkish words
// (etkinleştir / açın / aktif = enable / open / active, gerekli = required) must stay.
const NOSCRIPT_JS = /(enable|etkinleştir|açın|aktif).{0,40}javascript|javascript.{0,40}(required|gerekli|enable|etkinleştir|açın|aktif)/i;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));
const dropBlocks = (html: string, tags: string[]) =>
  tags.reduce((s, t) => s.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, "gi"), " "), html.replace(/<!--[\s\S]*?-->/g, " "));
const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Inner HTML of the first element matching `openRx` (balanced on its tag name). */
function innerOf(html: string, openRx: RegExp): string | null {
  const m = openRx.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  const rx = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  rx.lastIndex = start;
  let depth = 1;
  for (let t = rx.exec(html); t; t = rx.exec(html)) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return html.slice(start);
}

export type RenderView = {
  mode: "static" | "ssr_hydrated" | "heavy_js" | "thin" | "csr_shell";
  score: number;
  reason: string;
  word_count: number;
  title: string;
  h1: string;
  frameworks: string[];
  spa_root: { id: string; empty: boolean } | null;
  script_tags: number;
  external_scripts: number;
  noscript_requires_js: boolean;
  text_ratio: number;
};

/** Port of the crawler's `classify_render` over the raw HTML a crawler received. `reason` is in `locale`. */
export function analyzeRender(html: string, locale: Locale = DEFAULT_LOCALE): RenderView & { text: string } {
  const t = serverT(locale);
  const htmlBytes = Buffer.byteLength(html);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const external = scripts.filter((s) => /\bsrc\s*=/i.test(s[1])).length;
  const inlineBytes = scripts
    .filter((s) => !/\bsrc\s*=/i.test(s[1]) && !/ld\+json/i.test(s[1]))
    .reduce((n, s) => n + Buffer.byteLength(s[2]), 0);
  let spaRoot: RenderView["spa_root"] = null;
  for (const id of SPA_ROOT_IDS) {
    const inner = innerOf(html, new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, "i"));
    if (inner !== null) {
      spaRoot = { id, empty: textOf(dropBlocks(inner, ["script", "style", "noscript", "template", "svg"])).split(" ").filter(Boolean).length < 20 };
      break;
    }
  }
  const hydration = [...new Set(HYDRATION_MARKERS.filter(([m]) => html.includes(m)).map(([, n]) => n))].sort();
  const noscript = [...html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)].map((m) => textOf(m[1])).join(" ");
  const title = textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const h1 = textOf(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").slice(0, 200);
  const bodyHtml = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = textOf(dropBlocks(bodyHtml, ["script", "style", "noscript", "template", "svg", "iframe", "nav", "header", "footer", "aside"]));
  const words = text ? text.split(" ").length : 0;
  const textRatio = htmlBytes ? Math.round((Buffer.byteLength(text) / htmlBytes) * 10_000) / 10_000 : 0;

  const scriptHeavy = scripts.length >= 3 || inlineBytes > 20_000;
  let mode: RenderView["mode"], score: number, reason: string;
  if (words < 50 && (spaRoot?.empty || scriptHeavy)) {
    [mode, score] = ["csr_shell", 0];
    reason = spaRoot?.empty
      ? t("botsim.render.csrShellRoot", { id: spaRoot.id, count: words })
      : t("botsim.render.csrShell", { count: words });
  } else if (words < 50) [mode, score, reason] = ["thin", 40, t("botsim.render.thin", { count: words })];
  else if (textRatio < 0.02 && words < 200)
    [mode, score, reason] = ["heavy_js", 70, t("botsim.render.heavyJs", { pct: (textRatio * 100).toFixed(1) })];
  else if (hydration.length) [mode, score, reason] = ["ssr_hydrated", 100, t("botsim.render.hydrated", { frameworks: hydration.join(", ") })];
  else [mode, score, reason] = ["static", 100, t("botsim.render.static")];
  return {
    mode, score, reason, word_count: words, title, h1, frameworks: hydration, spa_root: spaRoot,
    script_tags: scripts.length, external_scripts: external, noscript_requires_js: NOSCRIPT_JS.test(noscript),
    text_ratio: textRatio, text,
  };
}

// ---------------------------------------------------------------- page bloat

// [marker in the inline script, label] — a label is a product name or a `botsim.bloat.*` catalog key.
const STATE_MARKERS: [string, string][] = [
  ["self.__next_f.push", "botsim.bloat.nextRsc"], ["window.__NUXT__", "Nuxt state"], ["__NUXT_DATA__", "Nuxt state"],
  ["__INITIAL_STATE__", "__INITIAL_STATE__"], ["__PRELOADED_STATE__", "Redux state"],
  ["__APOLLO_STATE__", "Apollo cache"], ["__remixContext", "Remix context"], ["window.__data", "window.__data"],
];
export const DOM_NODES_WARN = 1500;
export const DOM_DEPTH_WARN = 32;
const JSON_STATE_WARN = 100_000;

export type BloatView = {
  dom_nodes: number;
  dom_depth: number;
  json_state_bytes: number;
  json_state: { kind: string; bytes: number }[];
  ld_json_bytes: number;
  inline_script_bytes: number;
  inline_css_bytes: number;
  inline_svg_bytes: number;
  data_uri_bytes: number;
  issues: string[];
};

/** DOM / embedded-state weight of a page. `json_state[].kind` labels and `issues` are in `locale`. */
export function analyzeBloat(html: string, locale: Locale = DEFAULT_LOCALE): BloatView {
  const t = serverT(locale);
  const htmlBytes = Buffer.byteLength(html);
  // element count / nesting on markup with raw-text element bodies blanked
  const markup = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|textarea)\b([^>]*)>[\s\S]*?<\/\1>/gi, "<$1$2></$1>");
  let nodes = 0, depth = 0, maxDepth = 0;
  const stack: string[] = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    const name = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      depth = stack.length;
      continue;
    }
    nodes++;
    maxDepth = Math.max(maxDepth, depth + 1);
    if (!VOID.has(name) && !m[3]) {
      stack.push(name);
      depth = stack.length;
    }
  }
  const merged = new Map<string, number>();
  let ld = 0, inlineJs = 0;
  for (const s of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = s[1];
    const size = Buffer.byteLength(s[2]);
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "").toLowerCase();
    if (type.includes("ld+json")) ld += size;
    else if (type.includes("json")) {
      const kind = /\bid\s*=\s*["']__NEXT_DATA__["']/i.test(attrs) ? "__NEXT_DATA__" : `<script type=${type}>`;
      merged.set(kind, (merged.get(kind) ?? 0) + size);
    } else if (!/\bsrc\s*=/i.test(attrs)) {
      const marker = STATE_MARKERS.find(([m]) => s[2].slice(0, 2000).includes(m))?.[1];
      const stateKind = marker && label(t, marker);
      if (stateKind) merged.set(stateKind, (merged.get(stateKind) ?? 0) + size);
      else inlineJs += size;
    }
  }
  const stateBytes = [...merged.values()].reduce((a, b) => a + b, 0);
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].reduce((n, m) => n + Buffer.byteLength(m[1]), 0);
  const svg = [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].reduce((n, m) => n + Buffer.byteLength(m[0]), 0);
  const dataUri = [...html.matchAll(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{200,}/g)].reduce((n, m) => n + m[0].length, 0);
  const json_state = [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([kind, bytes]) => ({ kind, bytes }));

  const issues: string[] = [];
  const kb = (bytes: number) => Math.floor(bytes / 1024);
  if (nodes > DOM_NODES_WARN) issues.push(t("botsim.bloat.domNodes", { nodes, limit: DOM_NODES_WARN }));
  if (maxDepth > DOM_DEPTH_WARN) issues.push(t("botsim.bloat.domDepth", { depth: maxDepth, limit: DOM_DEPTH_WARN }));
  if (stateBytes > JSON_STATE_WARN || (htmlBytes && stateBytes / htmlBytes > 0.4 && stateBytes > 20_000))
    issues.push(t("botsim.bloat.jsonState", {
      kb: kb(stateBytes), pct: Math.floor((100 * stateBytes) / Math.max(htmlBytes, 1)), kind: json_state[0].kind,
    }));
  if (css > 150_000) issues.push(t("botsim.bloat.inlineCss", { kb: kb(css) }));
  if (svg > 150_000) issues.push(t("botsim.bloat.inlineSvg", { kb: kb(svg) }));
  if (dataUri > 100_000) issues.push(t("botsim.bloat.dataUri", { kb: kb(dataUri) }));
  if (inlineJs > 200_000) issues.push(t("botsim.bloat.inlineJs", { kb: kb(inlineJs) }));
  return {
    dom_nodes: nodes, dom_depth: maxDepth, json_state_bytes: stateBytes, json_state, ld_json_bytes: ld,
    inline_script_bytes: inlineJs, inline_css_bytes: css, inline_svg_bytes: svg, data_uri_bytes: dataUri, issues,
  };
}

// ---------------------------------------------------------------- robots.txt (RFC 9309, longest match)

type RobotsGroup = { agents: string[]; rules: [boolean, string][] };

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase().split("/")[0].trim());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((key === "allow" || key === "disallow") && current && !(key === "disallow" && !value)) current.rules.push([key === "allow", value]);
  }
  return groups;
}

export function robotsAllows(groups: RobotsGroup[], token: string, url: string): boolean {
  const t = token.toLowerCase();
  const exact = groups.filter((g) => g.agents.includes(t));
  const rules = (exact.length ? exact : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let path = url;
  try {
    const u = new URL(url);
    path = (u.pathname || "/") + u.search;
  } catch {
    /* already a path */
  }
  if (path === "/robots.txt") return true;
  let best = -1, allow = true;
  for (const [isAllow, raw] of rules) {
    const pattern = raw.startsWith("/") || raw.startsWith("*") ? raw : `/${raw}`;
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const rx = new RegExp(`^${body.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
    if (rx.test(path) && (pattern.length > best || (pattern.length === best && isAllow))) [best, allow] = [pattern.length, isAllow];
  }
  return allow;
}

// ---------------------------------------------------------------- fix recipes

export type Fix = {
  id: string;
  platform: string;
  title: string;
  language: string;
  code: string;
  instructions: string;
  recommended: boolean;
  preventive: boolean;
};

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Next.js server-rendering example for the CSR finding; the explanatory comments are in `locale`. */
export function ssrFix(exampleUrl: string, locale: Locale = DEFAULT_LOCALE): string {
  const t = serverT(locale);
  return `// ${t("botsim.fix.ssr.intro", { url: exampleUrl })}
// ${t("botsim.fix.ssr.next")}
export const revalidate = 3600; // ${t("botsim.fix.ssr.isr")}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getData(slug); // ${t("botsim.fix.ssr.fetch")}
  return (
    <article>
      <h1>{data.title}</h1>
      <p>{data.summary}</p>
    </article>
  );
}
// ${t("botsim.fix.ssr.spa")}`;
}

/**
 * Copy-paste allow rules for `bots` (the refused ones; every simulated bot when `preventive`). Titles, instructions and
 * the comments inside the generated snippets are in `locale`; the configuration itself is language-independent.
 */
export function buildFixes(
  bots: BotProfile[],
  vendors: string[] = [],
  csrUrls: string[] = [],
  bloat = false,
  preventive = false,
  locale: Locale = DEFAULT_LOCALE,
): Fix[] {
  const t = serverT(locale);
  const crawlers = [...new Set(bots.map((b) => b.crawler))];
  const alt = crawlers.map(escapeRx).join("|");
  const fixes: Fix[] = [];
  const add = (id: string, platform: string, title: string, language: string, code: string, instructions: string) =>
    fixes.push({ id, platform, title, language, code: code.trim(), instructions, recommended: vendors.includes(platform), preventive });

  if (crawlers.length) {
    const expr = `${crawlers.map((c) => `(http.user_agent contains "${c}")`).join(" or ")} or (cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant"})`;
    const rule = {
      description: "Allow AI crawlers (GEO)", expression: expr, action: "skip",
      action_parameters: {
        ruleset: "current",
        phases: ["http_ratelimit", "http_request_firewall_managed", "http_request_sbfm"],
        products: ["bic", "hot", "rateLimit", "securityLevel", "uaBlock", "waf", "zoneLockdown"],
      },
      logging: { enabled: true },
    };
    add("cloudflare_waf_skip", "cloudflare", t("botsim.fix.cf.title"), "text", `
# ${t("botsim.fix.cf.where")}
# Rule name: Allow AI crawlers (GEO)
# Expression (Edit expression):
${expr}
# Action: Skip → All remaining custom rules, Rate limiting rules, Managed rules, Super Bot Fight Mode rules
#         ${t("botsim.fix.cf.logOn")}

# ${t("botsim.fix.cf.strict")}
(cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant"}) or (cf.client.bot)

# ${t("botsim.fix.cf.also1")}
# ${t("botsim.fix.cf.also2")}

# Rulesets API (PUT /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint → rules[0]):
${JSON.stringify(rule, null, 2)}`,
      t("botsim.fix.cf.instructions"));

    add("nginx_allow", "nginx", t("botsim.fix.nginx.title"), "nginx", `
# ${t("botsim.fix.nginx.http")}
map $http_user_agent $is_ai_bot {
    default 0;
    "~*(${alt})" 1;   # ${crawlers.map((c) => `"${c}"`).join(" ")}
}
# ${t("botsim.fix.nginx.limitKey")}
map $is_ai_bot $ai_limit_key {
    0 $binary_remote_addr;
    1 "";
}
limit_req_zone $ai_limit_key zone=perip:10m rate=10r/s;

# ${t("botsim.fix.nginx.server")}
set $block_ua 0;
if ($http_user_agent ~* "(bot|crawl|spider|scrape)") { set $block_ua 1; }   # ${t("botsim.fix.nginx.existing")}
if ($is_ai_bot = 1) { set $block_ua 0; }
if ($block_ua = 1) { return 403; }`,
      t("botsim.fix.nginx.instructions"));

    add("apache_allow", "apache", t("botsim.fix.apache.title"), "apache", `
# ${t("botsim.fix.apache.mark")}
SetEnvIfNoCase User-Agent "(${alt})" ai_bot

# ${t("botsim.fix.apache.step1")}
RewriteEngine On
RewriteCond %{ENV:ai_bot} !^1$
RewriteCond %{HTTP_USER_AGENT} (bot|crawl|spider|scrape) [NC]
RewriteRule .* - [F,L]

# ${t("botsim.fix.apache.step2")}
<RequireAny>
    Require env ai_bot
    Require all granted
</RequireAny>

# ${t("botsim.fix.apache.step3")}
<IfModule mod_security2.c>
    SecRule REQUEST_HEADERS:User-Agent "@rx (?i)(${alt})" \\
        "id:1009001,phase:1,pass,nolog,ctl:ruleRemoveByTag=attack-reputation-scanner"
</IfModule>`,
      t("botsim.fix.apache.instructions"));

    if (vendors.includes("aws_waf")) {
      const awsRule = {
        Name: "allow-ai-crawlers", Priority: 0,
        Statement: { RegexMatchStatement: { RegexString: `(?i)(${alt})`, FieldToMatch: { SingleHeader: { Name: "user-agent" } },
          TextTransformations: [{ Priority: 0, Type: "NONE" }] } },
        Action: { Allow: {} },
        VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: "allow-ai-crawlers" },
      };
      add("aws_waf_allow", "aws_waf", t("botsim.fix.aws.title"), "json",
        JSON.stringify({ Rules: [awsRule], BotControlOverride: { ManagedRuleGroupStatement: { VendorName: "AWS",
          Name: "AWSManagedRulesBotControlRuleSet", RuleActionOverrides: [{ Name: "CategoryAI", ActionToUse: { Count: {} } }] } } }, null, 2),
        t("botsim.fix.aws.instructions"));
    }
  }

  const list = crawlers.join(", ");
  // Vendor consoles without a copy-paste config: [title, step-by-step instructions]
  const consoles: Record<string, [string, string]> = {
    akamai: [t("botsim.fix.akamai.title"), t("botsim.fix.akamai.instructions", { alt })],
    imperva: [t("botsim.fix.imperva.title"), t("botsim.fix.imperva.instructions")],
    vercel: [t("botsim.fix.vercel.title"), t("botsim.fix.vercel.instructions", { alt })],
    sucuri: [t("botsim.fix.sucuri.title"), t("botsim.fix.sucuri.instructions", { list })],
    datadome: [t("botsim.fix.datadome.title"), t("botsim.fix.datadome.instructions", { list })],
    perimeterx: [t("botsim.fix.perimeterx.title"), t("botsim.fix.perimeterx.instructions", { list })],
  };
  for (const v of vendors)
    if (consoles[v] && crawlers.length)
      add(`${v}_console`, v, consoles[v][0], "text", consoles[v][1], t("botsim.fix.console.instructions"));

  if (csrUrls.length)
    add("ssr_render", "nextjs", t("botsim.fix.ssr.title"), "tsx", ssrFix(csrUrls[0], locale), t("botsim.fix.ssr.instructions"));
  if (bloat)
    add("token_diet", "web", t("botsim.fix.diet.title"), "text", `
# ${t("botsim.fix.diet.stateHeading")}
#  - ${t("botsim.fix.diet.state1")}
#  - ${t("botsim.fix.diet.state2")}
# ${t("botsim.fix.diet.domHeading")}
#  - ${t("botsim.fix.diet.dom1")}
#  - ${t("botsim.fix.diet.dom2")}
# ${t("botsim.fix.diet.transferHeading")}
#  - ${t("botsim.fix.diet.transfer1")}`,
      t("botsim.fix.diet.instructions"));
  return fixes;
}

// ---------------------------------------------------------------- report schema (snake_case, shared with Python)

const num = z.number().finite();
const protectionSchema = z.object({ vendor: z.string(), kind: z.string(), name: z.string(), evidence: z.array(z.string()).default([]) });
export const botResultSchema = z
  .object({
    token: z.string(),
    vendor: z.string(),
    purpose: z.string(),
    crawler: z.string(),
    user_agent: z.string(),
    url: z.string(),
    outcome: z.enum(["ok", "degraded", "challenge", "blocked", "rate_limited", "not_found", "server_error", "error"]),
    status: z.number().int().nullable(),
    final_url: z.string().default(""),
    protection: protectionSchema.nullable().default(null),
    robots_allowed: z.boolean().nullable().default(null),
    silent_block: z.boolean().default(false),
    general: z.boolean().default(false),
    words: z.number().int().min(0).default(0),
    parity: num.nullable().default(null),
    ttfb_ms: num.nullable().default(null),
    total_ms: num.nullable().default(null),
    html_bytes: z.number().int().min(0).default(0),
    wire_bytes: z.number().int().min(0).default(0),
    content_encoding: z.string().default(""),
    error: z.string().nullable().default(null),
    note: z.string().default(""),
    accessible: z.boolean(),
    reason: z.string(),
    label: z.string().optional(),
  })
  .passthrough();

const viewSchema = z
  .object({
    source: z.string(),
    render: z.object({ mode: z.string(), score: num, reason: z.string(), word_count: z.number().int() }).passthrough(),
    tokens: z
      .object({
        method: z.string(), html_tokens: z.number().int(), text_tokens: z.number().int(), signal_ratio: num,
        html_kb: num, transfer_kb: num, compressed: z.boolean(), score: num,
      })
      .passthrough(),
    bloat: z.object({ dom_nodes: z.number().int(), json_state_bytes: z.number().int(), issues: z.array(z.string()) }).passthrough(),
  })
  .passthrough();

export const botSimulationReportSchema = z
  .object({
    version: z.string().max(20).default(SIMULATOR_VERSION),
    generated_at: z.string(),
    origin: z.string(),
    bots: z.array(z.string()).max(20),
    robots_status: z.number().int().nullable().default(null),
    score: num.min(0).max(100),
    grade: z.string().max(2),
    scores: z.object({ access: num, render: num.nullable(), tokens: num.nullable() }),
    blocked_bots: z.array(z.string()).default([]),
    vendors: z.array(z.string()).default([]),
    pages: z
      .array(
        z.object({
          url: z.string(),
          access_score: num,
          baseline: z.object({ status: z.number().int().nullable(), outcome: z.string(), words: z.number().int(), cdn: z.string().nullable() }).passthrough(),
          results: z.array(botResultSchema),
          ai_view: viewSchema.nullable(),
        }),
      )
      .max(50),
    findings: z.array(
      z.object({ code: z.string(), severity: z.enum(["critical", "warning", "info"]), title: z.string(), detail: z.string(),
        bots: z.array(z.string()).default([]), urls: z.array(z.string()).default([]) }),
    ),
    fixes: z.array(
      z.object({ id: z.string(), platform: z.string(), title: z.string(), language: z.string(), code: z.string(),
        instructions: z.string(), recommended: z.boolean(), preventive: z.boolean() }),
    ),
    caveats: z.array(z.string()).default([]),
  })
  .passthrough();

export type BotResult = z.infer<typeof botResultSchema>;
export type BotSimulationReport = z.infer<typeof botSimulationReportSchema>;
type Page = BotSimulationReport["pages"][number];
type Finding = BotSimulationReport["findings"][number];
type AiView = NonNullable<Page["ai_view"]>;

// ---------------------------------------------------------------- fetching

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type FetchResult = {
  url: string;
  finalUrl: string;
  status: number | null;
  headers: HeaderMap;
  contentEncoding: string;
  wireBytes: number;
  htmlBytes: number;
  truncated: boolean;
  ttfbMs: number | null;
  totalMs: number;
  error: string | null;
  body: string;
};

async function fetchAs(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number, t: Translator): Promise<FetchResult> {
  const res: FetchResult = { url, finalUrl: "", status: null, headers: {}, contentEncoding: "", wireBytes: 0, htmlBytes: 0,
    truncated: false, ttfbMs: null, totalMs: 0, error: null, body: "" };
  const t0 = performance.now();
  try {
    const r = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    res.ttfbMs = Math.round(performance.now() - t0);
    res.status = r.status;
    res.finalUrl = r.url || url;
    r.headers.forEach((v, k) => {
      if (KEPT_HEADERS.has(k.toLowerCase())) res.headers[k.toLowerCase()] = v;
    });
    res.contentEncoding = (r.headers.get("content-encoding") ?? "").toLowerCase();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (r.body) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size >= MAX_BODY_BYTES) {
          res.truncated = true;
          await reader.cancel();
          break;
        }
      }
    }
    const raw = Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES);
    const charset = /charset=([\w-]+)/i.exec(r.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset);
    } catch {
      decoder = new TextDecoder("utf-8");
    }
    res.body = decoder.decode(raw);
    res.htmlBytes = raw.byteLength;
    // fetch() decompresses transparently: Content-Length is the wire size; else estimate with gzip -6
    const len = Number(r.headers.get("content-length") ?? NaN);
    res.wireBytes = Number.isFinite(len) && res.contentEncoding ? len : res.contentEncoding ? gzipSync(raw).byteLength : raw.byteLength;
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    res.error = e.name === "TimeoutError" || e.name === "AbortError" ? t("botsim.error.timeout")
      : /redirect/i.test(e.message ?? "") || /redirect/i.test(e.cause?.message ?? "") ? t("botsim.error.redirectLoop")
      : `${e.cause?.code ?? e.name ?? "Error"}: ${e.cause?.message ?? e.message ?? ""}`.slice(0, 200);
  }
  res.totalMs = Math.round(performance.now() - t0);
  return res;
}

// ---------------------------------------------------------------- per-page analysis

const ACCESS_CREDIT: Record<string, number> = { ok: 1, degraded: 0.5 };
const BLOCKING = new Set(["blocked", "challenge", "rate_limited", "error"]);

function outcomeOf(r: FetchResult, locale: Locale): [BotResult["outcome"], Protection | null] {
  if (r.error) return ["error", null];
  const prot = detectProtection(r.status, r.headers, r.body, locale);
  if (prot) return [prot.kind === "rate_limit" ? "rate_limited" : prot.kind === "block" ? "blocked" : "challenge", prot];
  const st = r.status ?? 0;
  if (st === 404 || st === 410) return ["not_found", null];
  if (st >= 500) return ["server_error", null];
  if (st >= 400) return ["blocked", null];
  return ["ok", null];
}

function analyzeView(r: FetchResult, source: string, locale: Locale): AiView {
  const { text, ...render } = analyzeRender(r.body, locale);
  const htmlTokens = estimateTokens(r.body);
  const textTokens = estimateTokens(text);
  const compressed = ["gzip", "br", "deflate", "zstd"].includes(r.contentEncoding);
  const ratio = htmlTokens ? textTokens / htmlTokens : 0;
  return {
    source,
    render,
    tokens: {
      method: `estimate:${TOKENIZER}`, html_tokens: htmlTokens, text_tokens: textTokens, signal_ratio: Math.round(ratio * 10_000) / 10_000,
      html_kb: Math.round((r.htmlBytes / 1024) * 10) / 10, transfer_kb: Math.round((r.wireBytes / 1024) * 10) / 10,
      content_encoding: r.contentEncoding || null, compressed,
      compression_ratio: compressed && r.htmlBytes ? Math.round((r.wireBytes / r.htmlBytes) * 1000) / 1000 : null,
      truncated: r.truncated, score: Math.round(tokenEfficiency(ratio, r.htmlBytes, compressed)),
    },
    bloat: analyzeBloat(r.body, locale),
  };
}

type ReasonInput = { error: string | null; general: boolean; protection: Protection | null; status: number | null; outcome: string; parity: number | null; words: number };

function botReason(r: ReasonInput, t: Translator): string {
  if (r.error) return r.general ? r.error : t("botsim.reason.errorSilent", { error: r.error });
  if (r.protection) return `${r.protection.name} (HTTP ${r.status})`;
  if (r.outcome === "degraded") return t("botsim.reason.degraded", { pct: Math.round((r.parity ?? 0) * 100), count: r.words });
  return t("botsim.reason.ok", { status: r.status, count: r.words });
}

function findingsOf(pages: Page[], t: Translator): Finding[] {
  const out: Finding[] = [];
  const all = pages.flatMap((p) => p.results.map((r) => ({ p, r })));
  const group = (pred: (r: BotResult) => boolean) => {
    const hits = all.filter(({ r }) => pred(r));
    return { bots: [...new Set(hits.map(({ r }) => r.token))], urls: [...new Set(hits.map(({ p }) => p.url))], rs: hits.map(({ r }) => r) };
  };
  const add = (code: string, severity: Finding["severity"], title: string, detail: string, bots: string[] = [], urls: string[] = []) =>
    out.push({ code, severity, title, detail, bots, urls });

  let g = group((r) => r.outcome === "challenge" && !r.general);
  if (g.rs.length)
    add("waf_challenge", "critical", t("botsim.finding.wafChallenge.title", { count: g.bots.length }),
      t("botsim.finding.wafChallenge.detail", { names: [...new Set(g.rs.map((r) => r.protection?.name).filter(Boolean))].join(", ") }), g.bots, g.urls);
  g = group((r) => (r.outcome === "blocked" || r.outcome === "error") && !r.general);
  if (g.rs.length) {
    const silent = [...new Set(g.rs.filter((r) => r.silent_block).map((r) => r.token))];
    add("waf_block", "critical", t("botsim.finding.wafBlock.title", { count: g.bots.length }),
      `${[...new Set(g.rs.map((r) => r.reason))].join(", ")}.${silent.length ? ` ${t("botsim.finding.wafBlock.silent", { bots: silent.join(", ") })}` : ""}`, g.bots, g.urls);
  }
  g = group((r) => r.outcome === "rate_limited" && !r.general);
  if (g.rs.length)
    add("rate_limited", "warning", t("botsim.finding.rateLimited.title", { count: g.bots.length }),
      t("botsim.finding.rateLimited.detail"), g.bots, g.urls);
  g = group((r) => r.general && BLOCKING.has(r.outcome));
  if (g.rs.length) {
    const walls = pages.filter((p) => g.urls.includes(p.url)).map((p) => p.baseline.protection as Protection | null).filter((w): w is Protection => !!w);
    const wall = walls.find((w) => w.kind === "challenge" || w.kind === "captcha");
    add("general_block", "critical", t("botsim.finding.generalBlock.title"),
      wall ? t("botsim.finding.generalBlock.wall", { name: wall.name }) : t("botsim.finding.generalBlock.noWall"), g.bots, g.urls);
  }
  g = group((r) => r.outcome === "degraded");
  if (g.rs.length)
    add("content_parity", "warning", t("botsim.finding.contentParity.title", { count: g.bots.length }),
      g.rs.slice(0, 3).map((r) => `${r.token}: ${r.reason}`).join("; "), g.bots, g.urls);
  g = group((r) => r.robots_allowed === false);
  if (g.rs.length)
    add("robots_disallow", "warning", t("botsim.finding.robotsDisallow.title", { count: g.bots.length }),
      t("botsim.finding.robotsDisallow.detail"), g.bots, g.urls);
  g = group((r) => r.accessible && (r.ttfb_ms ?? 0) > 3000);
  if (g.rs.length)
    add("slow_response", "warning", t("botsim.finding.slowResponse.title"),
      t("botsim.finding.slowResponse.detail", { ms: Math.max(...g.rs.map((r) => r.ttfb_ms ?? 0)) }), g.bots, g.urls);

  const views = pages.filter((p): p is Page & { ai_view: AiView } => !!p.ai_view);
  const csr = views.filter((p) => p.ai_view.render.mode === "csr_shell");
  if (csr.length)
    add("csr_shell", "critical", t("botsim.finding.csrShell.title", { count: csr.length }),
      t("botsim.finding.csrShell.detail", { reason: csr[0].ai_view.render.reason }), [], csr.map((p) => p.url));
  const weak = views.filter((p) => ["thin", "heavy_js"].includes(p.ai_view.render.mode));
  if (weak.length)
    add("thin_html", "warning", t("botsim.finding.thinHtml.title", { count: weak.length }), weak[0].ai_view.render.reason, [], weak.map((p) => p.url));
  const bloated = views.filter((p) => p.ai_view.bloat.issues.length);
  if (bloated.length)
    add("token_bloat", "warning", t("botsim.finding.tokenBloat.title", { count: bloated.length }),
      bloated[0].ai_view.bloat.issues.join("; "), [], bloated.map((p) => p.url));
  const low = views.filter((p) => p.ai_view.tokens.signal_ratio < 0.03 && p.ai_view.tokens.html_tokens > 5000);
  if (low.length) {
    const tokens = low[0].ai_view.tokens;
    add("low_signal", "info", t("botsim.finding.lowSignal.title"),
      t("botsim.finding.lowSignal.detail", {
        htmlTokens: tokens.html_tokens, textTokens: tokens.text_tokens, pct: Math.round(tokens.signal_ratio * 1000) / 10,
      }), [], low.map((p) => p.url));
  }
  const raw = views.filter((p) => !p.ai_view.tokens.compressed && p.ai_view.tokens.html_kb > 20);
  if (raw.length)
    add("no_compression", "info", t("botsim.finding.noCompression.title"), t("botsim.finding.noCompression.detail"), [], raw.map((p) => p.url));
  const large = views.filter((p) => p.ai_view.tokens.html_kb > 1024);
  if (large.length)
    add("large_html", "warning", t("botsim.finding.largeHtml.title"), t("botsim.finding.largeHtml.detail"), [], large.map((p) => p.url));
  const order = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

const gradeOf = (s: number) => (s >= 85 ? "A" : s >= 70 ? "B" : s >= 55 ? "C" : s >= 40 ? "D" : "E");
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function blockedBots(report: Pick<BotSimulationReport, "bots" | "pages">): string[] {
  return report.bots.filter((t) =>
    report.pages.some((p) => p.results.some((r) => r.token === t && !r.accessible && r.outcome !== "not_found" && r.outcome !== "server_error")));
}

export function vendorsOf(pages: Page[]): string[] {
  const out: string[] = [];
  for (const p of pages) {
    for (const r of p.results) {
      const v = r.protection?.vendor;
      if (v && v !== "unknown" && !out.includes(v)) out.push(v);
    }
    const cdn = p.baseline.cdn;
    if (cdn && !out.includes(cdn)) out.push(cdn);
  }
  return out;
}

// ---------------------------------------------------------------- orchestration

export type SimulateOptions = {
  bots?: string[];
  fetchImpl?: FetchLike;
  robotsTxt?: string | null;
  robotsStatus?: number | null;
  timeoutMs?: number;
  /** Milliseconds between requests of one identity (keeps the simulation itself under rate limits). */
  delayMs?: number;
  now?: () => Date;
  /** Language of the generated text (reasons, findings, fixes, caveats); default English. */
  locale?: Locale;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeTarget(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `Unsupported URL: ${url}`);
  u.hash = "";
  return u.toString();
}

/** Fetches every URL as each AI bot (and once as a browser) and diagnoses the responses. */
export async function simulateBots(urls: string[], opts: SimulateOptions = {}): Promise<BotSimulationReport> {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const t = serverT(locale);
  const targets = [...new Set(urls.map(normalizeTarget))];
  if (!targets.length) throw new HttpError(400, "At least one URL is required");
  const tokens = [...new Set(opts.bots?.length ? opts.bots : DEFAULT_BOTS)];
  const unknown = tokens.filter((token) => !BOT_PROFILES[token]);
  if (unknown.length) throw new HttpError(400, `Unknown bot: ${unknown.join(", ")}`);
  const profiles = tokens.map((token) => BOT_PROFILES[token]);
  // Default transport re-validates every redirect hop against private networks (SSRF); tests inject their own.
  const fetchImpl = opts.fetchImpl ?? ((u, init) => fetchPublic(u, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const delay = opts.delayMs ?? 250;
  const get = async (url: string, headers: Record<string, string>) => {
    const r = await fetchAs(fetchImpl, url, headers, timeoutMs, t);
    if (delay) await sleep(delay);
    return r;
  };

  let robotsTxt = opts.robotsTxt;
  let robotsStatus = opts.robotsStatus ?? null;
  if (robotsTxt === undefined) {
    const r = await get(new URL("/robots.txt", targets[0]).toString(), BROWSER_HEADERS);
    robotsStatus = r.status;
    robotsTxt = r.status === 200 && !/<html/i.test(r.body.slice(0, 500)) ? r.body : "";
  }
  const groups = robotsTxt === null ? null : parseRobots(robotsTxt);

  const pages: Page[] = [];
  for (const url of targets) {
    const base = await get(url, BROWSER_HEADERS);
    const [baseOutcome, baseProt] = outcomeOf(base, locale);
    const baseWords = base.body ? visibleWords(base.body) : 0;
    const baseline = {
      status: base.status, outcome: baseOutcome, final_url: base.finalUrl, words: baseWords, protection: baseProt,
      cdn: fingerprint(base.headers), ttfb_ms: base.ttfbMs, total_ms: base.totalMs, html_bytes: base.htmlBytes, error: base.error,
    };
    const fetched = await Promise.all(profiles.map((p) => get(url, botHeaders(p))));
    const results: BotResult[] = profiles.map((p, i) => {
      const res = fetched[i];
      const [first, prot] = outcomeOf(res, locale);
      let outcome = first;
      const words = res.body ? visibleWords(res.body) : 0;
      const ref = baseOutcome === "ok" ? baseWords : 0;
      const parity = ref && outcome === "ok" ? Math.round((words / ref) * 100) / 100 : null;
      if (outcome === "ok" && ref >= 100 && parity !== null && parity < 0.5) outcome = "degraded";
      const robotsAllowed = groups ? (robotsStatus === null || robotsStatus < 500) && robotsAllows(groups, p.token, url) : null;
      const accessible = outcome in ACCESS_CREDIT;
      const r = {
        token: p.token, vendor: p.vendor, purpose: p.purpose, crawler: p.crawler, user_agent: p.userAgent, url,
        outcome, status: res.status, final_url: res.finalUrl, protection: prot, robots_allowed: robotsAllowed,
        silent_block: !!robotsAllowed && BLOCKING.has(outcome), general: !(baseOutcome in ACCESS_CREDIT) && !accessible,
        words, parity, ttfb_ms: res.ttfbMs, total_ms: res.totalMs, html_bytes: res.htmlBytes, wire_bytes: res.wireBytes,
        content_encoding: res.contentEncoding, error: res.error,
        note: p.robotsOnly ? t("botsim.note.robotsOnly", { token: p.token, vendor: p.vendor, crawler: p.crawler }) : "",
      };
      return { ...r, accessible, reason: botReason(r, t), label: t(`botsim.outcome.${outcome}`) };
    });
    const i = results.findIndex((r, k) => r.accessible && fetched[k].body);
    const ai_view = i >= 0 ? analyzeView(fetched[i], results[i].token, locale) : baseOutcome === "ok" && base.body ? analyzeView(base, "browser", locale) : null;
    const access = results.length ? (100 * results.reduce((n, r) => n + (ACCESS_CREDIT[r.outcome] ?? 0), 0)) / results.length : 0;
    pages.push({ url, access_score: Math.round(access), baseline, results, ai_view });
  }

  const accessScore = mean(pages.map((p) => p.access_score)) ?? 0;
  const renderScore = mean(pages.flatMap((p) => (p.ai_view ? [p.ai_view.render.score] : [])));
  const tokenScore = mean(pages.flatMap((p) => (p.ai_view ? [p.ai_view.tokens.score] : [])));
  const score = Math.round(0.6 * accessScore + ((0.25 * (renderScore ?? 0) + 0.15 * (tokenScore ?? 0)) * accessScore) / 100);
  const findings = findingsOf(pages, t);
  const blocked = blockedBots({ bots: tokens, pages });
  const vendors = vendorsOf(pages);
  const caveats: string[] = [];
  if (blocked.length) caveats.push(t("botsim.caveat.serverIp"));
  if (tokens.some((token) => token === "Google-Extended" || token === "Applebot-Extended")) caveats.push(t("botsim.caveat.robotsOnly"));
  const fixes = buildFixes(
    (blocked.length ? blocked : tokens).map((token) => BOT_PROFILES[token]), vendors,
    findings.find((f) => f.code === "csr_shell")?.urls ?? [], findings.some((f) => f.code === "token_bloat"), !blocked.length, locale,
  );
  const origin = new URL(targets[0]).origin;
  return botSimulationReportSchema.parse({
    version: SIMULATOR_VERSION, generated_at: (opts.now ?? (() => new Date()))().toISOString(), origin, bots: tokens,
    robots_status: robotsStatus, score, grade: gradeOf(score),
    scores: { access: accessScore, render: renderScore, tokens: tokenScore },
    blocked_bots: blocked, vendors, pages, findings, fixes, caveats,
  });
}

/** Compact form stored in `GeoAudit.metrics.botSimulation` (same keys as the crawler's `summary()`). */
export function summarizeBotSimulation(report: BotSimulationReport) {
  return {
    version: report.version,
    score: Math.round(report.score),
    grade: report.grade,
    accessScore: report.scores.access,
    renderScore: report.scores.render,
    tokenScore: report.scores.tokens,
    bots: report.bots,
    blockedBots: report.blocked_bots,
    vendors: report.vendors,
    pages: report.pages.map((p) => ({
      url: p.url,
      accessScore: Math.round(p.access_score),
      render: p.ai_view?.render.mode ?? null,
      htmlTokens: p.ai_view?.tokens.html_tokens ?? null,
      textTokens: p.ai_view?.tokens.text_tokens ?? null,
      bots: Object.fromEntries(p.results.map((r) => [r.token, r.outcome])),
    })),
    findings: report.findings.map((f) => ({ code: f.code, severity: f.severity, title: f.title })),
  };
}
export type BotSimulationSummary = ReturnType<typeof summarizeBotSimulation>;

// ---------------------------------------------------------------- site API

export const botSimulationInput = z
  .object({
    urls: z.array(z.string().url().max(2000)).min(1).max(5).optional(),
    bots: z.array(z.enum(BOT_TOKENS)).min(1).max(BOT_TOKENS.length).optional(),
  })
  .strict()
  .default({});
export type BotSimulationInput = z.infer<typeof botSimulationInput>;

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * On-demand live simulation for a site: its homepage (or up to 5 given URLs on the same host — the server
 * never fetches arbitrary third-party URLs) as each AI bot. Results are returned, not stored.
 */
export async function runSiteBotSimulation(siteId: string, input: BotSimulationInput = {}, opts: SimulateOptions = {}) {
  const site = await getSiteOrThrow(siteId);
  const host = bareHost(new URL(site.url).hostname);
  const urls = input.urls?.length ? input.urls : [site.url];
  const foreign = urls.filter((u) => bareHost(new URL(u).hostname) !== host);
  if (foreign.length) throw new HttpError(400, `URLs must belong to ${host}`, { foreign });
  return simulateBots(urls, { ...opts, bots: input.bots ?? opts.bots });
}

/** Latest completed audit's simulation summary (written by the crawler's `geo-audit`). */
export async function getSiteBotSimulation(siteId: string) {
  await getSiteOrThrow(siteId);
  const audits = await prisma.geoAudit.findMany({
    where: { siteId, status: "completed" },
    orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 10,
    select: { id: true, completedAt: true, metrics: true },
  });
  const audit = audits.find((a) => a.metrics && typeof a.metrics === "object" && "botSimulation" in (a.metrics as object));
  return {
    auditId: audit?.id ?? null,
    completedAt: audit?.completedAt ?? null,
    summary: audit ? ((audit.metrics as Record<string, unknown>).botSimulation as BotSimulationSummary) : null,
  };
}
