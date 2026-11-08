"""Live AI-crawler simulation — what GPTBot, ClaudeBot, PerplexityBot & co. *actually* receive.

robots.txt permission is not access: bot protection (Cloudflare Managed Challenge / Turnstile, Imperva, Akamai,
AWS WAF, DataDome, Vercel), UA-based server rules and client-side rendering silently hand AI crawlers a 403/503,
an interstitial or an empty ``<div id="root">``. This module fetches live URLs with each crawler's published
User-Agent and request headers (no cookies, no JavaScript — exactly like the crawlers) next to a browser baseline,
then diagnoses per bot and per page:

* **Access** — HTTP outcome, WAF / bot-protection vendor and challenge type, robots.txt verdict
  ("silent block" = robots.txt allows, the edge refuses), browser parity (bots served less content).
* **Render integrity** — SSR/SSG content vs. empty SPA shell (``#root`` / ``#app`` / ``#__next``), framework.
* **Token weight** — HTML / text LLM tokens (tiktoken ``cl100k_base`` when installed, else a calibrated
  estimator, ~±12% on HTML/Markdown/Turkish/English), transfer size and compression, DOM size and embedded JSON
  state (``__NEXT_DATA__``, RSC payload, ``__NUXT__``...).
* **Fix recipes** — Cloudflare WAF skip rule (expression + Rulesets API JSON), nginx, Apache/ModSecurity,
  AWS WAF, vendor console steps and SSR guidance, generated for the bots that were actually refused.

Caveat: requests come from our IP, not the vendors' published ranges. A WAF that verifies bots by IP
(Cloudflare verified bots) may treat a spoofed UA differently from the real crawler — every block is reported
with that caveat and should be confirmed in the WAF's event log.

    report = await simulate_bots(["https://example.com/", "https://example.com/urun/x"])
    report.score, report.findings[0].title, report.fixes[0]["code"]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup

from ..parser import parse_html
from ..urls import normalize_url
from . import snippets as sn
from .access import classify_render
from .base import clamp, grade
from .robots import evaluate, parse_robots_rules

log = logging.getLogger(__name__)

SIMULATOR_VERSION = "1.0"
TOKENIZER = "cl100k_base"  # GPT-4 / GPT-3.5 tokenizer
MAX_BODY_BYTES = 5_000_000
BLOCK_STATUSES = (401, 403, 406, 429, 451, 503)


@dataclass(frozen=True)
class BotProfile:
    token: str  # robots.txt product token
    vendor: str
    purpose: str  # training | search | user
    user_agent: str
    crawler: str  # name that appears in the User-Agent (differs for robots-only tokens)
    note: str = ""


_GOOGLEBOT_UA = ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; "
                 "+http://www.google.com/bot.html) Chrome/131.0.6778.204 Safari/537.36")
_APPLEBOT_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
                "Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)")

BOT_PROFILES: dict[str, BotProfile] = {b.token: b for b in (
    BotProfile("GPTBot", "OpenAI", "training",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)",
               "GPTBot"),
    BotProfile("OAI-SearchBot", "OpenAI", "search",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; "
               "+https://openai.com/searchbot", "OAI-SearchBot"),
    BotProfile("ChatGPT-User", "OpenAI", "user",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
               "ChatGPT-User"),
    BotProfile("ClaudeBot", "Anthropic", "training",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
               "ClaudeBot"),
    BotProfile("Claude-User", "Anthropic", "user",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
               "Claude-User"),
    BotProfile("PerplexityBot", "Perplexity", "search",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; "
               "+https://perplexity.ai/perplexitybot)", "PerplexityBot"),
    BotProfile("Perplexity-User", "Perplexity", "user",
               "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; "
               "+https://perplexity.ai/perplexity-user)", "Perplexity-User"),
    BotProfile("Google-Extended", "Google", "training", _GOOGLEBOT_UA, "Googlebot",
               "Google-Extended yalnızca robots.txt jetonudur; Google içeriği Googlebot ile alır."),
    BotProfile("Applebot-Extended", "Apple", "training", _APPLEBOT_UA, "Applebot",
               "Applebot-Extended yalnızca robots.txt jetonudur; Apple içeriği Applebot ile alır."),
)}
DEFAULT_BOTS: tuple[str, ...] = ("GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended")

# Crawlers do not run JS, keep cookies or send client hints; Accept-Encoding without br (not always decodable).
BOT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7"
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate",
}


def bot_headers(profile: BotProfile) -> dict[str, str]:
    return {"User-Agent": profile.user_agent, "Accept": BOT_ACCEPT, "Accept-Encoding": "gzip, deflate"}


# ---------------------------------------------------------------- WAF / bot-protection detection

KEPT_HEADERS = (
    "server", "content-type", "content-encoding", "content-length", "location", "retry-after", "x-robots-tag",
    "cf-ray", "cf-mitigated", "cf-cache-status", "x-vercel-id", "x-vercel-mitigated", "x-amzn-waf-action",
    "x-amz-cf-id", "x-amz-cf-pop", "x-iinfo", "x-cdn", "x-sucuri-id", "x-datadome", "akamai-grn", "x-cache", "via",
)

# (vendor, header, regex on value) -> CDN/WAF fingerprint even on successful responses
_FINGERPRINTS: tuple[tuple[str, str, str], ...] = (
    ("cloudflare", "cf-ray", ""), ("cloudflare", "server", r"cloudflare"),
    ("vercel", "x-vercel-id", ""), ("vercel", "server", r"^vercel"),
    ("aws_waf", "x-amzn-waf-action", ""), ("aws_waf", "x-amz-cf-id", ""), ("aws_waf", "server", r"cloudfront|awselb"),
    ("imperva", "x-iinfo", ""), ("imperva", "x-cdn", r"incapsula|imperva"),
    ("akamai", "akamai-grn", ""), ("akamai", "server", r"akamai"),
    ("sucuri", "x-sucuri-id", ""), ("sucuri", "server", r"sucuri"),
    ("datadome", "x-datadome", ""), ("datadome", "server", r"datadome"),
)

# (vendor, kind, name, pattern on lower-cased body). Strong markers only occur on interstitial / block pages.
_STRONG_BODY: tuple[tuple[str, str, str, str], ...] = (
    ("cloudflare", "rate_limit", "Cloudflare 1015 hız sınırı", r"error code:?\s*1015|you are being rate limited"),
    ("cloudflare", "challenge", "Cloudflare Challenge", r"_cf_chl_opt|/cdn-cgi/challenge-platform/|cf-chl-widget|"
                                                        r"<title>\s*just a moment\.\.\.\s*</title>"),
    ("cloudflare", "block", "Cloudflare WAF engeli", r"attention required! \| cloudflare|sorry, you have been blocked|"
                                                     r"cf-error-details|error code:?\s*10(?:0\d|1\d|20)\b"),
    ("vercel", "challenge", "Vercel Security Checkpoint", r"vercel security checkpoint"),
    ("imperva", "block", "Imperva (Incapsula) engeli", r"incapsula incident id|_incapsula_resource"),
    ("akamai", "block", "Akamai engeli", r"errors\.edgesuite\.net|reference\s*(?:&#32;)?(?:#|&#35;)\s*\d+\.[0-9a-f]+\.\d+"),
    ("aws_waf", "challenge", "AWS WAF Challenge/CAPTCHA", r"awswaf|aws-waf-token|gokuprops"),
    ("aws_waf", "block", "AWS WAF / CloudFront engeli", r"generated by cloudfront \(cloudfront\)"),
    ("datadome", "captcha", "DataDome CAPTCHA", r"captcha-delivery\.com"),
    ("perimeterx", "captcha", "HUMAN (PerimeterX) CAPTCHA", r"px-captcha|_pxappid|perimeterx"),
    ("sucuri", "block", "Sucuri WAF engeli", r"sucuri website firewall|access denied - sucuri"),
    ("ddos-guard", "challenge", "DDoS-Guard Challenge", r"ddos-guard"),
)
# Weak markers also appear on normal pages (contact-form CAPTCHAs, copy) — only counted on interstitial-like pages.
_WEAK_BODY: tuple[tuple[str, str, str, str], ...] = (
    ("cloudflare", "captcha", "Cloudflare Turnstile", r"challenges\.cloudflare\.com/turnstile|cf-turnstile"),
    ("unknown", "captcha", "hCaptcha", r"hcaptcha\.com/1/api\.js|class=[\"']h-captcha"),
    ("unknown", "captcha", "Google reCAPTCHA", r"google\.com/recaptcha|class=[\"']g-recaptcha"),
    ("unknown", "block", "Genel bot engeli", r"access denied|bot detected|are you a robot|unusual traffic|"
                                             r"verify you are (?:a )?human|enable javascript and cookies to continue"),
)
_STRONG_RX = [(v, k, n, re.compile(p)) for v, k, n, p in _STRONG_BODY]
_WEAK_RX = [(v, k, n, re.compile(p)) for v, k, n, p in _WEAK_BODY]
_CF_CTYPE = re.compile(r"ctype\s*:\s*['\"]([\w-]+)['\"]")
_TAG = re.compile(r"<script\b.*?</script>|<style\b.*?</style>|<[^>]+>", re.S | re.I)


@dataclass
class Protection:
    vendor: str  # cloudflare | vercel | aws_waf | imperva | akamai | sucuri | datadome | perimeterx | ddos-guard | unknown
    kind: str  # challenge | captcha | block | rate_limit
    name: str
    evidence: list[str] = field(default_factory=list)


def fingerprint(headers: dict[str, str]) -> str | None:
    """CDN / WAF vendor in front of the site, from response headers (None = not recognised)."""
    h = {k.lower(): v for k, v in headers.items()}
    for vendor, name, rx in _FINGERPRINTS:
        if name in h and (not rx or re.search(rx, h[name], re.I)):
            return vendor
    return None


def visible_words(body: str) -> int:
    return len(_TAG.sub(" ", body[:300_000]).split())


def detect_protection(status: int | None, headers: dict[str, str], body: str) -> Protection | None:
    """Bot-protection verdict for one response, or None when the response is a normal page."""
    h = {k.lower(): v for k, v in headers.items()}
    low = body[:300_000].lower()
    vendor = fingerprint(h) or "unknown"

    mitigated = h.get("cf-mitigated", "").lower()
    if mitigated:
        return Protection("cloudflare", "challenge", _cf_challenge_name(low), [f"cf-mitigated: {mitigated}"])
    vercel = h.get("x-vercel-mitigated", "").lower()
    if vercel:
        kind = "block" if vercel == "deny" else "challenge"
        return Protection("vercel", kind, f"Vercel Firewall ({vercel})", [f"x-vercel-mitigated: {vercel}"])
    waf_action = h.get("x-amzn-waf-action", "").lower()
    if waf_action:
        kind = {"captcha": "captcha", "challenge": "challenge"}.get(waf_action, "block")
        return Protection("aws_waf", kind, f"AWS WAF {waf_action.upper()}", [f"x-amzn-waf-action: {waf_action}"])

    for v, kind, name, rx in _STRONG_RX:
        m = rx.search(low)
        if m:
            if v == "cloudflare" and kind == "challenge":
                name = _cf_challenge_name(low)
            if v == "aws_waf" and kind == "block" and (status or 0) < 400:
                continue  # CloudFront footer on a regular error template
            return Protection(v, kind, name, [f"gövde: '{m.group(0)[:60]}'"])

    interstitial = (status is not None and status >= 400) or visible_words(body) < 150
    if interstitial:
        for v, kind, name, rx in _WEAK_RX:
            m = rx.search(low)
            if m:
                return Protection(vendor if v == "unknown" else v, kind, name, [f"gövde: '{m.group(0)[:60]}'"])

    if status == 429:
        retry = h.get("retry-after")
        return Protection(vendor, "rate_limit", "HTTP 429 hız sınırı", [f"HTTP 429" + (f", Retry-After: {retry}" if retry else "")])
    if status in (401, 403, 406, 451, 503):
        label = {"unknown": "Sunucu/WAF"}.get(vendor, vendor)
        return Protection(vendor, "block", f"{label} HTTP {status} engeli", [f"HTTP {status}"])
    return None


def _cf_challenge_name(low: str) -> str:
    ctype = (_CF_CTYPE.search(low) or [None, ""])[1]
    if "turnstile" in low and ctype not in ("managed", "non-interactive"):
        return "Cloudflare Turnstile"
    return {"managed": "Cloudflare Managed Challenge", "non-interactive": "Cloudflare JS Challenge",
            "interactive": "Cloudflare Interactive Challenge"}.get(ctype, "Cloudflare Managed Challenge")


# ---------------------------------------------------------------- token weight

_PRETOKEN = re.compile(r"'(?:[sdmt]|ll|ve|re)|[^\r\n\w]?[^\W\d_]+|\d{1,3}| ?[^\s\w]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+",
                       re.I)
_LEAD = re.compile(r"^[^\w]")
_encoder: Any = None


def _tiktoken() -> Any:
    global _encoder
    if _encoder is None:
        try:
            import tiktoken  # optional: pip install 'geo-crawler[tokens]'
            _encoder = tiktoken.get_encoding(TOKENIZER)
        except Exception:  # noqa: BLE001 — not installed / no cached BPE file offline
            _encoder = False
    return _encoder


def estimate_tokens(text: str) -> int:
    """cl100k_base token estimate without the BPE tables: a linear model over its pre-tokenizer chunks.

    Fitted against tiktoken on HTML, Markdown, JSON, Turkish and English (max error ~12%): short ASCII words are
    one token, long / non-ASCII words split into ~4.3 / ~1.4 character pieces, punctuation runs ~2 chars a token.
    """
    short = long_chars = non_ascii = digits = punct = ws = 0
    for m in _PRETOKEN.finditer(text):
        chunk = m.group(0)
        s = chunk.strip()
        if not s:
            ws += 1
            continue
        core = _LEAD.sub("", s)
        if core and core[-1].isalpha():
            if not core.isascii():
                non_ascii += len(core)
            elif len(core) <= 7:
                short += 1
            else:
                long_chars += len(core)
        elif s.isdigit():
            digits += 1
        else:
            punct += len(s)
    est = 0.985 * short + 0.23 * long_chars + 0.695 * non_ascii + 1.351 * digits + 0.516 * punct + 0.683 * ws
    return int(math.ceil(est)) if text else 0


def count_tokens(text: str) -> tuple[int, str]:
    """(tokens, method) — exact with tiktoken, estimated otherwise."""
    enc = _tiktoken()
    if enc:
        return len(enc.encode(text, disallowed_special=())), f"tiktoken:{TOKENIZER}"
    return estimate_tokens(text), f"estimate:{TOKENIZER}"


def token_efficiency(signal_ratio: float, html_bytes: int, compressed: bool) -> float:
    """0-100: share of HTML tokens that are readable text (10%+ = full marks), minus size/compression penalties."""
    r = max(signal_ratio, 1e-4)
    score = clamp(40 + 60 * (math.log10(r) - math.log10(0.01)) / (math.log10(0.10) - math.log10(0.01)))
    if not compressed and html_bytes > 20_000:
        score -= 15
    if html_bytes > 2_000_000:
        score -= 20
    elif html_bytes > 1_000_000:
        score -= 10
    return clamp(score)


# ---------------------------------------------------------------- page bloat

_STATE_MARKERS = (
    ("self.__next_f.push", "Next.js RSC yükü"), ("window.__NUXT__", "Nuxt state"), ("__NUXT_DATA__", "Nuxt state"),
    ("__INITIAL_STATE__", "__INITIAL_STATE__"), ("__PRELOADED_STATE__", "Redux state"),
    ("__APOLLO_STATE__", "Apollo cache"), ("__remixContext", "Remix context"), ("window.__data", "window.__data"),
)
_DATA_URI = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{200,}")
DOM_NODES_WARN, DOM_NODES_CRITICAL, DOM_DEPTH_WARN = 1500, 3000, 32
JSON_STATE_WARN = 100_000


def analyze_bloat(soup: BeautifulSoup, html: str) -> dict[str, Any]:
    html_bytes = len(html.encode("utf-8", "ignore"))
    nodes, max_depth = 0, 0
    stack = [(soup, 0)]
    while stack:
        el, d = stack.pop()
        for child in getattr(el, "contents", ()):
            if getattr(child, "name", None):
                nodes += 1
                max_depth = max(max_depth, d + 1)
                stack.append((child, d + 1))

    blobs: list[dict[str, Any]] = []
    ld_bytes = inline_js = 0
    for s in soup.find_all("script"):
        raw = s.string or s.get_text() or ""
        size = len(raw.encode("utf-8", "ignore"))
        typ = str(s.get("type") or "").lower()
        if "ld+json" in typ:
            ld_bytes += size
        elif "json" in typ:
            blobs.append({"kind": "__NEXT_DATA__" if s.get("id") == "__NEXT_DATA__" else f"<script type={typ}>",
                          "bytes": size})
        elif not s.get("src"):
            label = next((lbl for marker, lbl in _STATE_MARKERS if marker in raw[:2000]), None)
            if label:
                blobs.append({"kind": label, "bytes": size})
            else:
                inline_js += size
    merged: dict[str, int] = {}
    for b in blobs:
        merged[b["kind"]] = merged.get(b["kind"], 0) + b["bytes"]
    state_bytes = sum(merged.values())
    css = sum(len((t.string or "").encode("utf-8", "ignore")) for t in soup.find_all("style"))
    svg = sum(len(str(t).encode("utf-8", "ignore")) for t in soup.find_all("svg"))
    data_uri = sum(len(m.group(0)) for m in _DATA_URI.finditer(html))

    issues: list[str] = []
    if nodes > DOM_NODES_WARN:
        issues.append(f"DOM {nodes} düğüm (>{DOM_NODES_WARN})")
    if max_depth > DOM_DEPTH_WARN:
        issues.append(f"DOM derinliği {max_depth} (>{DOM_DEPTH_WARN})")
    if state_bytes > JSON_STATE_WARN or (html_bytes and state_bytes / html_bytes > 0.4 and state_bytes > 20_000):
        top = max(merged.items(), key=lambda kv: kv[1])
        issues.append(f"gömülü JSON durum verisi {state_bytes // 1024} KB (%{100 * state_bytes // max(html_bytes, 1)}, "
                      f"en büyüğü {top[0]})")
    if css > 150_000:
        issues.append(f"satır içi CSS {css // 1024} KB")
    if svg > 150_000:
        issues.append(f"satır içi SVG {svg // 1024} KB")
    if data_uri > 100_000:
        issues.append(f"base64 data URI {data_uri // 1024} KB")
    if inline_js > 200_000:
        issues.append(f"satır içi JavaScript {inline_js // 1024} KB")
    return {
        "dom_nodes": nodes, "dom_depth": max_depth,
        "json_state_bytes": state_bytes, "json_state": [{"kind": k, "bytes": v} for k, v in
                                                        sorted(merged.items(), key=lambda kv: -kv[1])],
        "ld_json_bytes": ld_bytes, "inline_script_bytes": inline_js, "inline_css_bytes": css,
        "inline_svg_bytes": svg, "data_uri_bytes": data_uri, "issues": issues,
    }


# ---------------------------------------------------------------- render integrity

_NOSCRIPT_JS = re.compile(r"(enable|etkinleştir|açın|aktif).{0,40}javascript|javascript.{0,40}(required|gerekli|enable|etkinleştir|açın|aktif)",
                          re.I)


def analyze_render(html: str, url: str) -> tuple[dict[str, Any], BeautifulSoup, str]:
    """Render verdict of the HTML a crawler received (+ the soup and visible text for further analysis)."""
    page = parse_html(html, url)
    mode, score, reason = classify_render(page)
    s = page.content_stats or {}
    soup = BeautifulSoup(html, "lxml")
    noscript = " ".join(n.get_text(" ") for n in soup.find_all("noscript"))
    return ({
        "mode": mode, "score": round(score), "reason": reason, "word_count": page.word_count,
        "title": page.title or "", "h1": (page.headings.get("h1") or [""])[0][:200],
        "frameworks": s.get("hydration") or [], "spa_root": s.get("spa_root"),
        "script_tags": s.get("script_tags", 0), "external_scripts": s.get("external_scripts", 0),
        "noscript_requires_js": bool(_NOSCRIPT_JS.search(noscript)),
        "text_ratio": s.get("text_ratio", 0.0),
    }, soup, page.text)


# ---------------------------------------------------------------- fetching

@dataclass
class FetchResult:
    identity: str  # bot token or "browser"
    url: str
    final_url: str = ""
    status: int | None = None
    redirects: list[int] = field(default_factory=list)
    headers: dict[str, str] = field(default_factory=dict)
    content_type: str = ""
    content_encoding: str = ""
    wire_bytes: int = 0
    html_bytes: int = 0
    truncated: bool = False
    ttfb_ms: int | None = None
    total_ms: int | None = None
    error: str | None = None
    body: str = ""

    def meta(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("body")
        return d


async def fetch(client: httpx.AsyncClient, url: str, headers: dict[str, str], identity: str,
                max_bytes: int = MAX_BODY_BYTES) -> FetchResult:
    res = FetchResult(identity=identity, url=url)
    t0 = time.perf_counter()
    try:
        async with client.stream("GET", url, headers=headers) as resp:
            res.ttfb_ms = round((time.perf_counter() - t0) * 1000)
            res.status = resp.status_code
            res.final_url = str(resp.url)
            res.redirects = [r.status_code for r in resp.history]
            res.headers = {k: v for k, v in resp.headers.items() if k.lower() in KEPT_HEADERS}
            res.content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            res.content_encoding = resp.headers.get("content-encoding", "").lower()
            chunks: list[bytes] = []
            size = 0
            async for chunk in resp.aiter_bytes():
                chunks.append(chunk)
                size += len(chunk)
                if size >= max_bytes:
                    res.truncated = True
                    break
            raw = b"".join(chunks)[:max_bytes]
            res.wire_bytes = resp.num_bytes_downloaded
            res.html_bytes = len(raw)
            res.body = raw.decode(resp.encoding or "utf-8", errors="replace")
    except httpx.TooManyRedirects:
        res.error = "yönlendirme döngüsü"
    except httpx.TimeoutException:
        res.error = "zaman aşımı"
    except httpx.HTTPError as exc:
        res.error = f"{type(exc).__name__}: {exc}"[:200]
    res.total_ms = round((time.perf_counter() - t0) * 1000)
    return res


# ---------------------------------------------------------------- results

OUTCOME_LABELS = {
    "ok": "erişilebilir", "degraded": "eksik içerik", "challenge": "challenge/CAPTCHA", "blocked": "engellendi",
    "rate_limited": "hız sınırı", "not_found": "bulunamadı", "server_error": "sunucu hatası", "error": "bağlantı hatası",
}
ACCESS_CREDIT = {"ok": 1.0, "degraded": 0.5}


@dataclass
class BotResult:
    token: str
    vendor: str
    purpose: str
    crawler: str
    user_agent: str
    url: str
    outcome: str
    status: int | None
    final_url: str
    protection: Protection | None = None
    robots_allowed: bool | None = None
    silent_block: bool = False  # robots.txt allows, the server refuses
    general: bool = False  # the browser baseline is refused too (bot wall / IP or geo block)
    words: int = 0
    parity: float | None = None  # bot words / browser words
    ttfb_ms: int | None = None
    total_ms: int | None = None
    html_bytes: int = 0
    wire_bytes: int = 0
    content_encoding: str = ""
    error: str | None = None
    note: str = ""

    @property
    def accessible(self) -> bool:
        return self.outcome in ACCESS_CREDIT

    @property
    def reason(self) -> str:
        if self.error:
            return f"{self.error}" + (" (tarayıcı isteği başarılı → AI UA bağlantısı düşürülüyor)" if not self.general else "")
        if self.protection:
            return f"{self.protection.name} (HTTP {self.status})"
        if self.outcome == "degraded":
            return f"tarayıcıya göre içeriğin %{round((self.parity or 0) * 100)}'i döndü ({self.words} kelime)"
        return f"HTTP {self.status}, {self.words} kelime"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["accessible"] = self.accessible
        d["reason"] = self.reason
        d["label"] = OUTCOME_LABELS.get(self.outcome, self.outcome)
        return d


def _outcome(res: FetchResult) -> tuple[str, Protection | None]:
    if res.error:
        return "error", None
    prot = detect_protection(res.status, res.headers, res.body)
    if prot:
        return {"rate_limit": "rate_limited", "block": "blocked"}.get(prot.kind, "challenge"), prot
    st = res.status or 0
    if st in (404, 410):
        return "not_found", None
    if st >= 500:
        return "server_error", None
    if st >= 400:
        return "blocked", None
    return "ok", None


@dataclass
class Finding:
    code: str
    severity: str  # critical | warning | info
    title: str
    detail: str
    bots: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PageSimulation:
    url: str
    baseline: dict[str, Any]
    results: list[BotResult]
    ai_view: dict[str, Any] | None = None  # render / tokens / bloat of the HTML the bots received

    @property
    def access_score(self) -> float:
        if not self.results:
            return 0.0
        return 100.0 * sum(ACCESS_CREDIT.get(r.outcome, 0.0) for r in self.results) / len(self.results)

    def to_dict(self) -> dict[str, Any]:
        return {"url": self.url, "access_score": round(self.access_score), "baseline": self.baseline,
                "results": [r.to_dict() for r in self.results], "ai_view": self.ai_view}


@dataclass
class BotSimulationReport:
    origin: str
    bots: list[str]
    pages: list[PageSimulation]
    robots_status: int | None = None
    findings: list[Finding] = field(default_factory=list)
    fixes: list[dict[str, Any]] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    version: str = SIMULATOR_VERSION
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    # ---- scores
    @property
    def access_score(self) -> int:
        return round(sum(p.access_score for p in self.pages) / len(self.pages)) if self.pages else 0

    def _view_mean(self, key: str) -> int | None:
        vals = [p.ai_view[key]["score"] for p in self.pages if p.ai_view and p.ai_view.get(key)]
        return round(sum(vals) / len(vals)) if vals else None

    @property
    def render_score(self) -> int | None:
        return self._view_mean("render")

    @property
    def token_score(self) -> int | None:
        return self._view_mean("tokens")

    @property
    def score(self) -> int:
        """Access dominates: render and token efficiency only count to the extent bots get in."""
        a = self.access_score
        r = self.render_score if self.render_score is not None else 0
        t = self.token_score if self.token_score is not None else 0
        return round(0.6 * a + (0.25 * r + 0.15 * t) * a / 100)

    def blocked_bots(self) -> list[str]:
        return [t for t in self.bots if any(not r.accessible and r.outcome not in ("not_found", "server_error")
                                            for p in self.pages for r in p.results if r.token == t)]

    def vendors(self) -> list[str]:
        out: list[str] = []
        for p in self.pages:
            for r in p.results:
                v = r.protection.vendor if r.protection else None
                if v and v != "unknown" and v not in out:
                    out.append(v)
            cdn = p.baseline.get("cdn")
            if cdn and cdn not in out:
                out.append(cdn)
        return out

    def summary(self) -> dict[str, Any]:
        """Compact form for ``GeoAudit.metrics.botSimulation`` (the full report stays in the audit JSON)."""
        return {
            "version": self.version, "score": self.score, "grade": grade(self.score),
            "accessScore": self.access_score, "renderScore": self.render_score, "tokenScore": self.token_score,
            "bots": self.bots, "blockedBots": self.blocked_bots(), "vendors": self.vendors(),
            "pages": [{"url": p.url, "accessScore": round(p.access_score),
                       "render": (p.ai_view or {}).get("render", {}).get("mode"),
                       "htmlTokens": (p.ai_view or {}).get("tokens", {}).get("html_tokens"),
                       "textTokens": (p.ai_view or {}).get("tokens", {}).get("text_tokens"),
                       "bots": {r.token: r.outcome for r in p.results}} for p in self.pages],
            "findings": [{"code": f.code, "severity": f.severity, "title": f.title} for f in self.findings],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version, "generated_at": self.generated_at, "origin": self.origin, "bots": self.bots,
            "robots_status": self.robots_status, "score": self.score, "grade": grade(self.score),
            "scores": {"access": self.access_score, "render": self.render_score, "tokens": self.token_score},
            "blocked_bots": self.blocked_bots(), "vendors": self.vendors(),
            "pages": [p.to_dict() for p in self.pages],
            "findings": [f.to_dict() for f in self.findings], "fixes": self.fixes, "caveats": self.caveats,
        }


# ---------------------------------------------------------------- analysis of one page

def _analyze_view(res: FetchResult, source: str) -> dict[str, Any]:
    render, soup, text = analyze_render(res.body, res.final_url or res.url)
    html_tokens, method = count_tokens(res.body)
    text_tokens, _ = count_tokens(text)
    compressed = res.content_encoding in ("gzip", "br", "deflate", "zstd")
    ratio = text_tokens / html_tokens if html_tokens else 0.0
    tokens = {
        "method": method, "html_tokens": html_tokens, "text_tokens": text_tokens, "signal_ratio": round(ratio, 4),
        "html_kb": round(res.html_bytes / 1024, 1), "transfer_kb": round(res.wire_bytes / 1024, 1),
        "content_encoding": res.content_encoding or None, "compressed": compressed,
        "compression_ratio": round(res.wire_bytes / res.html_bytes, 3) if compressed and res.html_bytes else None,
        "truncated": res.truncated, "score": round(token_efficiency(ratio, res.html_bytes, compressed)),
    }
    return {"source": source, "render": render, "tokens": tokens, "bloat": analyze_bloat(soup, res.body)}


def _baseline_meta(res: FetchResult) -> dict[str, Any]:
    outcome, prot = _outcome(res)
    words = visible_words(res.body) if res.body else 0
    return {"status": res.status, "outcome": outcome, "final_url": res.final_url, "words": words,
            "protection": asdict(prot) if prot else None, "cdn": fingerprint(res.headers),
            "ttfb_ms": res.ttfb_ms, "total_ms": res.total_ms, "html_bytes": res.html_bytes, "error": res.error}


def _bot_result(profile: BotProfile, res: FetchResult, baseline: dict[str, Any], robots_allowed: bool | None,
                base_words: int) -> BotResult:
    outcome, prot = _outcome(res)
    words = visible_words(res.body) if res.body else 0
    parity = round(words / base_words, 2) if base_words and outcome == "ok" else None
    if outcome == "ok" and base_words >= 100 and parity is not None and parity < 0.5:
        outcome = "degraded"
    general = baseline["outcome"] not in ACCESS_CREDIT and outcome not in ACCESS_CREDIT
    return BotResult(
        token=profile.token, vendor=profile.vendor, purpose=profile.purpose, crawler=profile.crawler,
        user_agent=profile.user_agent, url=res.url, outcome=outcome, status=res.status, final_url=res.final_url,
        protection=prot, robots_allowed=robots_allowed,
        silent_block=bool(robots_allowed) and outcome in ("blocked", "challenge", "rate_limited", "error"),
        general=general, words=words, parity=parity, ttfb_ms=res.ttfb_ms, total_ms=res.total_ms,
        html_bytes=res.html_bytes, wire_bytes=res.wire_bytes, content_encoding=res.content_encoding, error=res.error,
        note=profile.note)


# ---------------------------------------------------------------- findings & fixes

def _findings(report: BotSimulationReport) -> list[Finding]:
    out: list[Finding] = []
    results = [(p, r) for p in report.pages for r in p.results]

    def group(pred) -> tuple[list[str], list[str], list[BotResult]]:
        hits = [(p, r) for p, r in results if pred(r)]
        bots = list(dict.fromkeys(r.token for _, r in hits))
        urls = list(dict.fromkeys(p.url for p, _ in hits))
        return bots, urls, [r for _, r in hits]

    bots, urls, rs = group(lambda r: r.outcome == "challenge" and not r.general)
    if rs:
        names = ", ".join(dict.fromkeys(r.protection.name for r in rs if r.protection))
        out.append(Finding("waf_challenge", "critical", f"{len(bots)} AI botu challenge/CAPTCHA sayfasına takılıyor",
                           f"{names}: AI tarayıcıları JavaScript çalıştıramaz ve CAPTCHA çözemez; içerik yerine "
                           f"doğrulama sayfası alıyorlar.", bots, urls))
    bots, urls, rs = group(lambda r: r.outcome in ("blocked", "error") and not r.general)
    if rs:
        names = ", ".join(dict.fromkeys(r.reason for r in rs))
        silent = [r.token for r in rs if r.silent_block]
        out.append(Finding("waf_block", "critical", f"{len(bots)} AI botu sunucu/WAF tarafından reddediliyor",
                           f"{names}." + (f" robots.txt {', '.join(dict.fromkeys(silent))} için izin verdiği hâlde "
                                          f"(sessiz engel)." if silent else ""), bots, urls))
    bots, urls, rs = group(lambda r: r.outcome == "rate_limited" and not r.general)
    if rs:
        out.append(Finding("rate_limited", "warning", f"{len(bots)} AI botu hız sınırına (429) takılıyor",
                           "Düşük hacimli tek isteklerde bile 429 dönüyor; AI botları için rate-limit muafiyeti "
                           "tanımlayın.", bots, urls))
    bots, urls, rs = group(lambda r: r.general and r.outcome in ("blocked", "challenge", "rate_limited", "error"))
    if rs:
        walls = [p.baseline["protection"] for p in report.pages if p.url in urls and p.baseline.get("protection")]
        if any(w["kind"] in ("challenge", "captcha") for w in walls):
            detail = (f"{walls[0]['name']} tüm otomatik istemcilere (tarayıcı simülasyonu dahil) gösteriliyor. Gerçek "
                      f"tarayıcılar JavaScript çalıştırıp geçebilir, AI botları geçemez.")
        else:
            detail = ("Tarayıcı isteği de engellendi: genel bot duvarı, IP/ülke engeli veya site kapalı. AI botları da "
                      "içeriğe ulaşamıyor.")
        out.append(Finding("general_block", "critical", "Bot koruması tüm otomatik istekleri durduruyor", detail,
                           bots, urls))
    bots, urls, rs = group(lambda r: r.outcome == "degraded")
    if rs:
        out.append(Finding("content_parity", "warning", f"{len(bots)} AI botu tarayıcıdan daha az içerik alıyor",
                           "; ".join(f"{r.token}: {r.reason}" for r in rs[:3]), bots, urls))
    bots, urls, rs = group(lambda r: r.robots_allowed is False)
    if rs:
        out.append(Finding("robots_disallow", "warning", f"{len(bots)} AI botu robots.txt ile engelli",
                           "Bu botlar robots.txt'ye uyar ve canlı erişim açık olsa bile sayfayı almaz.", bots, urls))
    bots, urls, rs = group(lambda r: r.accessible and (r.ttfb_ms or 0) > 3000)
    if rs:
        out.append(Finding("slow_response", "warning", "AI botlarına ilk bayt 3 saniyeden geç geliyor",
                           f"En yavaş: {max(r.ttfb_ms or 0 for r in rs)} ms. Kullanıcı tetiklemeli AI getiricileri "
                           f"kısa zaman aşımıyla çalışır.", bots, urls))

    views = [(p, p.ai_view) for p in report.pages if p.ai_view]
    csr = [p.url for p, v in views if v["render"]["mode"] == "csr_shell"]
    if csr:
        v = next(v for p, v in views if p.url == csr[0])
        out.append(Finding("csr_shell", "critical", f"{len(csr)} sayfa AI botlarına boş JS kabuğu döndürüyor",
                           f"{v['render']['reason']}. AI tarayıcıları JavaScript çalıştırmaz; SSR/SSG veya "
                           f"prerender gerekli.", [], csr))
    weak = [p.url for p, v in views if v["render"]["mode"] in ("thin", "heavy_js")]
    if weak:
        v = next(v for p, v in views if p.url == weak[0])
        out.append(Finding("thin_html", "warning", f"{len(weak)} sayfanın sunucu HTML'i zayıf", v["render"]["reason"],
                           [], weak))
    bloat = [(p.url, v["bloat"]["issues"]) for p, v in views if v["bloat"]["issues"]]
    if bloat:
        out.append(Finding("token_bloat", "warning", f"{len(bloat)} sayfada şişkin DOM / gömülü veri",
                           "; ".join(bloat[0][1]), [], [u for u, _ in bloat]))
    low = [(p.url, v["tokens"]) for p, v in views if v["tokens"]["signal_ratio"] < 0.03 and v["tokens"]["html_tokens"] > 5000]
    if low:
        t = low[0][1]
        out.append(Finding("low_signal", "info", "HTML token yükünün çok küçük kısmı okunabilir içerik",
                           f"{t['html_tokens']} HTML token'ının yalnızca {t['text_tokens']}'i metin "
                           f"(%{round(t['signal_ratio'] * 100, 1)}).", [], [u for u, _ in low]))
    uncompressed = [p.url for p, v in views if not v["tokens"]["compressed"] and v["tokens"]["html_kb"] > 20]
    if uncompressed:
        out.append(Finding("no_compression", "info", "HTML yanıtı sıkıştırılmadan gönderiliyor",
                           "gzip/brotli açın; büyük sayfalar AI getiricilerinde zaman aşımına uğrayabilir.", [],
                           uncompressed))
    large = [p.url for p, v in views if v["tokens"]["html_kb"] > 1024]
    if large:
        out.append(Finding("large_html", "warning", "HTML yanıtı 1 MB'tan büyük",
                           "Büyük yanıtlar AI getiricilerinde kesilebilir veya bütçeyi tüketir.", [], large))
    order = {"critical": 0, "warning": 1, "info": 2}
    return sorted(out, key=lambda f: order[f.severity])


def _alternation(names: Iterable[str]) -> str:
    return "|".join(re.escape(n) for n in dict.fromkeys(names))


def build_fixes(bots: list[BotProfile], vendors: Iterable[str] = (), csr_urls: Iterable[str] = (),
                bloat: bool = False, preventive: bool = False) -> list[dict[str, Any]]:
    """Copy-paste allow rules for ``bots`` (the refused ones; all simulated bots when ``preventive``)."""
    vendors = list(vendors)
    crawlers = list(dict.fromkeys(b.crawler for b in bots))
    alt = _alternation(crawlers)
    fixes: list[dict[str, Any]] = []

    def add(fid: str, platform: str, title: str, language: str, code: str, instructions: str) -> None:
        fixes.append({"id": fid, "platform": platform, "title": title, "language": language, "code": code.strip(),
                      "instructions": instructions, "recommended": platform in vendors, "preventive": preventive})

    if crawlers:
        ua_expr = " or ".join(f'(http.user_agent contains "{c}")' for c in crawlers)
        expr = f'{ua_expr} or (cf.verified_bot_category in {{"AI Crawler" "AI Search" "AI Assistant"}})'
        rule = {"description": "Allow AI crawlers (GEO)", "expression": expr, "action": "skip",
                "action_parameters": {"ruleset": "current",
                                      "phases": ["http_ratelimit", "http_request_firewall_managed", "http_request_sbfm"],
                                      "products": ["bic", "hot", "rateLimit", "securityLevel", "uaBlock", "waf",
                                                   "zoneLockdown"]},
                "logging": {"enabled": True}}
        add("cloudflare_waf_skip", "cloudflare", "Cloudflare WAF: AI botları için Skip kuralı", "text", f"""
# Cloudflare → Security → WAF → Custom rules → Create rule (listenin EN ÜSTÜNE taşıyın)
# Rule name: Allow AI crawlers (GEO)
# Expression (Edit expression):
{expr}
# Action: Skip → All remaining custom rules, Rate limiting rules, Managed rules, Super Bot Fight Mode rules
#         + "Log matching requests" açık

# Yalnızca doğrulanmış botlar (UA taklidine kapalı, önerilen sıkı sürüm):
(cf.verified_bot_category in {{"AI Crawler" "AI Search" "AI Assistant"}}) or (cf.client.bot)

# Ayrıca: Security → Bots → "Block AI bots" = Off, "AI Labyrinth" = Off;
# AI Crawl Control → ilgili crawler'lar = Allow. (Ücretsiz plandaki Bot Fight Mode Skip ile atlanamaz → kapatın.)

# Rulesets API (PUT /zones/{{zone_id}}/rulesets/phases/http_request_firewall_custom/entrypoint → rules[0]):
{json.dumps(rule, ensure_ascii=False, indent=2)}""",
            "Kuralı mevcut engelleme kurallarının üstüne yerleştirin; Security Events'te 'Skip' olarak görünmelidir.")

        ua_list = " ".join(f'"{c}"' for c in crawlers)
        add("nginx_allow", "nginx", "nginx: AI botlarını UA engeli ve rate limit'ten muaf tutun", "nginx", f"""
# http {{ }} bloğu (örn. /etc/nginx/conf.d/ai-bots.conf)
map $http_user_agent $is_ai_bot {{
    default 0;
    "~*({alt})" 1;   # {ua_list}
}}
# rate limit anahtarı: AI botları için boş anahtar = limit uygulanmaz
map $is_ai_bot $ai_limit_key {{
    0 $binary_remote_addr;
    1 "";
}}
limit_req_zone $ai_limit_key zone=perip:10m rate=10r/s;

# server {{ }} bloğu — mevcut UA engelinizi AI botları dışında bırakın:
set $block_ua 0;
if ($http_user_agent ~* "(bot|crawl|spider|scrape)") {{ set $block_ua 1; }}   # ← mevcut kuralınız
if ($is_ai_bot = 1) {{ set $block_ua 0; }}
if ($block_ua = 1) {{ return 403; }}""",
            "Mevcut 'deny'/'return 403' ve limit_req kurallarınızı bu değişkenlerle koşullandırıp `nginx -t && "
            "nginx -s reload` çalıştırın.")

        add("apache_allow", "apache", "Apache / LiteSpeed (.htaccess) ve ModSecurity istisnası", "apache", f"""
# .htaccess veya <VirtualHost> — AI botlarını işaretle
SetEnvIfNoCase User-Agent "({alt})" ai_bot

# 1) AI botlarını engelleyen RewriteRule'ları kaldırın veya istisna ekleyin:
RewriteEngine On
RewriteCond %{{ENV:ai_bot}} !^1$
RewriteCond %{{HTTP_USER_AGENT}} (bot|crawl|spider|scrape) [NC]
RewriteRule .* - [F,L]

# 2) Apache 2.4 erişim kuralı (Require not env bad_bot vb. kullanıyorsanız):
<RequireAny>
    Require env ai_bot
    Require all granted
</RequireAny>

# 3) ModSecurity / OWASP CRS tarayıcı tespitinden muaf tutun:
<IfModule mod_security2.c>
    SecRule REQUEST_HEADERS:User-Agent "@rx (?i)({alt})" \\
        "id:1009001,phase:1,pass,nolog,ctl:ruleRemoveByTag=attack-reputation-scanner"
</IfModule>""",
            "Değişiklikten sonra `apachectl configtest && apachectl graceful` çalıştırın.")

        aws_rule = {
            "Name": "allow-ai-crawlers", "Priority": 0,
            "Statement": {"RegexMatchStatement": {"RegexString": f"(?i)({alt})",
                                                  "FieldToMatch": {"SingleHeader": {"Name": "user-agent"}},
                                                  "TextTransformations": [{"Priority": 0, "Type": "NONE"}]}},
            "Action": {"Allow": {}},
            "VisibilityConfig": {"SampledRequestsEnabled": True, "CloudWatchMetricsEnabled": True,
                                 "MetricName": "allow-ai-crawlers"},
        }
        if "aws_waf" in vendors:
            add("aws_waf_allow", "aws_waf", "AWS WAF: AI botları için Allow kuralı + Bot Control istisnası", "json",
                json.dumps({"Rules": [aws_rule], "BotControlOverride": {
                    "ManagedRuleGroupStatement": {"VendorName": "AWS", "Name": "AWSManagedRulesBotControlRuleSet",
                                                  "RuleActionOverrides": [{"Name": "CategoryAI",
                                                                           "ActionToUse": {"Count": {}}}]}}},
                           ensure_ascii=False, indent=2),
                "Allow kuralını Web ACL'de en düşük önceliğe (0) ekleyin; Bot Control'de CategoryAI kuralını "
                "Count'a çekin.")

    console = {
        "akamai": ("Akamai Bot Manager: AI botlarına izin verin",
                   "Security Configurations → Bot Manager → Known Bots → 'AI Crawlers' / 'Web Search Engine Bots' "
                   "kategorilerinin aksiyonunu Allow (veya Monitor) yapın. Özel kural gerekiyorsa User-Agent "
                   f"regex: ({alt})."),
        "imperva": ("Imperva: AI botlarını 'Good bots' olarak işaretleyin",
                    "Website → Security → Bot Protection → Good Bots listesine ilgili AI botlarını ekleyin; "
                    "Client Classification'da 'Search bots/AI' için Block/CAPTCHA aksiyonunu kaldırın."),
        "vercel": ("Vercel Firewall: AI botlarını bypass edin",
                   "Project → Firewall → Bot Management → 'AI Bots' kuralını Log/Off yapın; Custom Rule: "
                   f"User Agent matches ({alt}) → Bypass. Attack Challenge Mode açıksa kapatın."),
        "sucuri": ("Sucuri WAF: AI botlarını allowlist'e ekleyin",
                   "Firewall → Access Control → Allowlist User Agents bölümüne şu UA parçalarını ekleyin: "
                   + ", ".join(crawlers) + "."),
        "datadome": ("DataDome: AI botları için izin kuralı",
                     "Dashboard → Custom Rules → 'User-Agent contains' (" + ", ".join(crawlers) + ") → Allow; "
                     "veya Bot Management'te 'AI Agents' kategorisini Allow yapın."),
        "perimeterx": ("HUMAN (PerimeterX): AI botlarını allowlist'e ekleyin",
                       "Policies → Allowlist → User-Agent: " + ", ".join(crawlers) + "."),
    }
    for v in vendors:
        if v in console and crawlers:
            title, text = console[v]
            add(f"{v}_console", v, title, "text", text, "Yönetim panelinden uygulayın ve simülasyonu tekrar çalıştırın.")

    csr_urls = list(csr_urls)
    if csr_urls:
        add("ssr_render", "nextjs", "İçeriği sunucu tarafında render edin (SSR/SSG/prerender)", "tsx",
            sn.ssr_fix(csr_urls[0]),
            "Next.js/Nuxt/SvelteKit'te SSR veya statik üretim; saf React SPA için prerender (örn. Rendertron, "
            "prerender.io) ya da framework'e geçiş.")
    if bloat:
        add("token_diet", "web", "AI token yükünü azaltın (DOM ve gömülü JSON)", "text", """
# Gömülü durum verisi (__NEXT_DATA__ / RSC / __NUXT__):
#  - getServerSideProps / loader / Server Component'ten yalnızca sayfanın kullandığı alanları döndürün
#  - Büyük listeleri sayfalayın; ürün açıklamalarını hem HTML'de hem JSON'da iki kez göndermeyin
# DOM:
#  - Gizli mega menü / mobil menü kopyalarını ilk HTML'den çıkarıp etkileşimde yükleyin
#  - Satır içi SVG ikonlarını <use href="/sprite.svg#icon"> ile tekrar kullanın; base64 görselleri dosyaya taşıyın
# Aktarım:
#  - gzip/brotli açık olmalı (nginx: gzip on; gzip_types text/html application/json;)""",
            "Hedef: metin token'ı / HTML token'ı oranı ≥ %10, HTML < 500 KB.")
    return fixes


# ---------------------------------------------------------------- orchestration

def _robots_url(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}/robots.txt"


async def simulate_bots(
    urls: Iterable[str],
    bots: Iterable[str] = DEFAULT_BOTS,
    *,
    client: httpx.AsyncClient | None = None,
    robots_txt: str | None = None,
    robots_status: int | None = None,
    fetch_robots: bool = True,
    timeout: float = 15.0,
    delay: float = 0.25,
    concurrency: int = 2,
) -> BotSimulationReport:
    """Fetch every URL as each bot (and once as a browser) and diagnose the responses.

    ``client``: shared client (tests). Without it every identity gets its own cookie-less client, so challenge
    cookies earned by one identity never leak to another. ``delay`` spaces requests per identity so the
    simulation itself does not trip rate limits.
    """
    targets = [u for u in dict.fromkeys(normalize_url(u) or u for u in urls) if u]
    if not targets:
        raise ValueError("en az bir URL gerekli")
    profiles = [BOT_PROFILES[b] for b in dict.fromkeys(bots) if b in BOT_PROFILES]
    unknown = [b for b in bots if b not in BOT_PROFILES]
    if unknown:
        raise ValueError(f"bilinmeyen bot: {', '.join(unknown)} (desteklenen: {', '.join(BOT_PROFILES)})")

    owned: list[httpx.AsyncClient] = []

    def client_for(_identity: str) -> httpx.AsyncClient:
        if client is not None:
            return client
        c = httpx.AsyncClient(follow_redirects=True, max_redirects=10, timeout=timeout)
        owned.append(c)
        return c

    sem = asyncio.Semaphore(max(1, concurrency))

    async def get(c: httpx.AsyncClient, url: str, headers: dict[str, str], identity: str) -> FetchResult:
        async with sem:
            res = await fetch(c, url, headers, identity)
            if delay:
                await asyncio.sleep(delay)
            return res

    try:
        browser = client_for("browser")
        rules = None
        if robots_txt is None and fetch_robots:
            r = await get(browser, _robots_url(targets[0]), BROWSER_HEADERS, "browser")
            robots_status = r.status
            robots_txt = r.body if r.status == 200 and "<html" not in r.body[:500].lower() else ""
        if robots_txt is not None:
            rules = parse_robots_rules(robots_txt)

        bot_clients = {p.token: client_for(p.token) for p in profiles}
        pages: list[PageSimulation] = []
        for url in targets:
            base_res = await get(browser, url, BROWSER_HEADERS, "browser")
            baseline = _baseline_meta(base_res)
            fetched = await asyncio.gather(*(get(bot_clients[p.token], url, bot_headers(p), p.token) for p in profiles))
            results: list[BotResult] = []
            for p, res in zip(profiles, fetched):
                allowed = None
                if rules is not None:
                    allowed = (robots_status is None or robots_status < 500) and evaluate(rules.group_for(p.token)[1], url)
                results.append(_bot_result(p, res, baseline, allowed,
                                           baseline["words"] if baseline["outcome"] == "ok" else 0))
            # AI view: the first bot that got the page; else the browser copy (what bots get once unblocked)
            view_src = next(((r.token, res) for r, res in zip(results, fetched) if r.accessible and res.body), None)
            if view_src is None and baseline["outcome"] == "ok" and base_res.body:
                view_src = ("browser", base_res)
            ai_view = _analyze_view(view_src[1], view_src[0]) if view_src else None
            pages.append(PageSimulation(url=url, baseline=baseline, results=results, ai_view=ai_view))
    finally:
        for c in owned:
            await c.aclose()

    origin = "{0.scheme}://{0.netloc}".format(urlsplit(targets[0]))
    report = BotSimulationReport(origin=origin, bots=[p.token for p in profiles], pages=pages,
                                 robots_status=robots_status)
    report.findings = _findings(report)
    blocked = report.blocked_bots()
    csr = next((f.urls for f in report.findings if f.code == "csr_shell"), [])
    bloat = any(f.code == "token_bloat" for f in report.findings)
    report.fixes = build_fixes([BOT_PROFILES[t] for t in (blocked or report.bots)], report.vendors(), csr, bloat,
                               preventive=not blocked)
    if blocked:
        report.caveats.append(
            "Simülasyon AI sağlayıcılarının IP aralıklarından değil, bu sunucudan yapıldı. WAF botları IP ile "
            "doğruluyorsa (örn. Cloudflare verified bots) gerçek botların sonucu farklı olabilir; WAF olay "
            "kayıtlarında (Security Events) doğrulayın.")
    if any(t in ("Google-Extended", "Applebot-Extended") for t in report.bots):
        report.caveats.append("Google-Extended ve Applebot-Extended yalnızca robots.txt jetonudur; canlı istek "
                              "Googlebot/Applebot kimliğiyle yapıldı.")
    return report


# ---------------------------------------------------------------- CLI

def render_text(report: BotSimulationReport) -> str:
    out = [f"AI BOT SİMÜLASYONU: {report.score}/100 ({grade(report.score)}) — erişim {report.access_score}, "
           f"render {report.render_score}, token {report.token_score}"]
    for p in report.pages:
        b = p.baseline
        out.append(f"\n■ {p.url}  [tarayıcı: HTTP {b['status']}, {b['words']} kelime"
                   + (f", CDN {b['cdn']}" if b.get("cdn") else "") + "]")
        for r in p.results:
            mark = "✓" if r.accessible else "✗"
            robots = {True: "robots: izinli", False: "robots: YASAK", None: "robots: ?"}[r.robots_allowed]
            out.append(f"   {mark} {r.token:<18} {OUTCOME_LABELS[r.outcome]:<17} {r.reason}  ({robots})")
        if p.ai_view:
            rv, tk = p.ai_view["render"], p.ai_view["tokens"]
            out.append(f"   render: {rv['mode']} — {rv['reason']}")
            out.append(f"   token: HTML {tk['html_tokens']} / metin {tk['text_tokens']} ({tk['method']}), "
                       f"{tk['html_kb']} KB" + (f" → {tk['transfer_kb']} KB {tk['content_encoding']}"
                                                if tk["compressed"] else " (sıkıştırma yok)"))
    if report.findings:
        out.append("\nBULGULAR")
        out += [f" [{f.severity.upper()}] {f.title} — {f.detail}" for f in report.findings]
    if report.fixes:
        out.append("\nÇÖZÜM REÇETELERİ: " + ", ".join(f["title"] for f in report.fixes))
    out += [f"\nNot: {c}" for c in report.caveats]
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="geo-botsim", description="Live AI crawler simulation (WAF / render / tokens)")
    ap.add_argument("urls", nargs="+", help="one or more live URLs of the same site")
    ap.add_argument("--bots", default=",".join(DEFAULT_BOTS),
                    help=f"comma separated robots tokens (available: {', '.join(BOT_PROFILES)})")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--delay", type=float, default=0.25, help="seconds between requests of one identity")
    ap.add_argument("--json", action="store_true", help="print the JSON report")
    ap.add_argument("--code", action="store_true", help="print fix recipes in the text report")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    try:
        report = asyncio.run(simulate_bots(args.urls, [b.strip() for b in args.bots.split(",") if b.strip()],
                                           timeout=args.timeout, delay=args.delay))
    except ValueError as exc:
        print(f"geo-botsim: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(render_text(report))
        if args.code:
            for f in report.fixes:
                print(f"\n### {f['title']}\n{f['code']}")
    return 0 if report.access_score == 100 else 1


if __name__ == "__main__":
    raise SystemExit(main())
