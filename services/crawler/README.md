# geo-crawler

Async web crawler + entity extraction + knowledge graph ("graphify") engine for the AI visibility / GEO & SEO platform.

```
URL ─► robots.txt + sitemap(index/gz) ─► async BFS crawler (depth, page cap, concurrency, req/s, robots, crawl-delay)
    ─► HTML parser (title, meta, OG, Twitter, H1-H6, JSON-LD @graph, microdata, breadcrumbs, FAQs, text, links)
    ─► page classifier (home/product/service/category/article/about/contact/faq/other — TR + EN)
    ─► entity extractor (Product, Brand, Offer[price/stock], Person[author], Category, Question, Organization, Concept)
    ─► NetworkX MultiDiGraph ─► export_graph_json / GraphML / node-link / Prisma rows
    ─► gap detection (orphans, missing schema, products w/o related, thin content, ...)
```

## Usage

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/geo-crawler https://example.com -o graph.json --db-records records.json --depth 3 --max-pages 200 --rps 5 -v
.venv/bin/pytest -q
```

```python
from geo_crawler import CrawlConfig, index_site
res = await index_site("https://example.com", CrawlConfig(max_depth=3, max_pages=200, concurrency=5, requests_per_second=5))
res.export_graph_json("graph.json")   # nodes + edges + stats + gaps
rows = res.to_db_records()            # crawlSession / crawledPages / graphEntities / graphRelations
```

## Graph model

Nodes: `Page` (id `page:<url>`), `Product`, `Brand`, `Offer`, `Person`, `Category`, `Question`, `Organization`, `Concept`.

Edges: `has_category`, `contains_product`, `written_by`, `mentions_entity`, `links_to`, `answers_question`,
plus `has_brand`, `has_offer`, `published_by`, `related_product`.

`export_graph_json` (schema_version 1.0): `{site, generated_at, stats, nodes[{id,type,label,properties,source_urls}], edges[{source,target,type,properties}], gaps}`.
Page nodes carry `pagerank` over the internal link graph.

`to_db_records()` maps 1:1 onto the Prisma models from the platform skeleton: `GraphEntity.key` = node id
(unique per site → idempotent upsert), relations reference entities by `sourceKey`/`targetKey`, `weight` is lifted out of properties.

## Gap detection (`gaps`)

`orphan_pages` (no inbound internal link, e.g. sitemap-only), `sitemap_missing_pages`, `sitemap_not_crawled`,
`pages_without_schema`, `pages_missing_expected_schema` (per page type), `products_without_related|offer|brand|category`,
`articles_without_author`, `thin_content_pages`, `missing_meta_description`, `missing_h1`, `multiple_h1`,
`missing_open_graph`, `duplicate_titles`, `broken_pages`, and a `summary` with `schema_coverage`.

## Notes

- Content links are crawled before template (nav/header/footer/aside) links, so page caps reach products/articles instead of only menu pages.
- Products without schema fall back to OpenGraph `product:*` tags, then to on-page price + stock text.
- Keywords: weighted TF-IDF (title×3, headings×2, body), TR+EN stopwords, terms on >50% of pages dropped as boilerplate.
- JS-rendered (SPA) sites need a headless renderer — not included in this stage.
