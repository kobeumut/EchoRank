import gzip

from geo_crawler.sitemap import parse_robots, parse_sitemap
from geo_crawler.urls import is_crawlable_resource, is_internal, normalize_url


def test_normalize_url():
    assert normalize_url("HTTPS://Shop.Example.com:443/a//b?utm_source=x&b=2&a=1#frag") == "https://shop.example.com/a/b?a=1&b=2"
    assert normalize_url("../c", "https://x.com/a/b/") == "https://x.com/a/c"
    assert normalize_url("mailto:a@b.com") is None
    assert normalize_url("javascript:void(0)") is None
    assert normalize_url("https://x.com") == "https://x.com/"


def test_internal_and_resources():
    assert is_internal("https://www.x.com/a", "https://x.com/")
    assert not is_internal("https://y.com/a", "https://x.com/")
    assert not is_crawlable_resource("https://x.com/img/a.PNG")
    assert is_crawlable_resource("https://x.com/urun/a")


def test_parse_robots():
    r = parse_robots("User-agent: *\nDisallow: /admin/\nCrawl-delay: 2\nSitemap: https://x.com/sm.xml\n")
    assert r.sitemaps == ["https://x.com/sm.xml"]
    assert r.disallowed == ["/admin/"]
    assert r.crawl_delay == 2.0
    assert not r.can_fetch("https://x.com/admin/a")
    assert r.can_fetch("https://x.com/urun/a")


def test_parse_sitemap_urlset_index_and_gzip():
    urlset = b"""<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc> https://x.com/a </loc><lastmod>2026-01-01</lastmod></url><url><loc>https://x.com/b</loc></url></urlset>"""
    res = parse_sitemap(urlset)
    assert res.urls == ["https://x.com/a", "https://x.com/b"]
    assert res.lastmod["https://x.com/a"] == "2026-01-01"
    idx = parse_sitemap(b"""<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>""")
    assert idx.sitemaps == ["https://x.com/s1.xml"] and idx.urls == []
    assert parse_sitemap(gzip.compress(urlset)).urls == res.urls
    assert parse_sitemap(b"not xml at all").urls == []
