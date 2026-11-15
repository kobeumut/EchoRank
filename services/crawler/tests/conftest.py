import sys
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).parent))
from fixtures import BASE, FakeSite  # noqa: E402

from geo_crawler import CrawlConfig, index_site  # noqa: E402


@pytest.fixture
def fake_site():
    site = FakeSite()
    with respx.mock(assert_all_called=False) as router:
        router.route(host="shop.example.com").mock(side_effect=site)
        yield site


@pytest.fixture
async def indexed(fake_site):
    cfg = CrawlConfig(max_depth=3, max_pages=50, concurrency=4, requests_per_second=0)
    return await index_site(BASE + "/", cfg)


@pytest.fixture(autouse=True)
def _allow_private_targets_for_mocked_hosts(monkeypatch):
    """Tests use respx-mocked fake hosts; keep them hermetic (no DNS). SSRF-guard tests unset this explicitly."""
    monkeypatch.setenv("ALLOW_PRIVATE_NETWORK_TARGETS", "true")
