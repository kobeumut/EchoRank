"""Asynchronous, polite, depth/rate-limited site crawler."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Awaitable, Callable

import httpx

from .classifier import classify_page
from .models import CrawlResult, PageData
from .netguard import GUARD_HOOKS
from .parser import parse_html
from .sitemap import RobotsInfo, discover_sitemap_urls, fetch_robots
from .urls import is_crawlable_resource, is_internal, normalize_url

log = logging.getLogger(__name__)

# response headers kept on PageData for the scoring module
AUDIT_HEADERS = ("x-robots-tag", "strict-transport-security", "last-modified", "content-security-policy",
                 "cache-control", "server")

DEFAULT_UA = "GeoScoreBot/0.1 (+https://github.com/kobeumut; GEO/SEO audit crawler)"


@dataclass
class CrawlConfig:
    max_depth: int = 3
    max_pages: int = 200
    concurrency: int = 5
    requests_per_second: float = 5.0  # global rate limit; <=0 disables
    timeout: float = 15.0
    user_agent: str = DEFAULT_UA
    respect_robots: bool = True
    use_sitemap: bool = True
    follow_nofollow: bool = False
    max_body_bytes: int = 5_000_000


class RateLimiter:
    """Simple global min-interval limiter shared by all workers."""

    def __init__(self, rps: float):
        self.interval = 1.0 / rps if rps > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def wait(self) -> None:
        if self.interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            delay = self._next - now
            self._next = max(now, self._next) + self.interval
        if delay > 0:
            await asyncio.sleep(delay)


ProgressCallback = Callable[[PageData, int, int], Awaitable[None] | None]


class SiteCrawler:
    def __init__(
        self,
        start_url: str,
        config: CrawlConfig | None = None,
        client: httpx.AsyncClient | None = None,
        on_page: ProgressCallback | None = None,
    ):
        root = normalize_url(start_url)
        if not root:
            raise ValueError(f"Invalid start URL: {start_url!r}")
        self.root = root
        self.config = config or CrawlConfig()
        self._client = client
        self._owns_client = client is None
        self.on_page = on_page
        self.robots = RobotsInfo()

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                follow_redirects=True,
                event_hooks=GUARD_HOOKS,  # SSRF: refuse private addresses, including redirect targets
                timeout=self.config.timeout,
                headers={"User-Agent": self.config.user_agent, "Accept": "text/html,application/xhtml+xml"},
                limits=httpx.Limits(max_connections=self.config.concurrency * 2),
            )
        return self._client

    def _allowed(self, url: str) -> bool:
        if not is_internal(url, self.root) or not is_crawlable_resource(url):
            return False
        if self.config.respect_robots and not self.robots.can_fetch(url, self.config.user_agent):
            return False
        return True

    async def crawl(self) -> CrawlResult:
        cfg = self.config
        client = await self._get_client()
        result = CrawlResult(start_url=self.root, started_at=datetime.now(timezone.utc).isoformat())
        try:
            if cfg.respect_robots or cfg.use_sitemap:
                self.robots = await fetch_robots(client, self.root)
                result.robots_disallowed = self.robots.disallowed
                result.robots_txt = self.robots.raw
                result.robots_status = self.robots.status
            rps = cfg.requests_per_second
            if self.robots.crawl_delay and cfg.respect_robots:
                rps = min(rps, 1.0 / self.robots.crawl_delay) if rps > 0 else 1.0 / self.robots.crawl_delay
            limiter = RateLimiter(rps)

            # priority: (depth, template-link penalty, discovery order) -> content links before nav links
            queue: asyncio.PriorityQueue[tuple[int, int, int, str, bool]] = asyncio.PriorityQueue()
            enqueued: set[str] = set()
            seq = 0
            fetched = 0

            def enqueue(url: str, depth: int, from_sitemap: bool = False, penalty: int = 0) -> None:
                nonlocal seq
                if url in enqueued or depth > cfg.max_depth or not self._allowed(url):
                    return
                enqueued.add(url)
                seq += 1
                queue.put_nowait((depth, penalty, seq, url, from_sitemap))

            enqueue(self.root, 0)
            if cfg.use_sitemap:
                sm_urls, _ = await discover_sitemap_urls(client, self.root, self.robots)
                result.sitemap_urls = {u for u in sm_urls if is_internal(u, self.root)}
                # sitemap pages are seeded at depth 1 so they get crawled even if unlinked
                for u in sorted(result.sitemap_urls):
                    enqueue(u, min(1, cfg.max_depth), True)

            async def worker() -> None:
                nonlocal fetched
                while True:
                    depth, _, _, url, from_sitemap = await queue.get()
                    try:
                        if fetched >= cfg.max_pages:
                            continue  # drain remaining queue without fetching
                        fetched += 1
                        page = await self._fetch(client, limiter, url, depth)
                        page.from_sitemap = from_sitemap or url in result.sitemap_urls
                        # redirects: store under the final URL and mark it seen
                        if page.url != url and page.url in result.pages:
                            continue
                        enqueued.add(page.url)
                        result.pages[page.url] = page
                        if page.error:
                            result.errors[url] = page.error
                        else:
                            for link in page.internal_links:
                                if link.nofollow and not cfg.follow_nofollow:
                                    continue
                                enqueue(link.url, depth + 1, penalty=int(link.in_nav))
                        if self.on_page:
                            maybe = self.on_page(page, len(result.pages), min(len(enqueued), cfg.max_pages))
                            if asyncio.iscoroutine(maybe):
                                await maybe
                    except Exception as exc:  # never kill a worker
                        log.exception("worker error for %s", url)
                        result.errors[url] = repr(exc)
                    finally:
                        queue.task_done()

            workers = [asyncio.create_task(worker()) for _ in range(max(1, cfg.concurrency))]
            await queue.join()
            for w in workers:
                w.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
        finally:
            result.finished_at = datetime.now(timezone.utc).isoformat()
            if self._owns_client and self._client is not None:
                await self._client.aclose()
                self._client = None
        return result

    async def _fetch(self, client: httpx.AsyncClient, limiter: RateLimiter, url: str, depth: int) -> PageData:
        await limiter.wait()
        try:
            resp = await client.get(url)
        except httpx.HTTPError as exc:
            return PageData(url=url, status_code=0, depth=depth, error=f"{type(exc).__name__}: {exc}")
        final_url = normalize_url(str(resp.url)) or url
        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if resp.status_code >= 400:
            return PageData(url=url, status_code=resp.status_code, depth=depth, content_type=ctype, error=f"HTTP {resp.status_code}")
        if ctype and ctype not in ("text/html", "application/xhtml+xml"):
            return PageData(url=url, status_code=resp.status_code, depth=depth, content_type=ctype, error=f"non-html content: {ctype}")
        body = resp.content[: self.config.max_body_bytes]
        page = parse_html(body, final_url, self.root, resp.status_code, depth)
        page.content_type = ctype or "text/html"
        page.headers = {k: resp.headers[k] for k in AUDIT_HEADERS if k in resp.headers}
        page.page_type = classify_page(page, self.root)
        return page


async def crawl_site(start_url: str, config: CrawlConfig | None = None, **kwargs) -> CrawlResult:
    return await SiteCrawler(start_url, config, **kwargs).crawl()
