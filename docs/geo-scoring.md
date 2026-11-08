# GEO / SEO / E-E-A-T scoring — platform integration

The scoring model (pillars, checks, weights, caps, action rules) is documented in
[`services/crawler/README.md`](../services/crawler/README.md#geo--seo--e-e-a-t-scoring-geo_crawlerscoring).
This page covers how its output reaches the database and the API.

## Running audits

| Mode | How |
| --- | --- |
| In-process | Set `GEO_AUDIT_BIN=services/crawler/.venv/bin/geo-audit` (optional `GEO_AUDIT_ARGS="--rps 2"`). `POST /api/sites/:id/audit` then runs crawl → graph → scoring and stores everything. |
| External worker | Leave `GEO_AUDIT_BIN` empty. Audits stay `queued`; a worker runs `geo-audit <url> --db-records rows.json --crawl-records crawl.json` and posts `{...rows, crawl}` to the result endpoint. |

## Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/sites/:id/audit/:auditId/result` | Ingest scoring output: `{ audit: {geoScore, seoScore, eeatScore, metrics, summary}, actionItems: [...], crawl?: {crawlSession, crawledPages, graphEntities, graphRelations} }` |
| `GET` | `/api/sites/:id/autogeo` | AutoGEO content report: per-page metric summary + open `autogeo.*` action items with diffs ([details](autogeo.md)) |
| `GET/POST` | `/api/sites/:id/bot-simulator` | Latest audit's live AI-crawler simulation summary / run one now ([details](bot-simulator.md)) |
| `GET` | `/api/sites/:id/actions` | Action cards by priority. `?status=open,in_progress` (default) `&category=schema&impact=high&limit=100` |
| `PATCH` | `/api/sites/:id/actions/:actionId` | `{ "status": "open" \| "in_progress" \| "resolved" \| "dismissed" }` |

## Action item lifecycle

Action items are identified across audits by `(ruleId, targetUrl)`:

- still reported and open → updated in place (new evidence/snippet, moved to the latest audit)
- dismissed by a user → not recreated
- machine-generated, open, and no longer reported → auto-`resolved` (the defect was fixed)
- manually created items (`ruleId = null`) are never touched

`ActionItem.details` holds `{ check_id, evidence[], expected_gain, affected_urls[], affected_count, snippet: { language, code, filename, instructions } }`.

`GeoAudit.metrics` holds flat sub-scores (`aiAccess`, `llmReadability`, `eeat`, `technicalSeo`, one key per check such
as `robotsAiBots`, `renderMode`, `llmsTxt`, `schemaValidity`, `trust`, ...), `grade`, `caps` and the full
`pillars` breakdown with the reason text of every check.
