# AI Visibility — GEO & SEO Platform

Tracks how a website appears in AI answer engines (ChatGPT, Gemini, Claude, Perplexity), scores it for
GEO / technical SEO / information trust (E-E-A-T), builds a knowledge graph of the site and produces
prioritized action items plus daily/weekly reports.

## Stack

- **Next.js 16** (App Router, Route Handlers, `proxy.ts`), TypeScript, Tailwind CSS 4
- **Prisma 6** ORM — SQLite for development, PostgreSQL for production
- **zod 4** request validation, **vitest** API tests

## Quick start

```bash
npm install            # also runs `prisma generate`
cp .env.example .env
npm run db:migrate     # applies migrations to prisma/dev.db and seeds demo data
npm run dev            # http://localhost:3000
npm test               # API tests against a throwaway prisma/test.db
npm run build          # production build
```

Use `npm run db:seed` to reseed the demo site and `npm run db:studio` to browse data.

### PostgreSQL

Set `provider = "postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL` at Postgres, delete
`prisma/migrations` and run `npx prisma migrate dev --name init` (Prisma migrations are provider-specific).
The schema only uses portable types: enum-like fields are `String` columns validated in
`src/lib/constants.ts`.

## Architecture

```
src/
  app/
    api/…            Route handlers. Thin: parse/validate → service → JSON
    page.tsx         Minimal site overview (dashboard comes in a later stage)
  lib/
    db.ts            Prisma client singleton
    constants.ts     Domain enums (statuses, entity/relation types, LLM models…)
    validation.ts    zod schemas for every request body/query
    http.ts          handle() wrapper: HttpError / ZodError / Prisma errors → JSON responses
    url.ts           Site URL normalization (origin, lower-case, http/https only)
    services/        Business logic: sites, audit, graph, reports
    distribution/    AI distribution engine: IndexNow, Google, llms.txt, AI sitemap, feeds, webhooks
  proxy.ts           Optional bearer-token guard for /api/* (set API_TOKEN)
prisma/
  schema.prisma      Data model
  migrations/        SQL migrations
  seed.ts            Demo data
tests/               vitest API tests (call route handlers directly)
```

### Audit pipeline extension point

`POST /api/sites/:id/audit` creates a `CrawlSession` (`queued`) and a `GeoAudit` (`pending`) in one
transaction. Only one active crawl per site is allowed (409 otherwise). The crawler / scoring modules
plug in with:

```ts
import { registerAuditRunner } from "@/lib/services/audit";
registerAuditRunner(async ({ site, crawlSession, audit }) => {
  // crawl → upsert CrawledPage / GraphEntity / GraphRelation → score → ActionItems
});
```

When a runner is registered the job runs after the response via `after()`; a thrown error marks both the
crawl session and audit `failed`. Without a runner the job stays `queued` for an external worker.
If the runner leaves the crawl session `completed`, the distribution engine diffs the new crawl and
announces changed URLs (see below). A distribution error is logged and never fails the audit.

## Data model

| Model | Purpose |
| --- | --- |
| `Site` | Tracked site: normalized origin URL (unique), title, `settings`, `targetKeywords`, `integrations` (secrets, masked in API output) |
| `CrawlSession` | Crawl run: status, trigger, limits, pages crawled/failed, timings |
| `CrawledPage` | Latest technical snapshot per `(site, url)`: status code, page type, title, meta, canonical, H1, word count, extracted data |
| `GraphEntity` | Knowledge-graph node (`Page`, `Product`, `Category`, `FAQ`, `Organization`, `Author`, `Brand`, `Article`, `Concept`), unique `(site, key)` for idempotent upserts |
| `GraphRelation` | Edge (`links_to`, `has_category`, `contains_product`, `written_by`, `mentions_entity`, `answers_question`, `same_as`, `part_of`), unique per `(source, target, type)` |
| `GeoAudit` | GEO / SEO / E-E-A-T scores (0–100) plus sub-`metrics` |
| `LlmVisibilityRecord` | One AI engine check: model, query, `cited`/`mentioned`/`none`, position, excerpt |
| `ActionItem` | Recommendation: category (`crawler`, `schema`, `content`, `authority`, `technical`), impact, status |
| `ScheduledReport` | `daily`/`weekly` report: recipients, last/next run |
| `PlatformSubmission` | Log of URL/content pushes (`indexnow`, `google_indexing`, `google_search_console`, `webhook`) with the remote response |
| `SubmissionQueueItem` | Outbound notification queue: one row per `(site, url, channel)`, change reason, content fingerprint, attempts / backoff |

Deleting a site cascades to all of its data. Json columns are nullable (Prisma 6 can't emit Json
defaults for SQLite); readers treat `null` as `{}` / `[]`.

## API

All responses are JSON. Errors: `{ "error": string, "details"?: any }` with 400 (validation), 401,
404, 409 (duplicate / audit already running) or 500.

| Method & path | Description |
| --- | --- |
| `GET /api/health` | DB health check (always public) |
| `GET /api/sites?q=&limit=&offset=` | List sites with latest completed audit and open action count |
| `POST /api/sites` | Create `{ url, title?, description?, settings?, targetKeywords?, integrations? }` |
| `GET /api/sites/:id` | Get site |
| `PATCH /api/sites/:id` | Partial update; `integrations` are merged, a `null` value removes a key |
| `DELETE /api/sites/:id` | Delete site and all related data (204) |
| `POST /api/sites/:id/audit` | Queue crawl + audit `{ trigger?, maxPages?, maxDepth? }` → 202 |
| `GET /api/sites/:id/audit` | Recent audits with crawl progress |
| `GET /api/sites/:id/graph?types=Product,Category&limit=` | Nodes (with in/out degree), edges, stats (counts by type, orphan pages, truncation) |
| `GET /api/sites/:id/reports?days=30` | Latest scores and change vs previous audit, score history, AI visibility per model, action item breakdown, schedules |
| `GET/POST /api/sites/:id/reports/schedules` | List / create `{ frequency: "daily"\|"weekly", recipients: string[] }` (next run 06:00 UTC; weekly on Monday) |

AI distribution (details in the next section):

| Method & path | Description |
| --- | --- |
| `GET /api/sites/:id/distribution` | Settings, channel readiness, queue counters, last 20 submissions |
| `PATCH /api/sites/:id/distribution` | Partial settings update (nested objects are merged) |
| `GET/POST /api/sites/:id/distribution/indexnow-key` | Show / create the IndexNow key (`{ "rotate": true }` replaces it). `?format=txt` downloads the key file |
| `POST /api/sites/:id/distribution/indexnow-key/verify` | Fetch the published key file from the site and check it |
| `GET /api/sites/:id/distribution/queue?status=&channel=&limit=` | Queue rows |
| `POST /api/sites/:id/distribution/queue` | Announce URLs now `{ urls, reason?: "created"\|"updated"\|"deleted", channels? }` → 202 (CMS hook) |
| `POST /api/sites/:id/distribution/sync` | Diff the latest crawl against the queue `{ mode?: "notify"\|"baseline" }` |
| `POST /api/sites/:id/distribution/dispatch` | Send due queue rows now |
| `GET/POST /api/sites/:id/distribution/syndicate` | Preview / push this period's rotation to webhooks `{ force? }` |
| `GET /api/sites/:id/ai/llms.txt`, `llms-full.txt` | Generated `llms.txt` files (Markdown) |
| `GET /api/sites/:id/ai/sitemap-ai.xml` | Prioritized sitemap of indexable URLs |
| `GET /api/sites/:id/ai/ai-feed.xml`, `ai-feed.atom`, `ai-feed.json` | RSS 2.0 / Atom / JSON Feed 1.1 of the current rotation |
| `POST /api/distribution/run` | Cron hook: flush due queues for all sites and publish due syndication periods |

Example:

```bash
curl -X POST localhost:3000/api/sites -H 'content-type: application/json' \
  -d '{"url":"example.com","targetKeywords":["organik zeytinyağı"]}'
```

## AI distribution engine

The modern replacement for "URL submitters". AI answer engines ground their answers on live web
indexes (ChatGPT search → Bing, Gemini → Google, Perplexity → own crawler + Bing), so the engine makes
sure those indexes learn about changes fast and that crawlers and agents can read the site cheaply.
It does **not** push content into model training; no public API offers that.

**Change queue.** After each completed crawl (or `POST …/distribution/sync`) every indexable page gets
a fingerprint (status, title, meta description, H1, canonical, word count, text excerpt, and the
price / currency / availability of products on the page). New pages are queued as `created`, changed
fingerprints as `updated`, and previously announced URLs that now return 404/410 as `deleted`.
Noindex pages, pages whose canonical points elsewhere and URLs on other hosts are skipped. CMSs can
also push changes directly with `POST …/distribution/queue`. There is one row per URL and channel,
so five edits before the next dispatch produce one notification. Dispatch claims rows first, so
overlapping runs never send a URL twice. Retryable errors (429, 5xx, network, 403 while the key file
propagates) back off exponentially, from 1 minute up to 6 hours, for 6 attempts. 400/422 fail
immediately. A missing key or credential defers the rows without using up attempts. Use
`mode: "baseline"` when onboarding a site that is already indexed: it records fingerprints without
notifying.

**Channels**

| Channel | What it does | Setup |
| --- | --- | --- |
| IndexNow (default on) | One POST to `api.indexnow.org` notifies Bing, Yandex, Seznam, Naver and other participating engines, in batches of up to 10,000 URLs. This is a crawl hint, not a guarantee of inclusion. | `POST …/indexnow-key`, upload the key file to the site root (or set `indexnow.keyLocation`), then `…/verify` |
| Google Search Console | After URLs are sent, re-submits the configured sitemaps (`sitemaps.submit`), at most once an hour. Google retired the anonymous sitemap ping in 2023. | Service account added as an **Owner** of the property. Set `channels.googleSearchConsole`, `google.property` and `google.sitemaps` |
| Google Indexing API (opt-in) | `urlNotifications.publish` per URL (`URL_UPDATED` / `URL_DELETED`), limited by `google.indexingDailyQuota` (default 200 per day). Google only supports it officially for JobPosting / BroadcastEvent pages. | Same service account; set `channels.googleIndexingApi: true` |

Credentials are stored in site `integrations`, which the API always returns masked:
`indexnowKey`, `googleServiceAccount` (the JSON key as a string) and `webhookSecret`.
Single-site deployments can use the `INDEXNOW_KEY` and `GOOGLE_SERVICE_ACCOUNT_JSON` /
`GOOGLE_SERVICE_ACCOUNT_FILE` env vars instead.

**AI-readable files.** Generated from crawl data and the knowledge graph. They are meant to be served
from the site's root, either by a reverse proxy or a build step that copies them there.

- `llms.txt` follows [llmstxt.org](https://llmstxt.org). It contains an H1 name, a summary blockquote
  and key facts. Products are grouped by category, largest first, and each line shows price,
  availability, brand and a short description. Then come key pages, articles, the FAQ, a list of
  machine-readable resources (plus your own `llms.apiEndpoints`) and an `## Optional` section. Limits
  are set with `llms.maxProducts`, `maxPages` and `maxFaqs`.
- `llms-full.txt` has the same structure with product facts, FAQ answers and page text inlined, so
  an agent can answer from a single fetch.
- `sitemap-ai.xml` lists only indexable 2xx pages and product URLs. Priority combines page type and
  internal PageRank, and entries are sorted most important first.
- The feeds (`ai-feed.xml`, `ai-feed.atom`, `ai-feed.json`) carry a rotating selection of products and
  articles with schema.org `Product` / `Offer` / `Article` JSON-LD. Each `daily` or `weekly` period
  (weeks start Monday, UTC) gets a seeded, deterministic pick of `syndication.itemsPerPeriod` items,
  after any `pinnedKeys`. The feed stays stable within a period and rotates through the whole catalog
  over time.

**Webhooks.** `syndication.webhooks: [{ url, format: "json" | "markdown" }]` receive
`{ event: "syndication.published", site, period, feed, markdown? }` once per period. When
`webhookSecret` is set, requests carry
`X-AIV-Signature: sha256=HMAC_SHA256(secret, "<X-AIV-Timestamp>.<raw body>")`. Webhook and key-file
targets that resolve to loopback or private networks are refused unless
`ALLOW_PRIVATE_NETWORK_TARGETS=true`.

```bash
SITE=…  # site id
curl -X POST localhost:3000/api/sites/$SITE/distribution/indexnow-key
curl -X PATCH localhost:3000/api/sites/$SITE/distribution -H 'content-type: application/json' \
  -d '{"syndication":{"frequency":"daily","webhooks":[{"url":"https://hooks.example.com/ai"}]}}'
curl -X POST localhost:3000/api/sites/$SITE/distribution/queue -H 'content-type: application/json' \
  -d '{"urls":["https://example.com/product/123"]}'
curl -X POST localhost:3000/api/sites/$SITE/distribution/dispatch
curl localhost:3000/api/sites/$SITE/ai/llms.txt
```

Schedule `POST /api/distribution/run` (every 5–15 minutes is enough) to flush retries and publish
syndication.

## Configuration

See `.env.example`: database URL, LLM keys (OpenAI, Gemini, Anthropic, Perplexity), IndexNow key/endpoint,
Google service account, crawler user agent/limits, SMTP for reports, optional `API_TOKEN`.
