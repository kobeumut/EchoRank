"""Semantic gap & structure detection over the knowledge graph + crawl result."""
from __future__ import annotations

from typing import Any

from .classifier import schema_types
from .extractor import page_id
from .graph import KnowledgeGraph
from .models import CrawlResult, EntityType, PageType, RelationType

# schema types a page of a given kind is expected to carry
EXPECTED_SCHEMA: dict[PageType, set[str]] = {
    PageType.PRODUCT: {"Product", "ProductGroup", "IndividualProduct"},
    PageType.ARTICLE: {"Article", "BlogPosting", "NewsArticle", "TechArticle"},
    PageType.FAQ: {"FAQPage", "QAPage"},
    PageType.HOME: {"Organization", "WebSite", "LocalBusiness", "Corporation", "Store", "OnlineStore"},
    PageType.ABOUT: {"AboutPage", "Organization", "LocalBusiness"},
    PageType.CONTACT: {"ContactPage", "Organization", "LocalBusiness"},
    PageType.CATEGORY: {"CollectionPage", "ItemList", "BreadcrumbList", "OfferCatalog"},
    PageType.SERVICE: {"Service"},
}


def detect_gaps(kg: KnowledgeGraph, crawl: CrawlResult, thin_content_words: int = 150) -> dict[str, Any]:
    pages = {p.url: p for p in crawl.ok_pages}
    link_graph = kg.page_link_graph()
    root = crawl.start_url

    # orphan: crawled page (typically found via sitemap) with no inbound internal link from another page
    orphan_pages = sorted(
        url for url in pages
        if url != root and not any(src != page_id(url) for src in link_graph.predecessors(page_id(url)))
    ) if pages else []

    sitemap_missing = sorted(u for u in pages if crawl.sitemap_urls and u not in crawl.sitemap_urls)
    sitemap_not_crawled = sorted(u for u in crawl.sitemap_urls if u not in crawl.pages)

    missing_schema: list[dict[str, Any]] = []
    no_schema: list[str] = []
    for url, p in pages.items():
        types = set(schema_types(p.json_ld) + schema_types(p.microdata))
        if not types:
            no_schema.append(url)
        expected = EXPECTED_SCHEMA.get(p.page_type)
        if expected and not (types & expected):
            missing_schema.append({"url": url, "page_type": p.page_type.value, "expected_any_of": sorted(expected),
                                   "found": sorted(types)})

    products = kg.nodes_of_type(EntityType.PRODUCT)
    products_without_related = []
    products_without_offer = []
    products_without_brand = []
    products_without_category = []
    for pid in products:
        if kg.g.nodes[pid].get("properties", {}).get("placeholder"):
            continue
        related = kg.neighbors(pid, RelationType.RELATED_PRODUCT) + kg.neighbors(pid, RelationType.RELATED_PRODUCT, "in")
        if not related:
            products_without_related.append(pid)
        if not kg.neighbors(pid, RelationType.HAS_OFFER):
            products_without_offer.append(pid)
        if not kg.neighbors(pid, RelationType.HAS_BRAND):
            products_without_brand.append(pid)
        if not kg.neighbors(pid, RelationType.HAS_CATEGORY):
            products_without_category.append(pid)

    articles_without_author = sorted(
        url for url, p in pages.items()
        if p.page_type is PageType.ARTICLE and not kg.neighbors(page_id(url), RelationType.WRITTEN_BY)
    )
    thin_content = sorted(url for url, p in pages.items() if p.word_count < thin_content_words)
    missing_meta_description = sorted(
        url for url, p in pages.items() if not (p.meta.get("description") or p.open_graph.get("description"))
    )
    missing_h1 = sorted(url for url, p in pages.items() if not p.headings.get("h1"))
    multiple_h1 = sorted(url for url, p in pages.items() if len(p.headings.get("h1", [])) > 1)
    missing_open_graph = sorted(url for url, p in pages.items() if not p.open_graph.get("title"))

    titles: dict[str, list[str]] = {}
    for url, p in pages.items():
        if p.title:
            titles.setdefault(p.title.strip().lower(), []).append(url)
    duplicate_titles = [sorted(v) for v in titles.values() if len(v) > 1]

    broken = [{"url": url, "status": p.status_code, "error": p.error} for url, p in sorted(crawl.pages.items()) if p.error]

    has_faq = bool(kg.nodes_of_type(EntityType.QUESTION))
    has_org = bool(kg.nodes_of_type(EntityType.ORGANIZATION))

    summary = {
        "pages_crawled": len(pages),
        "orphan_pages": len(orphan_pages),
        "pages_without_schema": len(no_schema),
        "pages_missing_expected_schema": len(missing_schema),
        "products_without_related": len(products_without_related),
        "articles_without_author": len(articles_without_author),
        "thin_content_pages": len(thin_content),
        "broken_pages": len(broken),
        "schema_coverage": round(1 - len(no_schema) / len(pages), 3) if pages else 0.0,
        "site_has_faq_content": has_faq,
        "site_has_organization_schema": has_org,
    }
    return {
        "summary": summary,
        "orphan_pages": orphan_pages,
        "sitemap_missing_pages": sitemap_missing,
        "sitemap_not_crawled": sitemap_not_crawled,
        "pages_without_schema": sorted(no_schema),
        "pages_missing_expected_schema": sorted(missing_schema, key=lambda x: x["url"]),
        "products_without_related": sorted(products_without_related),
        "products_without_offer": sorted(products_without_offer),
        "products_without_brand": sorted(products_without_brand),
        "products_without_category": sorted(products_without_category),
        "articles_without_author": articles_without_author,
        "thin_content_pages": thin_content,
        "missing_meta_description": missing_meta_description,
        "missing_h1": missing_h1,
        "multiple_h1": multiple_h1,
        "missing_open_graph": missing_open_graph,
        "duplicate_titles": duplicate_titles,
        "broken_pages": broken,
    }
