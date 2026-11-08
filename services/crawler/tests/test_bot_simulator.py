"""Live AI crawler simulator: WAF / challenge detection, render integrity, token weight, fix recipes."""
import gzip
import json
from typing import Callable

import httpx
import pytest
import respx

from botsim_fixtures import (AKAMAI_BLOCK, CF_BLOCK_1020, CF_MANAGED_CHALLENGE, CONTACT_PAGE_WITH_RECAPTCHA, CSR_SHELL,
                             DATADOME_CAPTCHA, IMPERVA_BLOCK, ORIGIN, SSR_PAGE, TURNSTILE_INTERSTITIAL, bloated_page)
from autogeo_fixtures import EN_BLOG, STRONG_BLOG
from geo_crawler.scoring import bot_simulator as bs
from geo_crawler.scoring.bot_simulator import (BOT_PROFILES, DEFAULT_BOTS, analyze_bloat, build_fixes, count_tokens,
                                               detect_protection, estimate_tokens, simulate_bots)

ROBOTS_ALLOW_ALL = "User-agent: *\nAllow: /\n"
HTML = {"content-type": "text/html; charset=utf-8"}


def site(handler: Callable[[str, httpx.Request], httpx.Response], robots: str = ROBOTS_ALLOW_ALL):
    """respx side effect: robots.txt + ``handler(user_agent, request)`` for pages."""
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=robots, headers={"content-type": "text/plain"})
        return handler(request.headers.get("user-agent", ""), request)
    return respond


async def run(handler, urls=(ORIGIN + "/",), robots: str = ROBOTS_ALLOW_ALL, **kw):
    with respx.mock(assert_all_called=False) as router:
        router.route(host="botsim.example.com").mock(side_effect=site(handler, robots))
        return await simulate_bots(list(urls), delay=0, **kw)


def by_token(page):
    return {r.token: r for r in page.results}


# ---------------------------------------------------------------- end-to-end simulations

async def test_ssr_site_is_fully_accessible_and_gets_preventive_rules():
    report = await run(lambda ua, req: httpx.Response(200, text=SSR_PAGE, headers={**HTML, "server": "nginx"}))
    page = report.pages[0]
    assert report.bots == list(DEFAULT_BOTS)
    assert all(r.outcome == "ok" and r.robots_allowed and not r.silent_block for r in page.results)
    assert report.access_score == 100 and report.blocked_bots() == []
    assert page.ai_view["source"] == "GPTBot"
    assert page.ai_view["render"]["mode"] == "static"
    assert page.ai_view["tokens"]["text_tokens"] > 300
    assert report.score >= 85
    assert not [f for f in report.findings if f.severity == "critical"]
    # rules are still generated, flagged as preventive, for every simulated crawler (incl. Googlebot/Applebot)
    cf = next(f for f in report.fixes if f["id"] == "cloudflare_waf_skip")
    assert cf["preventive"] and all(f'"{c}"' in cf["code"] for c in ("GPTBot", "ClaudeBot", "PerplexityBot",
                                                                     "Googlebot", "Applebot"))
    assert any(f["id"] == "nginx_allow" for f in report.fixes) and any(f["id"] == "apache_allow" for f in report.fixes)
    assert any("robots.txt jetonudur" in c for c in report.caveats)


async def test_bots_send_official_user_agents_without_cookies():
    seen: dict[str, dict[str, str]] = {}

    def handler(ua, req):
        seen[ua] = dict(req.headers)
        return httpx.Response(200, text=SSR_PAGE, headers=HTML)

    await run(handler)
    uas = set(seen)
    for token in DEFAULT_BOTS:
        assert BOT_PROFILES[token].user_agent in uas
    gpt = seen[BOT_PROFILES["GPTBot"].user_agent]
    assert "GPTBot/1.3; +https://openai.com/gptbot" in BOT_PROFILES["GPTBot"].user_agent
    assert "cookie" not in gpt and gpt["accept-encoding"] == "gzip, deflate" and "text/html" in gpt["accept"]
    assert "Googlebot/2.1" in BOT_PROFILES["Google-Extended"].user_agent
    assert "Applebot/0.1" in BOT_PROFILES["Applebot-Extended"].user_agent


async def test_cloudflare_challenge_and_block_are_silent_blocks():
    def handler(ua, req):
        cf = {**HTML, "server": "cloudflare", "cf-ray": "8f1c2d3e4f5a6b7c-IST"}
        if "GPTBot" in ua or "ClaudeBot" in ua:
            return httpx.Response(403, text=CF_MANAGED_CHALLENGE, headers={**cf, "cf-mitigated": "challenge"})
        if "PerplexityBot" in ua:
            return httpx.Response(403, text=CF_BLOCK_1020, headers=cf)
        return httpx.Response(200, text=SSR_PAGE, headers=cf)

    report = await run(handler)
    r = by_token(report.pages[0])
    assert r["GPTBot"].outcome == "challenge" and r["GPTBot"].protection.vendor == "cloudflare"
    assert r["GPTBot"].protection.name == "Cloudflare Managed Challenge"
    assert r["PerplexityBot"].outcome == "blocked" and r["PerplexityBot"].protection.name == "Cloudflare WAF engeli"
    assert all(r[t].silent_block for t in ("GPTBot", "ClaudeBot", "PerplexityBot"))
    assert r["Google-Extended"].accessible and not r["Google-Extended"].general
    assert set(report.blocked_bots()) == {"GPTBot", "ClaudeBot", "PerplexityBot"}
    assert report.vendors() == ["cloudflare"]
    assert report.access_score == 40

    codes = [f.code for f in report.findings]
    assert codes[:2] == ["waf_challenge", "waf_block"]
    block = next(f for f in report.findings if f.code == "waf_block")
    assert "sessiz engel" in block.detail and block.bots == ["PerplexityBot"]

    cf = next(f for f in report.fixes if f["id"] == "cloudflare_waf_skip")
    assert cf["recommended"] and not cf["preventive"]
    assert '(http.user_agent contains "GPTBot") or (http.user_agent contains "ClaudeBot") or ' \
           '(http.user_agent contains "PerplexityBot")' in cf["code"]
    assert "Googlebot" not in cf["code"]  # Google-Extended got through: only refused bots are listed
    api = json.loads(cf["code"].split("rules[0]):\n", 1)[1])
    assert api["action"] == "skip" and "http_request_sbfm" in api["action_parameters"]["phases"]
    nginx = next(f for f in report.fixes if f["id"] == "nginx_allow")
    assert '"~*(GPTBot|ClaudeBot|PerplexityBot)" 1;' in nginx["code"]
    apache = next(f for f in report.fixes if f["id"] == "apache_allow")
    assert 'SetEnvIfNoCase User-Agent "(GPTBot|ClaudeBot|PerplexityBot)" ai_bot' in apache["code"]
    assert report.caveats and "IP aralıklarından" in report.caveats[0]


async def test_general_block_when_browser_is_refused_too():
    report = await run(lambda ua, req: httpx.Response(403, text="<h1>Forbidden</h1>", headers=HTML))
    codes = [f.code for f in report.findings]
    assert "general_block" in codes and "waf_block" not in codes
    assert all(r.general for r in report.pages[0].results)
    assert report.pages[0].ai_view is None and report.score == 0


async def test_csr_shell_is_flagged_with_ssr_recipe():
    report = await run(lambda ua, req: httpx.Response(200, text=CSR_SHELL, headers=HTML))
    view = report.pages[0].ai_view
    assert view["render"]["mode"] == "csr_shell" and view["render"]["spa_root"] == {"id": "root", "empty": True}
    assert view["render"]["noscript_requires_js"]
    assert report.findings[0].code == "csr_shell" and report.findings[0].severity == "critical"
    assert any(f["id"] == "ssr_render" for f in report.fixes)
    assert report.render_score == 0 and report.score <= 75


async def test_content_parity_robots_disallow_and_dropped_connection():
    thin = "<html><body><main><p>Kısa içerik.</p></main></body></html>"

    def handler(ua, req):
        if "ClaudeBot" in ua:
            return httpx.Response(200, text=thin, headers=HTML)
        if "PerplexityBot" in ua:
            raise httpx.ConnectError("connection reset by peer")
        return httpx.Response(200, text=SSR_PAGE, headers=HTML)

    robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    report = await run(handler, robots=robots)
    r = by_token(report.pages[0])
    assert r["ClaudeBot"].outcome == "degraded" and r["ClaudeBot"].parity < 0.5
    assert r["PerplexityBot"].outcome == "error" and r["PerplexityBot"].silent_block
    assert "bağlantısı düşürülüyor" in r["PerplexityBot"].reason
    assert r["GPTBot"].robots_allowed is False and r["GPTBot"].accessible and not r["GPTBot"].silent_block
    codes = {f.code for f in report.findings}
    assert {"content_parity", "robots_disallow", "waf_block"} <= codes
    assert report.pages[0].ai_view["source"] == "GPTBot"


async def test_rate_limit_and_unreachable_robots():
    def handler(ua, req):
        if "GPTBot" in ua:
            return httpx.Response(429, text="Too Many Requests", headers={**HTML, "retry-after": "60"})
        return httpx.Response(200, text=SSR_PAGE, headers=HTML)

    with respx.mock(assert_all_called=False) as router:
        router.get(ORIGIN + "/robots.txt").mock(return_value=httpx.Response(503))
        router.route(host="botsim.example.com").mock(side_effect=lambda req: handler(req.headers["user-agent"], req))
        report = await simulate_bots([ORIGIN + "/"], delay=0)
    r = by_token(report.pages[0])
    assert r["GPTBot"].outcome == "rate_limited" and "Retry-After: 60" in r["GPTBot"].protection.evidence[0]
    assert report.robots_status == 503
    assert all(x.robots_allowed is False for x in report.pages[0].results)  # RFC 9309: 5xx robots = disallow all
    assert "rate_limited" in {f.code for f in report.findings}


async def test_compression_tokens_and_bloat():
    big = bloated_page()
    body = gzip.compress(big.encode())

    def handler(ua, req):
        return httpx.Response(200, content=body, headers={**HTML, "content-encoding": "gzip"})

    report = await run(handler)
    view = report.pages[0].ai_view
    tk, bl = view["tokens"], view["bloat"]
    assert tk["compressed"] and tk["transfer_kb"] < tk["html_kb"] / 3
    assert tk["html_tokens"] > tk["text_tokens"] * 5
    assert bl["dom_nodes"] > 1500 and bl["json_state_bytes"] > 100_000
    assert bl["json_state"][0]["kind"] == "__NEXT_DATA__"
    codes = {f.code for f in report.findings}
    assert "token_bloat" in codes and tk["signal_ratio"] < 0.1 and tk["score"] < 100
    assert any(f["id"] == "token_diet" for f in report.fixes)


async def test_multiple_urls_and_validation():
    report = await run(lambda ua, req: httpx.Response(200, text=SSR_PAGE if req.url.path == "/" else CSR_SHELL,
                                                      headers=HTML),
                       urls=(ORIGIN + "/", ORIGIN + "/urun/x", ORIGIN + "/"), bots=("GPTBot", "ChatGPT-User"))
    assert [p.url for p in report.pages] == [ORIGIN + "/", ORIGIN + "/urun/x"]
    assert report.bots == ["GPTBot", "ChatGPT-User"]
    csr = next(f for f in report.findings if f.code == "csr_shell")
    assert csr.urls == [ORIGIN + "/urun/x"]
    d = report.to_dict()
    assert d["scores"]["access"] == 100 and len(d["pages"][0]["results"]) == 2
    s = report.summary()
    assert s["pages"][1]["render"] == "csr_shell" and s["pages"][0]["bots"] == {"GPTBot": "ok", "ChatGPT-User": "ok"}
    json.dumps(d)  # serialisable
    with pytest.raises(ValueError):
        await simulate_bots([ORIGIN], bots=("NopeBot",))
    with pytest.raises(ValueError):
        await simulate_bots([])


# ---------------------------------------------------------------- detection units

@pytest.mark.parametrize("status,headers,body,vendor,kind", [
    (403, {"server": "cloudflare", "cf-mitigated": "challenge"}, CF_MANAGED_CHALLENGE, "cloudflare", "challenge"),
    (503, {"server": "cloudflare"}, CF_MANAGED_CHALLENGE, "cloudflare", "challenge"),
    (403, {"server": "cloudflare"}, CF_BLOCK_1020, "cloudflare", "block"),
    (403, {"x-iinfo": "1-2-3"}, IMPERVA_BLOCK, "imperva", "block"),
    (403, {"server": "AkamaiGHost"}, AKAMAI_BLOCK, "akamai", "block"),
    (202, {"x-amzn-waf-action": "challenge"}, "<html></html>", "aws_waf", "challenge"),
    (405, {"x-amzn-waf-action": "captcha"}, "<html></html>", "aws_waf", "captcha"),
    (403, {"server": "CloudFront"}, "<h1>403 ERROR</h1>Request blocked. Generated by cloudfront (CloudFront)",
     "aws_waf", "block"),
    (403, {"x-datadome": "protected"}, DATADOME_CAPTCHA, "datadome", "captcha"),
    (429, {"x-vercel-mitigated": "challenge"}, "<html></html>", "vercel", "challenge"),
    (200, {"server": "cloudflare"}, TURNSTILE_INTERSTITIAL, "cloudflare", "captcha"),
    (429, {}, "slow down", "unknown", "rate_limit"),
    (403, {"server": "nginx"}, "<h1>403 Forbidden</h1>", "unknown", "block"),
])
def test_detect_protection(status, headers, body, vendor, kind):
    p = detect_protection(status, headers, body)
    assert p is not None and (p.vendor, p.kind) == (vendor, kind)
    assert p.evidence


def test_detect_protection_ignores_normal_pages():
    assert detect_protection(200, {"server": "cloudflare", "cf-ray": "x"}, SSR_PAGE) is None
    # a contact form CAPTCHA on a content-rich page is not a bot wall
    assert detect_protection(200, {}, CONTACT_PAGE_WITH_RECAPTCHA) is None
    assert detect_protection(404, {}, "<h1>Not found</h1>") is None
    assert bs.fingerprint({"CF-RAY": "1"}) == "cloudflare" and bs.fingerprint({"server": "Apache"}) is None


def test_cloudflare_challenge_types():
    js = CF_MANAGED_CHALLENGE.replace("cType: 'managed'", "cType: 'non-interactive'")
    assert detect_protection(503, {}, js).name == "Cloudflare JS Challenge"
    ts = CF_MANAGED_CHALLENGE.replace("cType: 'managed'", "cType: 'interactive'") + "cf-turnstile"
    assert detect_protection(403, {}, ts).name == "Cloudflare Turnstile"


# ---------------------------------------------------------------- tokens & bloat units

@pytest.mark.parametrize("text", [SSR_PAGE, CSR_SHELL, STRONG_BLOG, EN_BLOG, CF_MANAGED_CHALLENGE])
def test_token_estimate_close_to_tiktoken(text):
    tiktoken = pytest.importorskip("tiktoken")
    exact = len(tiktoken.get_encoding("cl100k_base").encode(text))
    assert abs(estimate_tokens(text) / exact - 1) < 0.2


def test_count_tokens_falls_back_to_estimate(monkeypatch):
    monkeypatch.setattr(bs, "_encoder", False)
    n, method = count_tokens("Merhaba dünya, bu bir deneme metnidir.")
    assert method == "estimate:cl100k_base" and 6 <= n <= 16
    assert estimate_tokens("") == 0


def test_token_efficiency_scale():
    assert bs.token_efficiency(0.2, 50_000, True) == 100
    assert bs.token_efficiency(0.01, 50_000, True) == pytest.approx(40)
    assert bs.token_efficiency(0.2, 50_000, False) == 85
    assert bs.token_efficiency(0.2, 3_000_000, True) == 80


def test_bloat_detects_inline_state_markers():
    from bs4 import BeautifulSoup
    html = "<html><body><p>x</p><script>self.__next_f.push([1,\"" + "a" * 120_000 + "\"])</script>" \
           "<script type='application/ld+json'>{\"@type\":\"Thing\"}</script></body></html>"
    b = analyze_bloat(BeautifulSoup(html, "lxml"), html)
    assert b["json_state"][0]["kind"] == "Next.js RSC yükü" and b["ld_json_bytes"] > 0
    assert any("gömülü JSON" in i for i in b["issues"])


# ---------------------------------------------------------------- recipes

def test_build_fixes_vendor_consoles():
    bots = [BOT_PROFILES["GPTBot"], BOT_PROFILES["Google-Extended"]]
    fixes = build_fixes(bots, ["akamai", "aws_waf"], csr_urls=["https://x.test/"])
    ids = [f["id"] for f in fixes]
    assert ids[:3] == ["cloudflare_waf_skip", "nginx_allow", "apache_allow"]
    assert {"aws_waf_allow", "akamai_console", "ssr_render"} <= set(ids)
    aws = json.loads(next(f for f in fixes if f["id"] == "aws_waf_allow")["code"])
    assert aws["Rules"][0]["Statement"]["RegexMatchStatement"]["RegexString"] == "(?i)(GPTBot|Googlebot)"
    assert next(f for f in fixes if f["id"] == "aws_waf_allow")["recommended"]
    assert build_fixes([], []) == []


def test_cli_json(capsys):
    from geo_crawler.scoring.bot_simulator import main

    def handler(ua, req):
        return httpx.Response(403, text=CF_BLOCK_1020, headers={**HTML, "server": "cloudflare"}) if "GPTBot" in ua \
            else httpx.Response(200, text=SSR_PAGE, headers=HTML)

    with respx.mock(assert_all_called=False) as router:
        router.route(host="botsim.example.com").mock(side_effect=site(handler))
        code = main([ORIGIN + "/", "--json", "--delay", "0", "--bots", "GPTBot,ClaudeBot"])
    out = json.loads(capsys.readouterr().out)
    assert code == 1 and out["blocked_bots"] == ["GPTBot"] and out["scores"]["access"] == 50
    with respx.mock(assert_all_called=False) as router:
        router.route(host="botsim.example.com").mock(side_effect=site(handler))
        assert main([ORIGIN + "/", "--delay", "0", "--bots", "ClaudeBot", "--code"]) == 0
    text = capsys.readouterr().out
    assert "AI BOT SİMÜLASYONU" in text and "ClaudeBot" in text and "### Cloudflare WAF" in text
    assert main([ORIGIN + "/", "--bots", "NopeBot"]) == 2


# ---------------------------------------------------------------- audit integration

async def test_audit_ships_simulation_and_tailored_waf_action():
    from geo_crawler import CrawlConfig
    from geo_crawler.scoring import audit_site

    home = SSR_PAGE.replace("<h1>", '<p><a href="/urun/barista-pro-x">Barista Pro X</a></p><h1>')
    big = bloated_page()

    def handler(ua, req):
        cf = {**HTML, "server": "cloudflare", "cf-ray": "8f1c2d3e4f5a6b7c-IST"}
        if any(b in ua for b in ("GPTBot", "ClaudeBot", "PerplexityBot")):
            return httpx.Response(403, text=CF_MANAGED_CHALLENGE, headers={**cf, "cf-mitigated": "challenge"})
        if req.url.path == "/":
            return httpx.Response(200, text=home, headers=cf)
        if req.url.path == "/urun/barista-pro-x":
            return httpx.Response(200, text=big, headers=cf)
        return httpx.Response(404, text="nf", headers=HTML)

    cfg = CrawlConfig(max_depth=2, max_pages=10, concurrency=2, requests_per_second=0)
    with respx.mock(assert_all_called=False) as router:
        router.route(host="botsim.example.com").mock(side_effect=site(handler))
        _, rep = await audit_site(ORIGIN + "/", cfg)
    sim = rep.bot_simulation
    assert sim is not None and [p.url for p in sim.pages] == [ORIGIN + "/", ORIGIN + "/urun/barista-pro-x"]
    assert set(sim.blocked_bots()) == {"GPTBot", "ClaudeBot", "PerplexityBot"}
    rows = rep.to_db_records()
    summary = rows["audit"]["metrics"]["botSimulation"]
    assert summary["blockedBots"] == sim.blocked_bots() and summary["vendors"] == ["cloudflare"]
    assert rep.to_dict()["bot_simulation"]["pages"][0]["results"][0]["outcome"] == "challenge"

    waf = next(a for a in rep.actions if a.rule_id == "crawler.waf_ua_block")
    assert waf.impact == "high" and "Cloudflare Managed Challenge" in " ".join(waf.evidence)
    assert waf.snippet.code.startswith("### Cloudflare WAF") and 'http.user_agent contains "GPTBot"' in waf.snippet.code
    assert "Googlebot" not in waf.snippet.code
    bloat = next(a for a in rep.actions if a.rule_id == "technical.ai_token_bloat")
    assert bloat.affected_urls == [ORIGIN + "/urun/barista-pro-x"] and "gömülü JSON" in bloat.evidence[0]
    assert {"ruleId", "details"} <= set(bloat.to_action_item())


async def test_audit_without_probe_skips_simulation(fake_site):
    from fixtures import BASE
    from geo_crawler import CrawlConfig
    from geo_crawler.scoring import audit_site

    _, rep = await audit_site(BASE + "/", CrawlConfig(max_depth=1, max_pages=5, requests_per_second=0),
                              probe_user_agents=False)
    assert rep.bot_simulation is None and "botSimulation" not in rep.metrics


# ---------------------------------------------------------------- Python -> web API contract fixture

FIXTURE_DIR = __import__("pathlib").Path(__file__).resolve().parents[3] / "tests" / "fixtures"


def _contract_handler(req: httpx.Request) -> httpx.Response:
    if req.url.path == "/robots.txt":
        return httpx.Response(200, text="User-agent: Applebot-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /\n")
    ua = req.headers["user-agent"]
    cf = {**HTML, "server": "cloudflare", "cf-ray": "8f1c2d3e4f5a6b7c-IST"}
    if "GPTBot" in ua or "ClaudeBot" in ua:
        return httpx.Response(403, text=CF_MANAGED_CHALLENGE, headers={**cf, "cf-mitigated": "challenge"})
    if "PerplexityBot" in ua:
        return httpx.Response(403, text=CF_BLOCK_1020, headers=cf)
    body = {"/": SSR_PAGE, "/uygulama": CSR_SHELL, "/urun/barista-pro-x": bloated_page()}[req.url.path]
    return httpx.Response(200, text=body, headers=cf)


async def test_contract_fixture_is_current(monkeypatch):
    """tests/fixtures/bot-simulation-*.json feed tests/bot-simulator.test.ts. Regenerate: BOTSIM_UPDATE=1 pytest -k contract"""
    import os
    monkeypatch.setattr(bs, "_encoder", False)  # deterministic: the estimator the TS port reproduces
    with respx.mock() as router:
        router.route(host="botsim.example.com").mock(side_effect=_contract_handler)
        rep = await simulate_bots([ORIGIN + "/", ORIGIN + "/uygulama", ORIGIN + "/urun/barista-pro-x"], delay=0)
    d = rep.to_dict()
    d["generated_at"] = "2026-11-08T12:00:00+00:00"
    for p in d["pages"]:
        p["baseline"]["ttfb_ms"] = p["baseline"]["total_ms"] = 12
        for r in p["results"]:
            r["ttfb_ms"] = r["total_ms"] = 15
    report_path, summary_path = FIXTURE_DIR / "bot-simulation-report.json", FIXTURE_DIR / "bot-simulation-summary.json"
    if os.environ.get("BOTSIM_UPDATE"):
        report_path.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary_path.write_text(json.dumps(rep.summary(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert json.loads(report_path.read_text(encoding="utf-8")) == json.loads(json.dumps(d))
    assert json.loads(summary_path.read_text(encoding="utf-8")) == json.loads(json.dumps(rep.summary()))
