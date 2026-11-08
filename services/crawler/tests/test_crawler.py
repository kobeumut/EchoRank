import asyncio
import time

import pytest
from fixtures import BASE

from geo_crawler import CrawlConfig, SiteCrawler
from geo_crawler.crawler import RateLimiter


async def test_crawl_discovers_pages(fake_site):
    res = await SiteCrawler(BASE, CrawlConfig(requests_per_second=0)).crawl()
    ok = {p.url for p in res.ok_pages}
    for path in ["/", "/kategori/kahve-makineleri", "/urun/barista-pro-x", "/urun/mini-espresso",
                 "/urun/filtre-klasik", "/blog/espresso-rehberi", "/sss", "/hakkimizda", "/iletisim",
                 "/kampanya-gizli"]:
        assert BASE + path in ok, path
    # sitemap index followed
    assert BASE + "/kampanya-gizli" in res.sitemap_urls
    assert res.pages[BASE + "/kampanya-gizli"].from_sitemap
    # robots disallow honoured
    assert "/admin/panel" not in fake_site.requests
    assert res.robots_disallowed == ["/admin/"]
    # 404 recorded as error
    assert res.pages[BASE + "/kirik-sayfa"].status_code == 404
    assert BASE + "/kirik-sayfa" in res.errors
    # redirect collapsed onto final URL, not duplicated
    assert BASE + "/eski-urun" not in res.pages
    # external / mailto never fetched
    assert all(not p.startswith("mailto") for p in fake_site.requests)
    # each page fetched once
    html_reqs = [r for r in fake_site.requests if not r.endswith((".txt", ".xml"))]
    assert html_reqs.count("/urun/mini-espresso") == 1


async def test_depth_limit(fake_site):
    res = await SiteCrawler(BASE, CrawlConfig(max_depth=0, use_sitemap=False, requests_per_second=0)).crawl()
    assert set(res.pages) == {BASE + "/"}
    res = await SiteCrawler(BASE, CrawlConfig(max_depth=1, use_sitemap=False, requests_per_second=0)).crawl()
    assert BASE + "/urun/barista-pro-x" in res.pages
    assert BASE + "/urun/mini-espresso" not in res.pages  # depth 2
    assert all(p.depth <= 1 for p in res.pages.values())


async def test_max_pages(fake_site):
    res = await SiteCrawler(BASE, CrawlConfig(max_pages=3, requests_per_second=0)).crawl()
    assert len(res.pages) <= 3


async def test_ignore_robots(fake_site):
    res = await SiteCrawler(BASE, CrawlConfig(respect_robots=False, use_sitemap=False, requests_per_second=0)).crawl()
    assert BASE + "/admin/panel" in res.pages


async def test_progress_callback(fake_site):
    seen = []

    async def cb(page, done, total):
        seen.append(page.url)

    await SiteCrawler(BASE, CrawlConfig(requests_per_second=0), on_page=cb).crawl()
    assert BASE + "/" in seen


async def test_rate_limiter_spacing():
    rl = RateLimiter(20)  # 50ms interval
    t0 = time.monotonic()
    await asyncio.gather(*(rl.wait() for _ in range(5)))
    assert time.monotonic() - t0 >= 0.18


def test_invalid_url():
    with pytest.raises(ValueError):
        SiteCrawler("ftp://nope")
