"""Site-level signals that are not part of a page crawl: llms.txt, HTTPS/HSTS, AI user-agent (WAF) probes."""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx

from ..i18n import DEFAULT_LANG, get_translator
from ..urls import normalize_url
from .robots import PROBE_USER_AGENTS

log = logging.getLogger(__name__)

BLOCK_STATUSES = (401, 403, 406, 429, 451, 503)
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


@dataclass
class ContextFile:
    path: str
    status: int | None = None
    content_type: str = ""
    text: str = ""
    valid: bool = False
    issues: list[str] = field(default_factory=list)
    links: int = 0
    sections: int = 0


@dataclass
class SiteSignals:
    origin: str
    https: bool = False
    http_redirects_to_https: bool | None = None
    hsts: bool = False
    robots_txt: str | None = None  # None = not fetched by the probe (crawl result is used instead)
    robots_status: int | None = None
    llms_txt: ContextFile | None = None
    llms_full_txt: ContextFile | None = None
    # bot token -> {"status": int|None, "baseline": int|None, "blocked": bool}
    ua_probe: dict[str, dict[str, Any]] = field(default_factory=dict)
    homepage_x_robots: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for k in ("llms_txt", "llms_full_txt"):
            if d.get(k):
                d[k]["text"] = d[k]["text"][:2000]
        return d


_LINK_RE = re.compile(r"^\s*[-*]\s*\[[^\]]+\]\([^)]+\)", re.M)


def validate_llms_txt(text: str, *, lang: str = DEFAULT_LANG) -> tuple[bool, list[str], int, int]:
    """Checks the llmstxt.org shape: H1 title, optional ``>`` summary, ``##`` sections of markdown link lists.

    Returns ``(valid, issues, links, sections)``; the issue texts are written in ``lang``."""
    t = get_translator(lang)
    issues: list[str] = []
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return False, [t("signals.llms.empty")], 0, 0
    if lines[0].lstrip().startswith("<"):
        return False, [t("signals.llms.html_response")], 0, 0
    if not lines[0].startswith("# "):
        issues.append(t("signals.llms.no_h1"))
    if not any(ln.startswith(">") for ln in lines[:5]):
        issues.append(t("signals.llms.no_summary"))
    sections = sum(1 for ln in lines if ln.startswith("## "))
    links = len(_LINK_RE.findall(text))
    if sections == 0:
        issues.append(t("signals.llms.no_sections"))
    if links == 0:
        issues.append(t("signals.llms.no_links"))
    valid = lines[0].startswith("# ") and links > 0
    return valid, issues, links, sections


async def _fetch_context_file(client: httpx.AsyncClient, origin: str, path: str, lang: str) -> ContextFile:
    t = get_translator(lang)
    cf = ContextFile(path=path)
    try:
        resp = await client.get(normalize_url(path, origin) or origin + path)
    except httpx.HTTPError as exc:
        cf.issues.append(t("signals.llms.unreachable", error=type(exc).__name__))
        return cf
    cf.status = resp.status_code
    cf.content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
    if resp.status_code != 200:
        return cf
    cf.text = resp.text[:200_000]
    if cf.content_type == "text/html":
        cf.issues.append(t("signals.llms.wrong_content_type"))
    cf.valid, issues, cf.links, cf.sections = validate_llms_txt(cf.text, lang=lang)
    cf.issues.extend(issues)
    if cf.content_type == "text/html":
        cf.valid = False
    return cf


async def _status(client: httpx.AsyncClient, url: str, ua: str) -> int | None:
    try:
        resp = await client.get(url, headers={"User-Agent": ua})
        return resp.status_code
    except httpx.HTTPError:
        return None


async def collect_site_signals(
    origin: str,
    client: httpx.AsyncClient | None = None,
    probe_user_agents: bool = True,
    fetch_robots: bool = False,
    timeout: float = 10.0,
    *,
    lang: str = DEFAULT_LANG,
) -> SiteSignals:
    """Fetch llms.txt, HTTPS/HSTS and AI user-agent probes; the llms.txt issue texts are written in ``lang``."""
    root = normalize_url(origin) or origin
    parts = httpx.URL(root)
    sig = SiteSignals(origin=root, https=parts.scheme == "https")
    own = client is None
    client = client or httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers={"User-Agent": BROWSER_UA})
    try:
        try:
            home = await client.get(root)
            final = home.url
            sig.https = final.scheme == "https"
            sig.hsts = "strict-transport-security" in home.headers
            sig.homepage_x_robots = home.headers.get("x-robots-tag", "")
            baseline: int | None = home.status_code
        except httpx.HTTPError as exc:
            log.info("homepage fetch failed: %s", exc)
            baseline = None

        if sig.https:
            try:
                plain = await client.get(str(parts.copy_with(scheme="http")), follow_redirects=True)
                sig.http_redirects_to_https = plain.url.scheme == "https"
            except httpx.HTTPError:
                sig.http_redirects_to_https = None

        sig.llms_txt, sig.llms_full_txt = await asyncio.gather(
            _fetch_context_file(client, root, "/llms.txt", lang),
            _fetch_context_file(client, root, "/llms-full.txt", lang))

        if fetch_robots:
            try:
                r = await client.get(normalize_url("/robots.txt", root) or root + "/robots.txt")
                sig.robots_status = r.status_code
                sig.robots_txt = r.text if r.status_code == 200 else ""
            except httpx.HTTPError:
                sig.robots_status = None

        if probe_user_agents:
            statuses = await asyncio.gather(*(_status(client, root, ua) for ua in PROBE_USER_AGENTS.values()))
            for token, st in zip(PROBE_USER_AGENTS, statuses):
                # a real AI crawler gets the same answer; "general" = browsers are refused too (bot wall / geo block)
                blocked = st is None or st in BLOCK_STATUSES
                sig.ua_probe[token] = {"status": st, "baseline": baseline, "blocked": blocked,
                                       "general": blocked and (baseline is None or baseline in BLOCK_STATUSES)}
    finally:
        if own:
            await client.aclose()
    return sig
