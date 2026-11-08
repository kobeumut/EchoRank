"""A small fake Turkish e-commerce site served through respx."""
import json

import httpx

BASE = "https://shop.example.com"


def ld(obj) -> str:
    return f'<script type="application/ld+json">{json.dumps(obj, ensure_ascii=False)}</script>'


NAV = """
<nav><a href="/">Anasayfa</a> <a href="/kategori/kahve-makineleri">Kahve Makineleri</a>
<a href="/blog/espresso-rehberi">Blog</a> <a href="/sss">SSS</a> <a href="/hakkimizda">Hakkımızda</a>
<a href="/iletisim">İletişim</a></nav>
"""

FILLER = " ".join(["Kahve makinesi seçerken basınç, öğütme ve süt köpürtme özelliklerine dikkat edin."] * 20)

PAGES = {
    "/": f"""<html lang="tr"><head><title>Kahve Dükkanı | Anasayfa</title>
<meta name="description" content="En iyi kahve makineleri">
<meta property="og:title" content="Kahve Dükkanı"><meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://shop.example.com/?utm_source=x">
{ld({"@context": "https://schema.org", "@graph": [
    {"@type": "Organization", "name": "Kahve Dükkanı A.Ş.", "url": BASE, "sameAs": ["https://instagram.com/kahve"]},
    {"@type": "WebSite", "name": "Kahve Dükkanı", "url": BASE}]})}
</head><body>{NAV}<h1>Kahve Dükkanı</h1><h2>Öne çıkanlar</h2>
<a href="/urun/barista-pro-x">Barista Pro X</a>
<a href="/admin/panel">Yönetim</a>
<a href="/kirik-sayfa">Kırık</a>
<a href="https://instagram.com/kahve" rel="nofollow">Instagram</a>
<a href="mailto:info@shop.example.com">Mail</a>
<a href="/img/logo.png">logo</a>
<p>{FILLER}</p></body></html>""",

    "/kategori/kahve-makineleri": f"""<html><head><title>Kahve Makineleri</title>
{ld({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Anasayfa", "item": BASE + "/"},
    {"@type": "ListItem", "position": 2, "name": "Mutfak", "item": BASE + "/kategori/mutfak"},
    {"@type": "ListItem", "position": 3, "name": "Kahve Makineleri"}]})}
</head><body>{NAV}<h1>Kahve Makineleri</h1>
<a href="/urun/barista-pro-x">Barista Pro X</a> <a href="/urun/mini-espresso">Mini Espresso</a>
<a href="/urun/filtre-klasik">Filtre Klasik</a><p>{FILLER}</p></body></html>""",

    "/urun/barista-pro-x": f"""<html><head><title>Barista Pro X</title>
<meta name="description" content="Profesyonel espresso makinesi">
<meta property="og:type" content="product"><meta property="og:title" content="Barista Pro X">
{ld({"@context": "https://schema.org", "@type": "Product", "name": "Barista Pro X", "sku": "BPX-100",
     "brand": {"@type": "Brand", "name": "Brevio"}, "category": "Mutfak > Kahve Makineleri",
     "offers": {"@type": "Offer", "price": "12.499,90", "priceCurrency": "TRY",
                "availability": "https://schema.org/InStock"},
     "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.7", "reviewCount": "31"}})}
</head><body>{NAV}
<ol class="breadcrumb"><li><a href="/">Anasayfa</a></li><li><a href="/kategori/kahve-makineleri">Kahve Makineleri</a></li><li>Barista Pro X</li></ol>
<h1>Barista Pro X</h1><p>12.499,90 TL</p><button>Sepete Ekle</button>
<h3>Benzer ürünler</h3><a href="/urun/mini-espresso">Mini Espresso</a>
<p>{FILLER}</p></body></html>""",

    "/urun/mini-espresso": f"""<html><head><title>Mini Espresso</title></head><body>{NAV}
<div itemscope itemtype="https://schema.org/Product">
  <h1 itemprop="name">Mini Espresso</h1>
  <meta itemprop="sku" content="ME-20">
  <div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Brevio</span></div>
  <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
    <span itemprop="price" content="3999.00">3.999 TL</span>
    <meta itemprop="priceCurrency" content="TRY">
    <link itemprop="availability" href="https://schema.org/OutOfStock">
  </div>
</div><p>{FILLER}</p></body></html>""",

    "/urun/filtre-klasik": f"""<html><head><title>Filtre Klasik</title>
<meta property="og:type" content="product"><meta property="og:title" content="Filtre Klasik">
<meta property="product:price:amount" content="1499"><meta property="product:price:currency" content="TRY">
</head><body>{NAV}<h1>Filtre Klasik</h1><h1>İkinci H1</h1><p>Kısa açıklama.</p></body></html>""",

    "/blog/espresso-rehberi": f"""<html><head><title>Espresso Rehberi</title>
{ld({"@context": "https://schema.org", "@type": "BlogPosting", "headline": "Espresso Rehberi",
     "author": {"@type": "Person", "name": "Ayşe Yılmaz", "jobTitle": "Barista"},
     "publisher": {"@type": "Organization", "name": "Kahve Dükkanı A.Ş."},
     "datePublished": "2026-10-01", "articleSection": "Rehberler"})}
</head><body>{NAV}<h1>Espresso Rehberi</h1><h2>Öğütme</h2>
<p>Barista Pro X ile mükemmel espresso hazırlayabilirsiniz. Brevio markası ...</p><p>{FILLER}</p></body></html>""",

    "/sss": f"""<html><head><title>Sıkça Sorulan Sorular</title>
{ld({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
    {"@type": "Question", "name": "Kargo ücretsiz mi?", "acceptedAnswer": {"@type": "Answer", "text": "500 TL üzeri ücretsiz."}},
    {"@type": "Question", "name": "Garanti süresi nedir?", "acceptedAnswer": {"@type": "Answer", "text": "2 yıl."}}]})}
</head><body>{NAV}<h1>Sıkça Sorulan Sorular</h1><p>{FILLER}</p></body></html>""",

    "/hakkimizda": f"""<html><head><title>Hakkımızda</title></head><body>{NAV}<h1>Hakkımızda</h1>
<details><summary>Ne zaman kurulduk?</summary><p>2010 yılında İstanbul'da.</p></details>
<p>{FILLER}</p></body></html>""",

    "/iletisim": f"""<html><head><title>İletişim</title></head><body>{NAV}<h1>İletişim</h1>
<h2>Mağazanız nerede?</h2><p>Kadıköy, İstanbul.</p><p>{FILLER}</p></body></html>""",

    "/kampanya-gizli": f"""<html><head><title>Gizli Kampanya</title></head><body>
<h1>Gizli Kampanya</h1><p>{FILLER}</p></body></html>""",

    "/admin/panel": "<html><body><h1>ADMIN</h1></body></html>",
    "/eski-urun": None,  # redirect
}

ROBOTS = f"""User-agent: *
Disallow: /admin/
Sitemap: {BASE}/sitemap_index.xml
"""

SITEMAP_INDEX = f"""<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>{BASE}/sitemap-pages.xml</loc></sitemap>
</sitemapindex>"""

SITEMAP_PAGES = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>{BASE}/</loc><lastmod>2026-11-01</lastmod></url>
  <url><loc>{BASE}/kategori/kahve-makineleri</loc></url>
  <url><loc>{BASE}/urun/barista-pro-x</loc></url>
  <url><loc>{BASE}/kampanya-gizli</loc></url>
  <url><loc>{BASE}/eski-urun</loc></url>
</urlset>"""


class FakeSite:
    def __init__(self):
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append(path)
        if path == "/robots.txt":
            return httpx.Response(200, text=ROBOTS)
        if path == "/sitemap_index.xml":
            return httpx.Response(200, text=SITEMAP_INDEX, headers={"content-type": "application/xml"})
        if path == "/sitemap-pages.xml":
            return httpx.Response(200, text=SITEMAP_PAGES, headers={"content-type": "application/xml"})
        if path == "/eski-urun":
            return httpx.Response(301, headers={"location": f"{BASE}/urun/barista-pro-x"})
        html = PAGES.get(path)
        if html is None:
            return httpx.Response(404, text="not found", headers={"content-type": "text/html"})
        return httpx.Response(200, text=html, headers={"content-type": "text/html; charset=utf-8"})
