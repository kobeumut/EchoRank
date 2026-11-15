"""SSRF guard: private/internal targets are refused on the first request and on redirect hops."""
import httpx
import pytest
import respx

from geo_crawler import CrawlConfig, index_site
from geo_crawler.netguard import BlockedTargetError, GUARD_HOOKS, check_url_sync, is_blocked_address


@pytest.fixture(autouse=True)
def _guard_on(monkeypatch):
    monkeypatch.delenv("ALLOW_PRIVATE_NETWORK_TARGETS", raising=False)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
                                "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "garbage"])
def test_blocked_addresses(ip):
    assert is_blocked_address(ip)


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
def test_public_addresses_are_allowed(ip):
    assert not is_blocked_address(ip)


@pytest.mark.parametrize("url", ["http://localhost:8000/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data",
                                 "http://db.internal/", "http://2130706433/"])
def test_check_url_sync_blocks_internal_targets(url):
    with pytest.raises(BlockedTargetError):
        check_url_sync(url)


def test_env_switch_allows_private_targets(monkeypatch):
    monkeypatch.setenv("ALLOW_PRIVATE_NETWORK_TARGETS", "true")
    check_url_sync("http://127.0.0.1/")


async def test_client_refuses_redirect_to_internal_address():
    with respx.mock(assert_all_called=False) as router:
        router.get("http://8.8.8.8/start").mock(return_value=httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"}))
        metadata = router.get("http://169.254.169.254/latest/meta-data").mock(return_value=httpx.Response(200, text="secret"))
        async with httpx.AsyncClient(follow_redirects=True, event_hooks=GUARD_HOOKS) as client:
            with pytest.raises(BlockedTargetError):
                await client.get("http://8.8.8.8/start")
        assert not metadata.called  # the internal hop was never requested


async def test_crawler_does_not_index_a_site_that_resolves_to_localhost():
    result = await index_site("http://127.0.0.1:9/", CrawlConfig(max_depth=1, max_pages=3, requests_per_second=0))
    assert result.crawl.ok_pages == []
    assert all(page.error for page in result.crawl.pages.values())
