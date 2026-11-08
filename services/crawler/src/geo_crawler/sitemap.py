"""robots.txt and sitemap.xml discovery / parsing."""
from __future__ import annotations

import gzip
import logging
from dataclasses import dataclass, field
from urllib.robotparser import RobotFileParser

import httpx
from lxml import etree

from .urls import normalize_url

log = logging.getLogger(__name__)


@dataclass
class RobotsInfo:
    raw: str = ""
    sitemaps: list[str] = field(default_factory=list)
    disallowed: list[str] = field(default_factory=list)
    crawl_delay: float | None = None
    status: int | None = None  # HTTP status of /robots.txt (None = network error / not fetched)
    _parser: RobotFileParser | None = None

    def can_fetch(self, url: str, user_agent: str = "*") -> bool:
        if self._parser is None:
            return True
        return self._parser.can_fetch(user_agent, url)


def parse_robots(text: str, user_agent: str = "*") -> RobotsInfo:
    parser = RobotFileParser()
    parser.parse(text.splitlines())
    sitemaps: list[str] = []
    disallowed: list[str] = []
    in_star_group = False
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = (s.strip() for s in line.split(":", 1))
        key = key.lower()
        if key == "sitemap" and value:
            sitemaps.append(value)
        elif key == "user-agent":
            in_star_group = value == "*"
        elif key == "disallow" and in_star_group and value:
            disallowed.append(value)
    delay = parser.crawl_delay(user_agent)
    return RobotsInfo(
        raw=text,
        sitemaps=sitemaps,
        disallowed=disallowed,
        crawl_delay=float(delay) if delay is not None else None,
        _parser=parser,
    )


@dataclass
class SitemapParseResult:
    urls: list[str] = field(default_factory=list)
    sitemaps: list[str] = field(default_factory=list)  # nested (sitemap index)
    lastmod: dict[str, str] = field(default_factory=dict)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def parse_sitemap(content: bytes) -> SitemapParseResult:
    """Parse a urlset or sitemapindex document (optionally gzipped)."""
    if content[:2] == b"\x1f\x8b":
        content = gzip.decompress(content)
    result = SitemapParseResult()
    try:
        root = etree.fromstring(
            content, parser=etree.XMLParser(recover=True, resolve_entities=False, no_network=True)
        )
    except etree.XMLSyntaxError:
        return result
    if root is None:
        return result
    kind = _local(root.tag)
    for entry in root:
        if _local(entry.tag) not in ("url", "sitemap"):
            continue
        loc = lastmod = None
        for child in entry:
            name = _local(child.tag)
            if name == "loc" and child.text:
                loc = child.text.strip()
            elif name == "lastmod" and child.text:
                lastmod = child.text.strip()
        if not loc:
            continue
        if kind == "sitemapindex":
            result.sitemaps.append(loc)
        else:
            result.urls.append(loc)
            if lastmod:
                result.lastmod[loc] = lastmod
    return result


async def fetch_robots(client: httpx.AsyncClient, root_url: str) -> RobotsInfo:
    url = normalize_url("/robots.txt", root_url)
    try:
        resp = await client.get(url)
        if resp.status_code == 200:
            info = parse_robots(resp.text)
            info.status = 200
            return info
        return RobotsInfo(status=resp.status_code)
    except httpx.HTTPError as exc:
        log.info("robots.txt fetch failed: %s", exc)
    return RobotsInfo()


async def discover_sitemap_urls(
    client: httpx.AsyncClient,
    root_url: str,
    robots: RobotsInfo | None = None,
    max_sitemaps: int = 50,
    max_urls: int = 50_000,
) -> tuple[set[str], dict[str, str]]:
    """Walk robots-declared sitemaps (or /sitemap.xml fallback), following sitemap indexes."""
    queue: list[str] = list(robots.sitemaps) if robots and robots.sitemaps else []
    if not queue:
        queue = [normalize_url("/sitemap.xml", root_url), normalize_url("/sitemap_index.xml", root_url)]
    seen: set[str] = set()
    urls: set[str] = set()
    lastmod: dict[str, str] = {}
    while queue and len(seen) < max_sitemaps and len(urls) < max_urls:
        sm = queue.pop(0)
        if not sm or sm in seen:
            continue
        seen.add(sm)
        try:
            resp = await client.get(sm)
        except httpx.HTTPError as exc:
            log.info("sitemap fetch failed %s: %s", sm, exc)
            continue
        if resp.status_code != 200:
            continue
        parsed = parse_sitemap(resp.content)
        queue.extend(s for s in parsed.sitemaps if s not in seen)
        for u in parsed.urls:
            n = normalize_url(u)
            if n:
                urls.add(n)
                if u in parsed.lastmod:
                    lastmod[n] = parsed.lastmod[u]
    return urls, lastmod
