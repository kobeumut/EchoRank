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


# --- DNS pinning (no rebinding between the check and the connection) -----------------------------------------
import http.server  # noqa: E402
import threading  # noqa: E402

from geo_crawler import netguard  # noqa: E402
from geo_crawler.netguard import PinnedAsyncTransport, PinnedTransport, guarded_async_client, guarded_client  # noqa: E402


class _Recorder:
    def __init__(self, responses=None):
        self.requests: list[httpx.Request] = []
        self.responses = responses or {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responses.get(request.url.path, httpx.Response(200, text="ok"))


def _sequence_resolver(*answers):
    calls = list(answers)

    async def resolve(host, port):
        return calls.pop(0) if len(calls) > 1 else calls[0]
    return resolve


def _pinned_client(resolver, recorder):
    transport = PinnedAsyncTransport(resolver=resolver, transport_factory=lambda: httpx.MockTransport(recorder))
    return httpx.AsyncClient(transport=transport, follow_redirects=True)


async def test_connection_is_pinned_to_the_validated_address():
    rec = _Recorder()
    async with _pinned_client(_sequence_resolver(["93.184.216.34"]), rec) as client:
        res = await client.get("https://shop.example.com/page?x=1")
    sent = rec.requests[0]
    assert sent.url.host == "93.184.216.34" and sent.url.path == "/page" and sent.url.query == b"x=1"
    assert sent.headers["host"] == "shop.example.com"  # virtual host kept
    assert sent.extensions["sni_hostname"] == "shop.example.com"  # TLS name / certificate check kept
    assert str(res.url) == "https://shop.example.com/page?x=1"  # callers still see the original URL


async def test_rebinding_on_a_redirect_hop_is_refused():
    """First answer is public, the next one (after the check of hop 1) points at the metadata service."""
    rec = _Recorder({"/start": httpx.Response(302, headers={"location": "/next"})})
    async with _pinned_client(_sequence_resolver(["93.184.216.34"], ["169.254.169.254"]), rec) as client:
        with pytest.raises(BlockedTargetError):
            await client.get("http://rebind.example.com/start")
    assert [r.url.host for r in rec.requests] == ["93.184.216.34"]  # nothing ever went to the internal address


async def test_mixed_public_and_private_answers_are_refused():
    rec = _Recorder()
    async with _pinned_client(_sequence_resolver(["93.184.216.34", "10.0.0.7"]), rec) as client:
        with pytest.raises(BlockedTargetError):
            await client.get("http://mixed.example.com/")
    assert rec.requests == []


async def test_ipv6_answers_are_pinned_with_brackets():
    rec = _Recorder()
    async with _pinned_client(_sequence_resolver(["2606:4700:4700::1111"]), rec) as client:
        await client.get("https://v6.example.com/")
    assert rec.requests[0].url.host == "2606:4700:4700::1111"
    assert rec.requests[0].headers["host"] == "v6.example.com"


async def test_hosts_get_separate_connection_pools():
    created = []

    def factory():
        created.append(httpx.MockTransport(_Recorder()))
        return created[-1]
    transport = PinnedAsyncTransport(resolver=_sequence_resolver(["93.184.216.34"]), transport_factory=factory)
    async with httpx.AsyncClient(transport=transport) as client:
        await client.get("https://a.example.com/")
        await client.get("https://a.example.com/again")
        await client.get("https://b.example.com/")  # same IP, different TLS name: never reuse a's connection
    assert len(created) == 2


def test_sync_transport_pins_and_refuses_rebinding():
    rec = _Recorder({"/start": httpx.Response(302, headers={"location": "/next"})})
    answers = [["93.184.216.34"], ["127.0.0.1"]]
    transport = PinnedTransport(resolver=lambda host, port: answers.pop(0), transport_factory=lambda: httpx.MockTransport(rec))
    with httpx.Client(transport=transport, follow_redirects=True) as client:
        with pytest.raises(BlockedTargetError):
            client.get("http://rebind.example.com/start")
    assert [r.url.host for r in rec.requests] == ["93.184.216.34"]


def test_guarded_clients_use_the_pinned_transport():
    with guarded_client(timeout=5) as client:
        with pytest.raises(BlockedTargetError):
            client.get("http://127.0.0.1:9/")
        with pytest.raises(BlockedTargetError):
            client.get("http://metadata.internal/")


async def test_guarded_async_client_forwards_transport_options():
    async with guarded_async_client(limits=httpx.Limits(max_connections=3), timeout=5) as client:
        assert isinstance(client._transport, PinnedAsyncTransport)
        with pytest.raises(BlockedTargetError):
            await client.get("http://[::1]:9/")


class _EchoHost(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = self.headers.get("host", "").encode()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


async def test_real_socket_connects_to_the_checked_ip_without_a_second_lookup(monkeypatch):
    """The name does not exist in DNS: the request can only succeed if the transport dials the checked IP itself."""
    server = http.server.HTTPServer(("127.0.0.1", 0), _EchoHost)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        monkeypatch.setattr(netguard, "is_blocked_address", lambda ip: False)  # treat the loopback test server as public
        resolved = []

        async def resolve(host, p):
            resolved.append(host)
            return ["127.0.0.1"]
        async with httpx.AsyncClient(transport=PinnedAsyncTransport(resolver=resolve)) as client:
            res = await client.get(f"http://pinned-test.invalid:{port}/")
        assert res.status_code == 200 and res.text == f"pinned-test.invalid:{port}"
        assert resolved == ["pinned-test.invalid"]
    finally:
        server.shutdown()
