# AutoGEO: content optimization engine

AutoGEO estimates how likely a page's content is to be quoted and cited by generative engines (ChatGPT,
Perplexity, Gemini, Claude). It scores six metrics and produces block-level rewrites as Markdown/HTML diffs you
can copy and paste. The rules come from:

- **GEO: Generative Engine Optimization** (Princeton, Georgia Tech, AI2; KDD 2024, arXiv:2311.09735). Measured visibility gains: Quotation Addition ~+41%, Statistics Addition ~+37%, Cite Sources ~+30-40% (and +115.1% for pages ranked 5th or lower), Fluency/authoritative tone ~+25%. Keyword stuffing gives no gain and risks a loss (-10% to -25%).
- **AutoGEO** (CMU; ICLR 2026, arXiv:2510.11438). Engine preference rules favour self-contained passages that answer directly under each heading. AutoGEO models these as 40-60 word *answer capsules*.

## Metrics (0-100, higher is better)

| Metric | Measured | Target / rule |
| --- | --- | --- |
| `statistics` | numeric facts per 100 words (bare years excluded), vague-quantity sentences ("birçok", "çoğu", "most", "significantly"), tables | ≥1.5 figures / 100 words, no vague quantities |
| `quotations` | attributed quotes (`<blockquote>` with `<cite>`/`<footer>`/"— Name", inline “…” next to a speech verb or title) | ≥1 per ~600 words; an unattributed quote counts 0.4 |
| `citations` | share of claim sentences with a source (link in the block, `[1]`, `(Author, 2024)`, "X'e göre", "according to X") + authority of external domains (tier 1: .gov/.edu/.ac/.int, DOI, arXiv, PubMed, WHO, OECD…; tier 2: Statista, Gartner, Pew, ISO, W3C, Wikipedia…) | full coverage + ≥2 weighted authoritative sources (≥1 per 500 words) |
| `answer_capsules` | first block under every H2/H3 (or the intro when there are no subheadings) | 40-60 word paragraph that doesn't open with "Bu/This/It…" and repeats the question's term |
| `authority_fluency` | hedges ("sanırım", "belki", "I think", "might be"), filler, hype, passive voice, sentences >35 words | none |
| `keyword_stuffing` | top content word share (brand tokens excluded), top bigram repetition | word ≤4%, phrase ≤4%. Risk is `-10%` below 70 and `-25%` below 40 |

The page score is a weighted mean, and the weights depend on the content type (`article`, `product`, `service`,
`default`). For example, product pages give less weight to quotations and more to statistics and keyword
stuffing. Severe keyword stuffing caps the page score at 60.

## Improvements

Each weak block yields an `Improvement`:

- `kind`: `rewrite` replaces a block. `insert` adds a new block after `block_index`, such as a capsule under a heading, a quote, a key-figures table, a comparison table or a "Kaynaklar" (Sources) list.
- `after_markdown` and `after_html` hold the new content. `diff_markdown` and `diff_html` hold unified diffs against the block's canonical rendering.
- When several rules touch the same block, they merge into one rewrite. `metrics` lists every metric that rewrite fixes, so each diff applies cleanly on its own.
- Numbers, names and sources are never invented. Rewrites insert placeholders (`[SAYI]`, `%[ORAN]`, `([Kaynak, Yıl](https://kaynak-adresi))`, `[Ad Soyad], [Unvan], [Kurum]`, `[eş anlamlı/zamir]`) for the editor to fill.

Every report also includes a page-level `answer_capsule` and, when the page has no table, a `comparison_table` suggestion.

## Usage

```bash
services/crawler/.venv/bin/geo-autogeo https://example.com/blog/post --type article      # text report + diffs
services/crawler/.venv/bin/geo-autogeo page.md --type service --json                    # JSON report
services/crawler/.venv/bin/geo-autogeo page.html --url https://example.com/p --rank 7   # SERP rank → citation gain
```

```python
from geo_crawler.scoring import analyze_html, analyze_markdown, analyze_pages
r = analyze_html(html, url="https://example.com/blog/x", page_type="article")
r.score, r.metrics["citations"].score, r.improvements[0].diff_markdown
```

`geo-audit` runs AutoGEO automatically on the crawled content pages (up to 25 pages with at least 80 words each).
The output appears under `autogeo` in `report.to_dict()` and `to_db_records()`. It does **not** change `geoScore`.

## Platform integration (`src/lib/services/autogeo.ts`)

- `POST /api/sites/:id/audit/:auditId/result` accepts the optional `autogeo` payload. Each (page, metric) that needs work becomes one ActionItem: `ruleId` is `autogeo.<metric>` (or `autogeo.comparison_table`) and `targetUrl` is the page URL. `details` holds `snippet` (a combined `diff` patch), `improvements[]` (per-block diffs and replacements), `score`, `expected_gain` and, for capsules, `answerCapsule`.
- `GeoAudit.metrics.autogeo` stores a compact summary: the site score, metric means and per-page scores.
- Reconciliation follows the existing rules. A page that no longer reports a problem auto-resolves its AutoGEO items. A payload without `autogeo` (an older crawler) leaves those items untouched. Built-in and AutoGEO items together are capped at 500 per audit.
- `GET /api/sites/:id/autogeo` returns the latest summary and the open AutoGEO items.
- `createUnifiedDiff` / `applyUnifiedDiff` regenerate missing patches and check that the patches apply.
