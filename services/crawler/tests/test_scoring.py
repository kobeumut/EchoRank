"""GEO / E-E-A-T scoring + action engine.

The generated report text is English by default; Turkish-locale (``lang="tr"``) tests assert the Turkish catalog.
Sample sites in this file are *Turkish web pages on purpose*: they exercise the Turkish heuristics (hype / claim /
policy-page patterns) that keep the analyzers working for Turkish sites.
"""
import json

import httpx
import pytest
import respx

from fixtures import BASE, FakeSite, ld
from geo_crawler import CrawlConfig, parse_html
from geo_crawler.audit_cli import main as audit_main, render_text
from geo_crawler.i18n import catalog
from geo_crawler.scoring import audit_site, parse_robots_rules, validate_llms_txt
from geo_crawler.scoring.access import classify_render
from geo_crawler.scoring.robots import evaluate
from geo_crawler.scoring.schema_rules import validate_block
from geo_crawler.scoring.text import claim_sentences, count_phrases, HYPE_PHRASES

CFG = CrawlConfig(max_depth=3, max_pages=50, concurrency=4, requests_per_second=0)


# ---------------------------------------------------------------- robots.txt (RFC 9309)

def test_robots_group_selection_and_longest_match():
    rules = parse_robots_rules("""
User-agent: *
Disallow: /private/
Allow: /private/public-page

User-agent: GPTBot
User-agent: CCBot
Disallow: /

User-agent: PerplexityBot
Disallow:
""")
    assert not rules.is_allowed("GPTBot", "/")
    assert not rules.is_allowed("CCBot", "/anything")
    assert rules.is_allowed("PerplexityBot", "/private/x")  # own group (empty Disallow) overrides *
    assert not rules.is_allowed("ClaudeBot", "/private/x")  # falls back to *
    assert rules.is_allowed("ClaudeBot", "/private/public-page")  # longer Allow wins
    assert rules.is_allowed("ClaudeBot", "/robots.txt")


def test_robots_wildcards_and_anchor():
    rules = [(False, "/*?"), (False, "/*.pdf$"), (True, "/blog/$")]
    assert not evaluate(rules, "/urun?renk=mavi")
    assert not evaluate(rules, "/docs/a.pdf")
    assert evaluate(rules, "/docs/a.pdf?x")  is False  # matched by /*? as well
    assert evaluate(rules, "/docs/a.pdfx")
    assert evaluate([(False, "/blog/"), (True, "/blog/$")], "/blog/")
    assert not evaluate([(False, "/blog/"), (True, "/blog/$")], "/blog/yazi")
    # allow wins ties
    assert evaluate([(False, "/a"), (True, "/a")], "/a")


# ---------------------------------------------------------------- validators / heuristics

def test_llms_txt_validation():
    ok, issues, links, sections = validate_llms_txt("# Kahve\n\n> Özet\n\n## Ürünler\n\n- [Barista](https://x/y): desc\n")
    assert ok and links == 1 and sections == 1 and not issues
    ok, issues, *_ = validate_llms_txt("<!doctype html><html>404</html>")
    assert not ok and "HTML" in issues[0]
    ok, issues, *_ = validate_llms_txt("Kahve sitesi\nhttps://x")
    assert not ok and len(issues) >= 3
    assert issues[0] == "the first line is not a '# Site Name' heading"


def test_llms_txt_issues_follow_the_locale():
    ok, issues, *_ = validate_llms_txt("Kahve sitesi\nhttps://x", lang="tr")
    assert not ok and issues[0] == "ilk satır '# Site Adı' başlığı değil"
    assert validate_llms_txt("<!doctype html><html>404</html>", lang="tr")[1] == [catalog("tr")["signals.llms.html_response"]]
    assert validate_llms_txt("", lang="en")[1] == ["the file is empty"]


def test_schema_validation_scores_and_errors():
    good = validate_block({"@type": "Product", "name": "X", "image": "i", "description": "d", "sku": "1",
                           "brand": {"name": "B"}, "gtin13": "1", "aggregateRating": {"ratingValue": 5},
                           "offers": {"price": "10.00", "priceCurrency": "TRY", "availability": "InStock"}}, "u")
    assert good.score == 100 and not good.missing_required
    bad = validate_block({"@type": "Product", "name": "X", "offers": {"price": "12.499,90 TL"}}, "u")
    assert bad.errors and bad.score < 60
    faq = validate_block({"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": "Q?"}]}, "u")
    assert faq.errors and faq.score <= 85
    assert validate_block({"@type": "Thing"}, "u") is None


def test_render_classification():
    shell = parse_html('<html><head><script src="/a.js"></script><script src="/b.js"></script>'
                       '<script>window.__INITIAL__={}</script></head><body><div id="root"></div></body></html>',
                       BASE + "/")
    assert classify_render(shell)[0] == "csr_shell"
    ssr = parse_html('<html><body><div id="__next"><h1>Ürün</h1><p>' + "kelime " * 120 + '</p></div>'
                     '<script id="__NEXT_DATA__" type="application/json">{}</script></body></html>', BASE + "/")
    mode, score, reason = classify_render(ssr)
    assert mode == "ssr_hydrated" and score == 100 and reason.startswith("SSR/SSG (nextjs)")
    mode_tr, _, reason_tr = classify_render(shell, lang="tr")
    assert mode_tr == "csr_shell" and "kökü boş" in reason_tr and "boş" not in classify_render(ssr, lang="tr")[2]
    assert "mount point is empty" in classify_render(shell)[2]


def test_claims_and_hype_detection():
    text = ("Araştırmalara göre kullanıcıların %73'ü sesli asistan kullanıyor. Bu ürün en iyi ürün. "
            "Kahve makinesi mutfakta durur ve güzel görünür.")
    claims = claim_sentences(text)
    assert len(claims) == 1 and "%73" in claims[0]
    assert count_phrases(text, HYPE_PHRASES)["en iyi"] == 1


def test_parser_collects_scoring_signals():
    p = parse_html('<html><body><address>Kadıköy</address><a href="tel:+90 212 555 11 22">Ara</a>'
                   '<a href="mailto:info@x.com">m</a><span class="author-name">Ayşe Yılmaz</span>'
                   '<table><tr><td>1</td></tr></table><ul><li>a</li><li>b</li></ul><p>Merhaba dünya.</p>'
                   '</body></html>', BASE + "/")
    s = p.content_stats
    assert s["phones"] == ["+902125551122"] and s["emails"] == ["info@x.com"]
    assert s["address_tags"] == 1 and s["author_hints"] == ["Ayşe Yılmaz"]
    assert s["tables"] == 1 and s["list_items"] == 2 and s["paragraphs"] == 1


# ---------------------------------------------------------------- full audit on the shared fixture site

@pytest.fixture
async def report(fake_site):
    _, rep = await audit_site(BASE + "/", CFG)
    return rep


async def test_fixture_site_scores_and_breakdown(report):
    d = report.to_dict()
    for k in ("geo", "seo", "eeat", "ai_access", "llm_readability"):
        assert 0 <= d["scores"][k] <= 100
    assert set(d["pillars"]) == {"ai_access", "llm_readability", "eeat", "technical_seo"}
    # every check carries a concrete reason
    for p in d["pillars"].values():
        assert all(c["detail"] for c in p["checks"])
    trust = report.pillars["eeat"].check("trust")
    assert "privacy" in trust.detail and "SSL/HTTPS active" in trust.detail
    llms = report.pillars["llm_readability"].check("llms_txt")
    assert llms.score == 0 and "404" in llms.detail
    # Product price "12.499,90" is flagged as invalid schema
    assert "is not numeric" in report.pillars["llm_readability"].check("schema_validity").detail
    assert report.summary.startswith(f"GEO score {report.geo_score}/100")
    assert report.lang == "en" and d["pillars"]["ai_access"]["label"] == "AI Crawler and Bot Accessibility"


async def test_fixture_site_action_cards(report):
    rules = {a.rule_id for a in report.actions}
    assert {"technical.llms_txt", "schema.faq_page", "schema.breadcrumb", "authority.policy_pages",
            "content.direct_answers", "schema.organization"} <= rules
    assert len(rules) >= 5
    prios = [a.priority for a in report.actions]
    assert prios == sorted(prios, reverse=True)
    for a in report.actions:
        assert a.impact in ("high", "medium", "low") and a.effort in ("high", "medium", "low")
        assert a.category in ("crawler", "schema", "content", "authority", "technical")
    llms = next(a for a in report.actions if a.rule_id == "technical.llms_txt")
    assert llms.snippet.code.startswith("# Kahve Dükkanı") and "](https://shop.example.com/urun/barista-pro-x)" in llms.snippet.code
    faq = next(a for a in report.actions if a.rule_id == "schema.faq_page")
    payload = json.loads(faq.snippet.code.split("\n", 1)[1].rsplit("\n", 1)[0])
    assert payload["@type"] == "FAQPage" and payload["mainEntity"][0]["@type"] == "Question"


async def test_db_records_shape(report):
    rows = report.to_db_records()
    a = rows["audit"]
    assert a["status"] == "completed" and a["geoScore"] == report.geo_score
    assert a["metrics"]["aiAccess"] == report.pillars["ai_access"].score and "llmsTxt" in a["metrics"]
    item = rows["actionItems"][0]
    assert set(item) >= {"title", "description", "category", "impact", "effort", "ruleId", "priority", "details"}
    assert "snippet" in item["details"] and "evidence" in item["details"]
    json.dumps(rows)  # serializable


# ---------------------------------------------------------------- scenario sites

BAD = "https://bad.example.com"
GOOD = "https://good.example.com"

BAD_ROBOTS = """User-agent: GPTBot
Disallow: /
User-agent: ChatGPT-User
Disallow: /
User-agent: OAI-SearchBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
User-agent: Claude-SearchBot
Disallow: /
User-agent: Claude-User
Disallow: /
User-agent: PerplexityBot
Disallow: /
User-agent: Perplexity-User
Disallow: /
User-agent: Bingbot
Disallow: /
User-agent: *
Disallow: /admin
"""

SPA = """<html><head><title>Bad Shop</title><meta name="robots" content="noindex, noai">
<script src="/static/vendor.js"></script><script src="/static/app.js"></script><script>window.__STATE__={}</script>
</head><body><div id="root"></div></body></html>"""

HYPE = ("<html><head><title>Mucize Krem</title></head><body><h1>Mucize Krem</h1>"
        "<p>Araştırmalara göre kullanıcıların %97'si ilk günde sonuç aldı. Bilimsel olarak kanıtlanmış formül!</p>"
        "<p>En iyi krem! %100 garanti! Mucize sonuç! Kaçırmayın! İnanılmaz fiyat! En iyi fırsat! "
        + "Cildiniz için en iyi bakım. " * 40 + "</p></body></html>")


def bad_site(request: httpx.Request) -> httpx.Response:
    ua = request.headers.get("user-agent", "")
    path = request.url.path
    if "GPTBot" in ua or "ClaudeBot" in ua or "PerplexityBot" in ua:
        return httpx.Response(403, text="blocked")
    if path == "/robots.txt":
        return httpx.Response(200, text=BAD_ROBOTS)
    if path == "/":
        return httpx.Response(200, text=SPA.replace("</body>", '<a href="/krem">krem</a></body>'),
                              headers={"content-type": "text/html"})
    if path == "/krem":
        return httpx.Response(200, text=HYPE, headers={"content-type": "text/html"})
    if path == "/llms.txt":  # SPA fallback: HTML instead of a text file
        return httpx.Response(200, text=SPA, headers={"content-type": "text/html"})
    return httpx.Response(404, text="nf", headers={"content-type": "text/html"})


GOOD_BODY = """<h2>Özet</h2><p>Brevio Barista Pro X, 15 bar basınçlı, 1.450 W gücünde, 25 saniyede espresso hazırlayan
ve 2 yıl garanti ile satılan yarı otomatik bir espresso makinesidir; fiyatı 12.499 TL'dir.</p>
<table><tr><th>Özellik</th><th>Değer</th></tr><tr><td>Basınç</td><td>15 bar</td></tr>
<tr><td>Güç</td><td>1.450 W</td></tr><tr><td>Hazne</td><td>1,8 L</td></tr><tr><td>Ağırlık</td><td>6,2 kg</td></tr></table>
<ul><li>Isınma süresi 30 sn</li><li>Ses seviyesi 52 dB</li><li>Öğütücü 18 kademe</li></ul>
<h2>Barista Pro X hangi kahveler için uygun?</h2><p>Espresso, ristretto ve lungo için uygundur; buhar çubuğu ile
latte ve kapuçino için süt 65 °C'ye kadar ısıtılır.</p>
<h2>Kutudan neler çıkıyor?</h2><p>Makine, 58 mm portafiltre, 2 sepet, kurcalama aleti ve 350 ml süt potu.</p>
<p>Ekibimiz makineyi 3 hafta boyunca test ettik ve 400'den fazla shot ölçtük. Ölçümlerimize göre ortalama ekstraksiyon
süresi 27 saniye, sıcaklık sapması ±1 °C oldu. Kaynak: <a href="https://www.tse.org.tr/standart">TSE</a>,
<a href="https://en.wikipedia.org/wiki/Espresso">Wikipedia</a>.</p>
<p>Kahve çekirdeklerini 2-4 hafta içinde tüketmenizi, makineyi her 200 shot'ta bir kireçten arındırmanızı öneririz.
Su sertliği 7-10 °dH aralığında olduğunda filtre ömrü yaklaşık 2 aydır.</p>"""

FOOTER = """<footer><a href="/gizlilik-politikasi">Gizlilik ve KVKK</a> <a href="/kullanim-kosullari">Kullanım Koşulları</a>
<a href="/iade-politikasi">İade</a> <a href="/kargo-teslimat">Kargo</a> <a href="/iletisim">İletişim</a>
<a href="/hakkimizda">Hakkımızda</a> <a href="/urun/barista-pro-x">Barista Pro X</a>
<a href="/blog/espresso-rehberi">Rehber</a> <a href="/yazar/ayse-yilmaz">Ayşe Yılmaz</a>
<a href="tel:+902165550000">+90 216 555 00 00</a> <a href="mailto:destek@good.example.com">destek</a>
<address>Moda Cad. 1, Kadıköy, İstanbul</address></footer>"""

ORG = {"@type": "Organization", "name": "Good Coffee", "url": GOOD + "/", "logo": GOOD + "/logo.png",
       "sameAs": ["https://www.linkedin.com/company/good", "https://www.wikidata.org/wiki/Q1"],
       "telephone": "+902165550000", "address": "Moda Cad. 1, Kadıköy, İstanbul"}


def good_page(title, h1, schema, body=GOOD_BODY, desc="Good Coffee espresso makineleri ve rehberleri."):
    return (f'<html lang="tr"><head><title>{title}</title><meta name="description" content="{desc}">'
            f'<meta property="og:title" content="{title}"><link rel="canonical" href="{{url}}">'
            + "".join(ld(s) for s in schema)
            + f"</head><body><nav><a href='/'>Anasayfa</a></nav><h1>{h1}</h1>{body}{FOOTER}</body></html>")


def crumbs(*names):
    return {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": n, **({"item": GOOD + "/"} if i < len(names) - 1 else {})}
        for i, n in enumerate(names)]}


FAQ = {"@type": "FAQPage", "mainEntity": [
    {"@type": "Question", "name": "Barista Pro X hangi kahveler için uygun?",
     "acceptedAnswer": {"@type": "Answer", "text": "Espresso, ristretto ve lungo için uygundur."}},
    {"@type": "Question", "name": "Kutudan neler çıkıyor?",
     "acceptedAnswer": {"@type": "Answer", "text": "Makine, 58 mm portafiltre, 2 sepet ve süt potu."}}]}

GOOD_PAGES = {
    "/": good_page("Good Coffee | Espresso Makineleri", "Good Coffee", [ORG, {"@type": "WebSite", "name": "Good Coffee", "url": GOOD + "/"}, FAQ]),
    "/urun/barista-pro-x": good_page("Barista Pro X Espresso Makinesi", "Barista Pro X", [
        {"@type": "Product", "name": "Barista Pro X", "sku": "BPX", "gtin13": "8690000000001", "image": GOOD + "/i.jpg",
         "description": "15 bar espresso makinesi", "brand": {"@type": "Brand", "name": "Brevio"},
         "offers": {"@type": "Offer", "price": "12499.00", "priceCurrency": "TRY", "availability": "https://schema.org/InStock"},
         "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "120"}},
        crumbs("Anasayfa", "Barista Pro X"), FAQ]),
    "/blog/espresso-rehberi": good_page("Espresso Rehberi: Öğütme ve Ekstraksiyon", "Espresso Rehberi", [
        {"@type": "Article", "headline": "Espresso Rehberi", "image": GOOD + "/r.jpg", "datePublished": "2026-10-01",
         "dateModified": "2026-11-01", "publisher": {"@type": "Organization", "name": "Good Coffee"},
         "author": {"@type": "Person", "name": "Ayşe Yılmaz", "jobTitle": "Q Grader", "url": GOOD + "/yazar/ayse-yilmaz"}},
        crumbs("Anasayfa", "Blog", "Espresso Rehberi")]),
    "/hakkimizda": good_page("Hakkımızda | Good Coffee", "Hakkımızda", [ORG]),
    "/iletisim": good_page("İletişim | Good Coffee", "İletişim", [ORG]),
    "/yazar/ayse-yilmaz": good_page("Ayşe Yılmaz — Q Grader", "Ayşe Yılmaz", [{"@type": "Person", "name": "Ayşe Yılmaz"}]),
    "/gizlilik-politikasi": good_page("Gizlilik ve KVKK Aydınlatma Metni", "Gizlilik", []),
    "/kullanim-kosullari": good_page("Kullanım Koşulları ve Mesafeli Satış", "Kullanım Koşulları", []),
    "/iade-politikasi": good_page("İade ve Cayma Hakkı Politikası", "İade", []),
    "/kargo-teslimat": good_page("Kargo ve Teslimat Bilgileri", "Kargo", []),
}
GOOD_LLMS = f"# Good Coffee\n\n> Espresso makineleri.\n\n## Ürünler\n\n- [Barista Pro X]({GOOD}/urun/barista-pro-x): 15 bar\n"


def good_site(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if request.url.scheme == "http":
        return httpx.Response(301, headers={"location": GOOD + path})
    if path == "/robots.txt":
        return httpx.Response(200, text=f"User-agent: *\nAllow: /\nSitemap: {GOOD}/sitemap.xml\n")
    if path == "/sitemap.xml":
        urls = "".join(f"<url><loc>{GOOD}{p}</loc></url>" for p in GOOD_PAGES)
        return httpx.Response(200, text=f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>',
                              headers={"content-type": "application/xml"})
    if path == "/llms.txt":
        return httpx.Response(200, text=GOOD_LLMS, headers={"content-type": "text/plain; charset=utf-8"})
    html = GOOD_PAGES.get(path.rstrip("/") or "/")
    if html is None:
        return httpx.Response(404, text="nf", headers={"content-type": "text/html"})
    return httpx.Response(200, text=html.replace("{url}", GOOD + path),
                          headers={"content-type": "text/html", "strict-transport-security": "max-age=31536000"})


@pytest.fixture
def scenario_sites():
    with respx.mock(assert_all_called=False) as router:
        router.route(host="bad.example.com").mock(side_effect=bad_site)
        router.route(host="good.example.com").mock(side_effect=good_site)
        yield


async def test_bad_site_is_capped_and_gets_crawler_actions(scenario_sites):
    _, rep = await audit_site(BAD + "/", CFG)
    access = rep.pillars["ai_access"]
    assert "GPTBot" in access.facts["blocked_bots"] and "PerplexityBot" in access.facts["blocked_bots"]
    assert set(access.facts["waf_blocked"]) == {"GPTBot", "ClaudeBot", "PerplexityBot"}
    assert access.facts["csr_pages"] == [BAD + "/"]
    assert rep.geo_score <= 35 and rep.caps
    rules = {a.rule_id for a in rep.actions}
    assert {"crawler.robots_ai_bots", "crawler.waf_ua_block", "crawler.noindex_noai",
            "technical.server_side_rendering", "technical.llms_txt", "content.cite_sources",
            "content.spam_signals", "schema.organization", "authority.policy_pages"} <= rules
    robots = next(a for a in rep.actions if a.rule_id == "crawler.robots_ai_bots")
    assert robots.impact == "high" and "User-agent: PerplexityBot\nAllow: /" in robots.snippet.code
    llms = rep.pillars["llm_readability"].check("llms_txt")
    assert llms.score == 40 and "text/html" in llms.detail
    fact = rep.pillars["eeat"].check("factual_consistency")
    assert "unsourced claims" in fact.detail and fact.score < 60


async def test_good_site_scores_high(scenario_sites):
    _, good = await audit_site(GOOD + "/", CFG)
    assert good.geo_score >= 75, render_text(good)
    assert good.pillars["ai_access"].score >= 95
    assert good.pillars["eeat"].score >= 75, good.pillars["eeat"].to_dict()
    assert good.pillars["llm_readability"].check("llms_txt").score == 100
    assert not good.caps
    rules = {a.rule_id for a in good.actions}
    assert not rules & {"crawler.robots_ai_bots", "technical.llms_txt", "authority.policy_pages",
                        "technical.server_side_rendering", "schema.organization"}


async def test_unreachable_site_gets_single_blocker():
    with respx.mock(assert_all_called=False) as router:
        router.route(host="wall.example.com").mock(return_value=httpx.Response(403, text="Access denied",
                                                                              headers={"content-type": "text/html"}))
        _, rep = await audit_site("https://wall.example.com/", CFG)
    assert rep.geo_score == 0 and rep.caps[-1] == "no pages could be fetched"
    assert rep.pillars["ai_access"].facts["general_block"] is True
    rules = [a.rule_id for a in rep.actions]
    assert rules[0] == "crawler.site_unreachable" and set(rules) <= {"crawler.site_unreachable", "crawler.waf_ua_block"}


def test_cli_writes_reports(fake_site, tmp_path, capsys):
    out, rows = tmp_path / "audit.json", tmp_path / "rows.json"
    rc = audit_main([BASE + "/", "-o", str(out), "--db-records", str(rows), "--rps", "0", "--text", "--no-ua-probe"])
    assert rc == 0
    data = json.loads(out.read_text())
    assert 0 <= data["scores"]["geo"] <= 100 and data["actions"]
    assert json.loads(rows.read_text())["audit"]["status"] == "completed"
    err = capsys.readouterr().err
    assert "WHAT SHOULD BE DONE?" in err and "GEO SCORE:" in err and "NE YAPILMALI?" not in err


# ---------------------------------------------------------------- Turkish locale (``lang="tr"``)

async def test_turkish_locale_translates_report_text_but_not_ids(fake_site):
    _, en = await audit_site(BASE + "/", CFG)
    _, tr = await audit_site(BASE + "/", CFG, lang="tr")
    assert tr.lang == "tr" and tr.summary.startswith(f"GEO skoru {tr.geo_score}/100")
    assert "aksiyon önerisi" in tr.summary and "En zayıf alan" in tr.summary
    # scores, ids, enums and the structure are the same in both languages
    assert (tr.geo_score, tr.seo_score, tr.eeat_score) == (en.geo_score, en.seo_score, en.eeat_score)
    assert [(a.rule_id, a.impact, a.effort, a.category, a.check_id) for a in tr.actions] == \
           [(a.rule_id, a.impact, a.effort, a.category, a.check_id) for a in en.actions]
    assert list(tr.pillars) == list(en.pillars) == ["ai_access", "llm_readability", "eeat", "technical_seo"]
    assert [c.id for p in tr.pillars.values() for c in p.checks] == [c.id for p in en.pillars.values() for c in p.checks]
    assert [round(c.score) for p in tr.pillars.values() for c in p.checks] == \
           [round(c.score) for p in en.pillars.values() for c in p.checks]
    # display names, check details and action cards are Turkish
    assert tr.pillars["ai_access"].label == "AI Crawler ve Bot Erişilebilirliği"
    assert tr.pillars["technical_seo"].label == "Teknik SEO"
    assert "kelime" not in tr.pillars["eeat"].label
    trust = tr.pillars["eeat"].check("trust")
    assert "gizlilik/KVKK" in trust.detail and "SSL/HTTPS aktif" in trust.detail
    assert "sayısal değil" in tr.pillars["llm_readability"].check("schema_validity").detail
    by_rule = {a.rule_id: a for a in tr.actions}
    assert by_rule["technical.llms_txt"].title == "/llms.txt bağlam dosyası oluşturun"
    assert by_rule["technical.llms_txt"].snippet.instructions.startswith("Site köküne text/plain")
    assert by_rule["schema.faq_page"].title == "Sayfadaki soru-cevapları FAQPage şemasıyla işaretleyin"
    assert by_rule["authority.policy_pages"].title.startswith("Eksik güven sayfalarını yayınlayın: ")
    assert "Gizlilik ve KVKK Aydınlatma Metni" in by_rule["authority.policy_pages"].title
    assert "/gizlilik-politikasi" in by_rule["authority.policy_pages"].snippet.code
    assert "<!-- 1) Footer'a (tüm sayfalarda) bağlantı ekleyin -->" in by_rule["authority.policy_pages"].snippet.code
    assert by_rule["schema.faq_page"].snippet.instructions == "<head> içine ekleyin."
    assert tr.to_dict()["summary"] == tr.summary and tr.to_db_records()["audit"]["summary"] == tr.summary
    # the English run of the very same site uses the English snippet comments and paths
    en_rules = {a.rule_id: a for a in en.actions}
    assert "/privacy-policy" in en_rules["authority.policy_pages"].snippet.code
    assert en_rules["authority.policy_pages"].title.startswith("Publish the missing trust pages: ")


async def test_turkish_locale_scenario_texts(scenario_sites):
    _, rep = await audit_site(BAD + "/", CFG, lang="tr")
    assert rep.caps[0].startswith("tüm AI arama/cevap botları robots.txt ile engelli")
    robots = next(a for a in rep.actions if a.rule_id == "crawler.robots_ai_bots")
    assert robots.title.endswith("AI botunun erişimini açın") and "# --- AI arama ve cevap motorları (GEO) ---" in robots.snippet.code
    assert "Disallow: /sepet/" in robots.snippet.code and "User-agent: PerplexityBot\nAllow: /" in robots.snippet.code
    assert robots.snippet.instructions.startswith("Mevcut robots.txt dosyanızın en üstüne ekleyin")
    spam = next(a for a in rep.actions if a.rule_id == "content.spam_signals")
    assert spam.snippet.code.startswith('Önce: "Piyasanın en iyi, %100 garantili kahve makinesi!"')
    fact = rep.pillars["eeat"].check("factual_consistency")
    assert "kaynaksız" in fact.detail and "abartılı/pazarlama ifadeleri" in fact.detail
    llms = rep.pillars["llm_readability"].check("llms_txt")
    assert llms.score == 40 and "text/plain yerine text/html" in llms.detail
    ssr = next(a for a in rep.actions if a.rule_id == "technical.server_side_rendering")
    assert ssr.snippet.code.splitlines()[2] == "// app/urun/[slug]/page.tsx"
    # the same site in English keeps the English path in the same snippet
    _, en = await audit_site(BAD + "/", CFG)
    ssr_en = next(a for a in en.actions if a.rule_id == "technical.server_side_rendering")
    assert ssr_en.snippet.code.splitlines()[2] == "// app/product/[slug]/page.tsx"
    assert "Disallow: /cart/" in next(a for a in en.actions if a.rule_id == "crawler.robots_ai_bots").snippet.code


async def test_turkish_locale_unreachable_site():
    with respx.mock(assert_all_called=False) as router:
        router.route(host="wall.example.com").mock(return_value=httpx.Response(403, text="Access denied",
                                                                              headers={"content-type": "text/html"}))
        _, rep = await audit_site("https://wall.example.com/", CFG, lang="tr")
    assert rep.caps[-1] == "hiç sayfa alınamadı" and "Skor sınırlandı: " in rep.summary and rep.summary.endswith("hiç sayfa alınamadı")
    blocker = rep.actions[0]
    assert blocker.rule_id == "crawler.site_unreachable"
    assert blocker.title == "Site otomatik istemcilere hiç içerik döndürmüyor"
    assert blocker.snippet.code.startswith('# Cloudflare → Security → WAF → Custom rules → "Skip"')


def test_cli_lang_tr_text_report_and_json(fake_site, tmp_path, capsys):
    out = tmp_path / "audit.json"
    rc = audit_main([BASE + "/", "-o", str(out), "--rps", "0", "--text", "--code", "--no-ua-probe", "--lang", "tr"])
    assert rc == 0
    err = capsys.readouterr().err
    assert "NE YAPILMALI?" in err and "GEO SKORU:" in err and "(ağırlık %25)" in err and "Hedef:" in err
    assert "WHAT SHOULD BE DONE?" not in err
    data = json.loads(out.read_text())
    assert data["summary"].startswith("GEO skoru") and data["pillars"]["technical_seo"]["label"] == "Teknik SEO"
    assert set(data["pillars"]) == {"ai_access", "llm_readability", "eeat", "technical_seo"}
    # --lang is the report language; the Wikidata search language moved to --wikidata-lang
    assert audit_main([BASE + "/", "-o", str(tmp_path / "a2.json"), "--rps", "0", "--no-ua-probe", "--lang", "de",
                       "--wikidata-lang", "tr"]) == 0
    assert json.loads((tmp_path / "a2.json").read_text())["summary"].startswith("GEO score")  # unknown -> English
