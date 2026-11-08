from fixtures import BASE, PAGES

from geo_crawler.classifier import classify_page
from geo_crawler.models import PageType
from geo_crawler.parser import parse_html


def page(path):
    p = parse_html(PAGES[path], BASE + path, BASE + "/")
    p.page_type = classify_page(p, BASE + "/")
    return p


def test_home_parsing():
    p = page("/")
    assert p.title == "Kahve Dükkanı | Anasayfa"
    assert p.lang == "tr"
    assert p.meta["description"] == "En iyi kahve makineleri"
    assert p.open_graph["title"] == "Kahve Dükkanı"
    assert p.twitter["card"] == "summary_large_image"
    assert p.canonical == BASE + "/"  # tracking param stripped
    assert p.headings["h1"] == ["Kahve Dükkanı"]
    assert {b["@type"] for b in p.json_ld} == {"Organization", "WebSite"}  # @graph flattened
    internal = {l.url for l in p.internal_links}
    assert BASE + "/urun/barista-pro-x" in internal
    assert BASE + "/img/logo.png" not in internal  # static resource skipped
    assert [l.url for l in p.external_links] == ["https://instagram.com/kahve"]
    assert p.external_links[0].nofollow
    assert p.word_count > 100
    assert "application/ld+json" not in p.text
    assert p.page_type is PageType.HOME


def test_microdata_nested():
    p = page("/urun/mini-espresso")
    assert len(p.microdata) == 1
    item = p.microdata[0]
    assert item["@type"] == "Product" and item["name"] == "Mini Espresso" and item["sku"] == "ME-20"
    assert item["brand"]["name"] == "Brevio"
    assert item["offers"]["price"] == "3999.00"
    assert item["offers"]["availability"] == "https://schema.org/OutOfStock"
    assert p.page_type is PageType.PRODUCT


def test_breadcrumbs_and_faqs():
    assert page("/kategori/kahve-makineleri").breadcrumbs == ["Anasayfa", "Mutfak", "Kahve Makineleri"]
    assert page("/urun/barista-pro-x").breadcrumbs == ["Anasayfa", "Kahve Makineleri", "Barista Pro X"]
    assert page("/hakkimizda").faqs[0]["question"] == "Ne zaman kurulduk?"
    assert "2010" in page("/hakkimizda").faqs[0]["answer"]
    assert page("/iletisim").faqs[0]["question"] == "Mağazanız nerede?"


def test_classification():
    expected = {
        "/kategori/kahve-makineleri": PageType.CATEGORY,
        "/urun/barista-pro-x": PageType.PRODUCT,
        "/urun/filtre-klasik": PageType.PRODUCT,  # OpenGraph only
        "/blog/espresso-rehberi": PageType.ARTICLE,
        "/sss": PageType.FAQ,
        "/hakkimizda": PageType.ABOUT,
        "/iletisim": PageType.CONTACT,
        "/kampanya-gizli": PageType.OTHER,
    }
    for path, pt in expected.items():
        assert page(path).page_type is pt, path


def test_broken_json_ld_tolerated():
    html = '<html><head><script type="application/ld+json">{"@type": "Product", "name": "X",}</script>' \
           '<script type="application/ld+json">{{{garbage</script></head><body></body></html>'
    p = parse_html(html, "https://x.com/p", "https://x.com/")
    assert p.json_ld == [{"@type": "Product", "name": "X"}]


def test_price_regex_and_nav_links():
    from geo_crawler.classifier import PRICE_TEXT
    from geo_crawler.extractor import _price

    assert PRICE_TEXT.search("£51.77 In stock").group(0) == "£51.77"
    assert _price(PRICE_TEXT.search("Fiyat: 12.499,90 TL").group(0)) == 12499.90
    assert PRICE_TEXT.search("$5 only").group(0) == "$5"
    assert _price("1,299.50") == 1299.50
    p = page("/")
    nav = {l.url: l.in_nav for l in p.internal_links}
    assert nav[BASE + "/sss"] is True  # inside <nav>
    assert nav[BASE + "/urun/barista-pro-x"] is False  # body content link
    assert "Anasayfa" not in p.text  # nav chrome excluded from body text


def test_product_without_schema_text_fallback():
    from geo_crawler.extractor import extract_entities

    html = "<html><head><title>Kitap X</title></head><body><h1>Kitap X</h1><p>£51.77</p><p>In stock (22 available)</p></body></html>"
    p = parse_html(html, "https://x.com/catalogue/kitap-x", "https://x.com/")
    p.page_type = classify_page(p, "https://x.com/")
    assert p.page_type is PageType.PRODUCT
    res = extract_entities([p])
    prod = next(e for e in res.entities if e.type.value == "Product")
    assert prod.properties["price"] == 51.77 and prod.properties["currency"] == "GBP"
    assert prod.properties["availability"] == "in_stock"
