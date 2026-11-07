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
| `PlatformSubmission` | Log of URL/content pushes (IndexNow, AI platforms) |

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

Example:

```bash
curl -X POST localhost:3000/api/sites -H 'content-type: application/json' \
  -d '{"url":"example.com","targetKeywords":["organik zeytinyağı"]}'
```

## Configuration

See `.env.example`: database URL, LLM keys (OpenAI, Gemini, Anthropic, Perplexity), IndexNow key/endpoint,
crawler user agent/limits, SMTP for reports, optional `API_TOKEN`.
