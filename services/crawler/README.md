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

## GEO / SEO / E-E-A-T scoring (`geo_crawler.scoring`)

API ingestion, endpoints and action-item lifecycle: [`docs/geo-scoring.md`](../../docs/geo-scoring.md).

```bash
.venv/bin/geo-audit https://example.com --text --code            # human-readable report + fix snippets
.venv/bin/geo-audit https://example.com -o audit.json --db-records rows.json --crawl-records crawl.json
```

```python
from geo_crawler.scoring import audit_site
index, report = await audit_site("https://example.com", CrawlConfig(max_pages=100))
report.geo_score, report.seo_score, report.eeat_score   # 0-100
report.to_dict()          # pillars → checks (score + Turkish reason), action cards, raw facts, site signals
report.to_db_records()    # {audit: GeoAudit fields, actionItems: ActionItem rows} → POST /api/sites/:id/audit/:auditId/result
```

Overall GEO score = weighted mean of four pillars (each = weighted mean of its checks, 0-100):

| Pillar (weight) | Checks (weight) |
| --- | --- |
| AI crawler access (25%) | robots.txt per AI bot, RFC 9309 evaluator (40) · WAF/CDN user-agent probe (15) · noindex/noai meta + X-Robots-Tag (10) · render mode SSR/SSG vs CSR shell (35) |
| LLM readability / GEO (35%) | FAQ & direct-answer blocks (25) · information density: lists/tables, figures, paragraph length, filler, lexical diversity (25) · Schema.org coverage per page type (20) · schema completeness/validity (15) · `llms.txt` (15) |
| Information trust / E-E-A-T (25%) | experience & expertise: authors, author pages, first-hand signals (25) · authority: Organization/sameAs/logo, citations to .gov/.edu/Wikipedia/DOI, ratings (20) · trust: HTTPS/HSTS, verifiable contact, privacy/terms/returns/shipping (30) · factual consistency: unsourced claims, hype/keyword stuffing, cross-page price/name conflicts (25) |
| Technical SEO (15%) — also `seoScore` | titles, meta description, H1, canonical/lang, OG, broken URLs, thin content, internal links/sitemap, image alt |

Hard caps: all answer/search bots blocked → max 35 · WAF blocks ≥3 AI bots → max 45 · key pages are client-side shells → max 40 · nothing fetched → 0.

Bots checked: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot,
Perplexity-User, Google-Extended, Applebot-Extended, Bingbot, CCBot (search/user bots weigh more than training bots).

**Action cards ("Ne Yapılmalı?")** — 22 rules in `scoring/actions.py`, each with `impact` (derived from the estimated
GEO-point gain, never below the rule's base impact), `effort`, `priority` (impact × reach / effort; score-capping
blockers always first), evidence, affected URLs and a copy-paste `snippet` generated from crawl data: robots.txt
allow-rules, WAF/Cloudflare exceptions, SSR (Next.js) example, `llms.txt` built from the crawl (PageRank order),
FAQPage / Organization / Product / Article+author / BreadcrumbList JSON-LD, Q&A and data-table HTML templates,
policy-page footer + schema, contact `<address>` + ContactPoint, citation/footnote markup, HSTS nginx config,
meta descriptions, 301 rewrites.

## Wikidata reconciliation + JSON-LD `@graph`

```bash
.venv/bin/geo-reconcile graph.json -o graph.reconciled.json --jsonld schema.json
.venv/bin/geo-audit https://example.com --reconcile --crawl-records crawl.json --jsonld schema.json
```

Organization / Brand / Person / Product / Concept nodes are matched to Wikidata QIDs (`wikidata.py`: search →
claims → name/type/context/website scoring, SPARQL class closure, Wikipedia + Crunchbase fallbacks) and get
`wikidataId`, `wikipediaUrl`, `sameAs`, `confidence` and `same_as` edges; `jsonld.py` turns the graph into a
Rich Results-valid Schema.org `@graph`. Details, thresholds and the review API: [`docs/wikidata.md`](../../docs/wikidata.md).

## Notes

- Content links are crawled before template (nav/header/footer/aside) links, so page caps reach products/articles instead of only menu pages.
- Products without schema fall back to OpenGraph `product:*` tags, then to on-page price + stock text.
- Keywords: weighted TF-IDF (title×3, headings×2, body), TR+EN stopwords, terms on >50% of pages dropped as boilerplate.
- JS-rendered (SPA) sites need a headless renderer — not included in this stage. The scorer detects them
  (empty `#root/#app/#__next` + scripts, little server text) and reports it, since AI crawlers do not run JS either.
