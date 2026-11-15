"""Heuristic page-type detection (schema.org > OpenGraph > URL > content signals).

Patterns cover both English and Turkish URL conventions.
"""
from __future__ import annotations

import re
from typing import Any

from .models import PageData, PageType
from .urls import normalize_url, url_path

SCHEMA_TYPE_MAP: dict[str, PageType] = {
    "Product": PageType.PRODUCT,
    "ProductGroup": PageType.PRODUCT,
    "IndividualProduct": PageType.PRODUCT,
    "Service": PageType.SERVICE,
    "FAQPage": PageType.FAQ,
    "QAPage": PageType.FAQ,
    "Article": PageType.ARTICLE,
    "BlogPosting": PageType.ARTICLE,
    "NewsArticle": PageType.ARTICLE,
    "TechArticle": PageType.ARTICLE,
    "AboutPage": PageType.ABOUT,
    "ContactPage": PageType.CONTACT,
    "CollectionPage": PageType.CATEGORY,
    "OfferCatalog": PageType.CATEGORY,
    "ItemList": PageType.CATEGORY,
}

# order matters: first match wins. The Turkish slugs next to the English ones (sss, iletisim, hakkimizda, urun, hizmet,
# kategori, haber, ...) are deliberate: they classify pages of Turkish sites.
URL_PATTERNS: list[tuple[PageType, re.Pattern[str]]] = [
    (PageType.FAQ, re.compile(r"/(faq|faqs|sss|sik-sorulan-sorular|sikca-sorulan-sorular|yardim|help)(/|$|\.)", re.I)),
    (PageType.CONTACT, re.compile(r"/(contact|contact-us|iletisim|bize-ulasin)(/|$|\.)", re.I)),
    (PageType.ABOUT, re.compile(r"/(about|about-us|hakkimizda|hakkinda|kurumsal|biz-kimiz)(/|$|\.)", re.I)),
    (PageType.ARTICLE, re.compile(r"/(blog|blogs|news|haber|haberler|makale|makaleler|article|articles|post|posts|yazi|yazilar)/[^/]+", re.I)),
    (PageType.PRODUCT, re.compile(r"/(product|products|urun|urunler|p|item|shop/[^/]+/[^/]+)/[^/]+", re.I)),
    (PageType.SERVICE, re.compile(r"/(service|services|hizmet|hizmetler|hizmetlerimiz)(/|$)", re.I)),
    (PageType.CATEGORY, re.compile(r"/(category|categories|kategori|kategoriler|collection|collections|c|shop|tag|etiket)(/|$)", re.I)),
    (PageType.ARTICLE, re.compile(r"/(blog|news|haberler)(/?$)", re.I)),  # blog index treated as category below
]

# Turkish alternatives next to the English ones are deliberate: they recognise Turkish storefronts
# (sık sorulan = frequently asked, sepete ekle = add to cart, hemen al / satın al = buy now,
#  stokta var/yok = in stock / out of stock, tükendi = sold out, stok adedi = stock count).
FAQ_HEADING = re.compile(r"(sık(ça)? sorulan|sss\b|faq|frequently asked)", re.I)
PRICE_TEXT = re.compile(r"(?:₺|\$|€|£|\bTL\b|\bTRY\b|\bUSD\b|\bEUR\b)\s?\d(?:[\d.,]*\d)?|\d[\d.,]*\s?(?:₺|TL|TRY|\$|€|USD|EUR)\b")
ADD_TO_CART = re.compile(r"(sepete ekle|add to cart|add to basket|buy now|hemen al|satın al)", re.I)
STOCK_TEXT = re.compile(r"\b(in stock|out of stock|stokta( var| yok)?|tükendi|stok adedi|available now)\b", re.I)


def schema_types(blocks: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for b in blocks:
        t = b.get("@type")
        for x in t if isinstance(t, list) else [t]:
            if isinstance(x, str):
                out.append(x.rsplit("/", 1)[-1])
    return out


def classify_page(page: PageData, root_url: str) -> PageType:
    # 1. homepage
    root = normalize_url(root_url) or root_url
    if url_path(page.url) in ("/", "", "/index.html", "/index.php") or page.url.rstrip("/") == root.rstrip("/"):
        return PageType.HOME

    # 2. structured data
    types = schema_types(page.json_ld) + schema_types(page.microdata)
    priority = [PageType.PRODUCT, PageType.FAQ, PageType.ARTICLE, PageType.SERVICE,
                PageType.ABOUT, PageType.CONTACT, PageType.CATEGORY]
    found = {SCHEMA_TYPE_MAP[t] for t in types if t in SCHEMA_TYPE_MAP}
    # a single Product inside an ItemList page is still a category listing
    if PageType.PRODUCT in found and PageType.CATEGORY in found and types.count("Product") > 1:
        return PageType.CATEGORY
    for pt in priority:
        if pt in found:
            return pt

    # 3. OpenGraph
    og_type = page.open_graph.get("type", "").lower()
    if og_type in ("product", "product.item", "og:product"):
        return PageType.PRODUCT
    if og_type == "article":
        return PageType.ARTICLE

    # 4. URL patterns
    path = url_path(page.url)
    for pt, pattern in URL_PATTERNS:
        if pattern.search(path):
            if pt is PageType.ARTICLE and re.search(r"/(blog|news|haberler)/?$", path, re.I):
                return PageType.CATEGORY
            return pt

    # 5. content signals
    headings = " ".join(h for hs in page.headings.values() for h in hs)
    if FAQ_HEADING.search(headings):
        return PageType.FAQ
    if PRICE_TEXT.search(page.text[:5000]) and (ADD_TO_CART.search(page.text) or STOCK_TEXT.search(page.text[:5000])):
        return PageType.PRODUCT
    if page.meta.get("author") or page.meta.get("article:published_time"):
        return PageType.ARTICLE
    return PageType.OTHER
