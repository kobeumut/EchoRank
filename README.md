# AI Visibility — GEO & SEO Platform

A comprehensive Generative Engine Optimization (GEO) & SEO tracking, scoring, and knowledge-graph platform. It monitors how websites appear in AI answer engines (ChatGPT, Google Gemini, Anthropic Claude, Perplexity), analyzes E-E-A-T credibility, constructs an entity-relationship knowledge graph, and automates instant search indexation and distribution.

## Key Features

- **Multi-LLM Citation & Visibility Tracking**: Automated benchmarking across ChatGPT, Gemini, Claude, and Perplexity.
- **Knowledge Graph & Graphify Engine**: Extracts entities (Products, Categories, FAQs, Authors) and semantic relationships into a queryable graph.
- **Four-Pillar GEO Scoring**:
  1. *AI Bot Accessibility* (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`).
  2. *Semantic & Direct Answer Readability*.
  3. *Information Trust & E-E-A-T* (Author credibility, citation density, verifiable facts).
  4. *Schema.org JSON-LD Completeness*.
- **Modern AI Submitter & Feeder**: IndexNow protocol for real-time Bing/ChatGPT indexing, dynamic `llms.txt` generation, and structured product syndication.
- **Actionable Remediation Engine**: Prioritized, copy-pasteable schema and configuration recommendations.
- **Scheduled Audits & Reporting**: Daily and weekly automated audits with trend reports.

---

## Architecture & Services

The platform is structured as a unified monorepo:

```
ai-visibility/
├── src/                     # Full-stack Next.js 16 core platform & API
│   ├── app/                 # App Router pages and REST API handlers
│   │   ├── api/sites/       # Site management, audits, graph, distribution & reports
│   │   ├── api/distribution/# Background cron and distribution execution
│   │   └── api/health/      # System health endpoint
│   ├── lib/
│   │   ├── services/        # Domain services (audit, graph, sites, reports)
│   │   ├── distribution/    # AI distribution engine (IndexNow, Google, llms.txt, feeds)
│   │   ├── db.ts            # Prisma client singleton
│   │   └── validation.ts    # Zod request validators
│   ├── components/dashboard/ # Client UI: site shell, overview, actions, graph, visibility, distribution
│   ├── lib/dashboard/       # Pure UI helpers (score bands, highlight, competitors, competitor intel, graph issues)
│   └── proxy.ts             # API token / dashboard session guard
├── prisma/                  # Database schema & migrations (SQLite/PostgreSQL)
├── services/
│   └── crawler/             # Python 3.10+ async crawler & Knowledge Graph engine
│       ├── src/geo_crawler/ # Crawler, parser, entity extractor, graphify
│       └── tests/           # Unit & integration test suite (respx)
└── tests/                   # Vitest API test suite
```

---

## Tech Stack

- **Core Web & API**: Next.js 16 (App Router, Turbopack), TypeScript, Tailwind CSS 4, `d3-force` (graph layout).
- **ORM & Database**: Prisma 6 (SQLite for development, PostgreSQL for production).
- **Validation & Testing**: Zod 4, Vitest.
- **Crawler & Graph Engine** (`services/crawler`): Python 3.10+, HTTPX (async), BeautifulSoup4, lxml, NetworkX.

---

## Quick Start

### 1. Web Application & API

```bash
# Install dependencies and generate Prisma client
npm install

# Copy environment variables template
cp .env.example .env

# Run migrations and seed demo data
npm run db:migrate

# Start development server
npm run dev
# -> http://localhost:3000

# Run API tests
npm test

# Build for production
npm run build
```

Use `npm run db:seed` to reseed the demo site and `npm run db:studio` to browse data.

#### PostgreSQL Setup

Set `provider = "postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL` at Postgres, and run `npx prisma migrate dev --name init`. The schema only uses portable types: enum-like fields are `String` columns validated in `src/lib/constants.ts`.

### 2. Crawler & Knowledge Graph Service

```bash
cd services/crawler

# Install package in editable mode with test dependencies
pip install -e '.[dev]'

# Run crawler tests
pytest -q

# Example CLI crawl command:
geo-crawler https://example.com -o graph.json --db-records records.json --depth 2 --max-pages 50 --rps 5 -v
```

---

## Dashboard (Web UI)

`npm run dev` → http://localhost:3000. The whole UI is Turkish and talks to the REST API below (no hidden server-only data paths), with skeleton loaders, empty states and inline error/retry everywhere. Light/dark theme follows the OS and can be toggled.

| Screen | Route | What it does |
| --- | --- | --- |
| Siteler | `/` | Site cards with GEO / SEO / E-E-A-T scores, open action count, add-site form ("Ekle ve Analiz Et" = create + one-click audit), search |
| Genel Bakış | `/sites/:id` | GEO score (grade, delta), AI bot accessibility checks, E-E-A-T checks, technical SEO, per-model visibility (ChatGPT / Gemini / Claude / Perplexity), score history, 4-pillar breakdown, top actions, audit history |
| Ne Yapılmalı? | `/sites/:id/actions` | Prioritized action cards (Kritik / Önemli / İyileştirme = impact high / medium / low), category filter, evidence, affected URLs, copy / download ready-made JSON-LD, robots.txt, `llms.txt` snippets; "Çözüldü Olarak İşaretle", "Yeniden Kontrol Et" (new audit verifies the fix — still-failing items reopen), dismiss / reopen |
| Bilgi Grafı | `/sites/:id/graph` | Interactive force-directed knowledge graph (canvas + `d3-force`): pan / zoom / drag, type filters, search, node details & relations; flags orphan pages, isolated nodes, schema-less pages, thin pages and uncategorized products, with an accessible table of problem nodes. Verified Wikidata entities carry a green **W** badge; the node panel shows the QID (→ wikidata.org) / Wikipedia link and opens a one-click Wikidata search & reconcile modal (`/entities/reconcile`); the enrichment table filters verified / pending / unmatched entities; the JSON-LD modal previews and copies the enriched `@graph` (`/jsonld`) |
| AI Bot Teşhis | `/sites/:id/bots` | Live AI crawler diagnostic center (`/simulation/bots`): status cards for GPTBot, ClaudeBot, PerplexityBot, Google-Extended (+ Applebot-Extended) — green 200 OK, red WAF/403 (with vendor), yellow JS shell — with average load time and token weight; one-click live test (optional URL list), bot-only blocks, CSR-shell pages, URL × bot matrix and a copy-paste allow-rule generator for Cloudflare WAF, nginx, Apache/.htaccess and robots.txt |
| LLM Görünürlük | `/sites/:id/visibility` | Runs bounded paid visibility checks (query × model), shows each model's answer with the site's name / domain / cited URLs highlighted, position, sources; competitor citation table |
| AI Dağıtım | `/sites/:id/distribution` | IndexNow key create / download / verify, channel toggles, queue counters, "IndexNow bildirimini tetikle" (dispatch), crawl sync, manual URL announce, submission history, live `llms.txt` / `llms-full.txt` preview with copy & download |

While an audit runs the site header polls `GET /api/sites/:id/audit` and refreshes every screen when it finishes.

### Authentication

When `API_TOKEN` is set, `/api/*` accepts either `Authorization: Bearer <API_TOKEN>` (machine clients) or the dashboard session cookie, and dashboard pages redirect to `/login`. `POST /api/auth { "token": "…" }` exchanges the token for an `HttpOnly; SameSite=Strict` cookie that holds a SHA-256 digest of the token (never the token itself); `DELETE /api/auth` logs out; `GET /api/auth` reports `{ required, authenticated }`. Cookie-authenticated unsafe requests must be same-origin (CSRF guard). Without `API_TOKEN` the dashboard is open, but paid visibility checks stay disabled.

---

## Data Model

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

---

## API Endpoints

All responses are formatted in JSON with standard HTTP status codes.

### Core Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | System and database health status |
| `GET/POST/DELETE` | `/api/auth` | Dashboard session: status / exchange `API_TOKEN` for a session cookie / log out |
| `GET` | `/api/sites` | List tracked sites with latest GEO audit summary |
| `POST` | `/api/sites` | Register a new site for tracking |
| `GET` | `/api/sites/:id` | Retrieve site details and configuration |
| `PATCH` | `/api/sites/:id` | Update site properties and integration credentials |
| `DELETE` | `/api/sites/:id` | Remove a site and cascade-delete associated audits |
| `POST` | `/api/sites/:id/audit` | Trigger an asynchronous GEO audit and crawl run |
| `GET` | `/api/sites/:id/audit` | Get recent audits and active crawl session progress |
| `GET` | `/api/sites/:id/graph` | Fetch knowledge graph nodes, edges, and semantic gaps |
| `GET/POST` | `/api/sites/:id/autogeo` | AutoGEO content metrics + persisted page suggestions; POST extracts suggestions ([usage](docs/autogeo.md), [API](docs/geo-api.md)) |
| `PATCH` | `/api/sites/:id/autogeo/:suggestionId` | Mark a suggestion `applied` / `dismissed` / `pending` |
| `GET` | `/api/sites/:id/competitors` | Share of Model vs configured competitors, citation gaps ([API](docs/geo-api.md)) |
| `GET/POST` | `/api/sites/:id/entities/reconcile` | Wikidata enrichments + verified `sameAs`; sync / verify / reject / requery |
| `GET/POST` | `/api/sites/:id/simulation/bots` | Persisted per-run bot probe records (WAF block, CSR shell, token estimate); see [geo-api](docs/geo-api.md) |
| `GET/POST` | `/api/sites/:id/bot-simulator` | Full AI crawler diagnosis: bot-vs-browser parity, WAF vendor, CSR shell, token weight + ready-made Cloudflare/nginx/Apache/AWS allow rules ([usage](docs/bot-simulator.md)) |
| `GET/POST` | `/api/sites/:id/queries/synthetic` | GEO-bench style multi-intent TR/EN test prompts |
| `GET/POST` | `/api/sites/:id/visibility` | Query suggestions/history and bounded multi-model visibility checks ([usage](docs/visibility.md)) |
| `GET` | `/api/sites/:id/queries` | Multi-intent synthetic test prompts (TR/EN) with intent, difficulty and volume labels ([details](docs/query-generator.md)) |
| `GET` | `/api/sites/:id/reports` | Get score trends, LLM visibility metrics, and action items |
| `GET/POST`| `/api/sites/:id/reports/schedules` | Manage daily and weekly automated report schedules |

### AI Distribution Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/sites/:id/distribution` | Settings, channel readiness, queue counters, last 20 submissions |
| `PATCH` | `/api/sites/:id/distribution` | Partial settings update (nested objects are merged) |
| `GET/POST` | `/api/sites/:id/distribution/indexnow-key` | Show / create the IndexNow key (`{ "rotate": true }` replaces it). `?format=txt` downloads the key file |
| `POST` | `/api/sites/:id/distribution/indexnow-key/verify` | Fetch the published key file from the site and check it |
| `GET` | `/api/sites/:id/distribution/queue?status=&channel=&limit=` | Queue rows |
| `POST` | `/api/sites/:id/distribution/queue` | Announce URLs now `{ urls, reason?: "created"\|"updated"\|"deleted", channels? }` → 202 (CMS hook) |
| `POST` | `/api/sites/:id/distribution/sync` | Diff the latest crawl against the queue `{ mode?: "notify"\|"baseline" }` |
| `POST` | `/api/sites/:id/distribution/dispatch` | Send due queue rows now |
| `GET/POST` | `/api/sites/:id/distribution/syndicate` | Preview / push this period's rotation to webhooks `{ force? }` |
| `GET` | `/api/sites/:id/ai/llms.txt`, `llms-full.txt` | Generated `llms.txt` files (Markdown) |
| `GET` | `/api/sites/:id/ai/sitemap-ai.xml` | Prioritized sitemap of indexable URLs |
| `GET` | `/api/sites/:id/ai/ai-feed.xml`, `ai-feed.atom`, `ai-feed.json` | RSS 2.0 / Atom / JSON Feed 1.1 of the current rotation |
| `POST` | `/api/distribution/run` | Cron hook: flush due queues for all sites and publish due syndication periods |

---

## AI Distribution Engine

The modern replacement for legacy "URL submitters". AI answer engines ground their answers on live web indexes (ChatGPT search → Bing, Gemini → Google, Perplexity → own crawler + Bing), so the engine ensures those indexes learn about updates rapidly.

- **Change Queue**: After each completed crawl (or `POST …/distribution/sync`) every indexable page gets a fingerprint. New pages are queued as `created`, changed fingerprints as `updated`, and removed pages as `deleted`.
- **IndexNow Channel**: Notifies Bing, Yandex, Seznam, Naver, and other participating engines in batches of up to 10,000 URLs.
- **Google Search Console Channel**: Automatically re-submits configured sitemaps via Google Search Console API.
- **Google Indexing API Channel**: Optional direct notification for immediate URL indexing.
- **`llms.txt` & Feeds**: Publishes standard `/llms.txt`, `/llms-full.txt`, `/sitemap-ai.xml`, and rotating JSON/Atom feeds for AI crawlers.

---

## Configuration

Refer to `.env.example` for all configurable environment variables:
- `DATABASE_URL`: SQLite or PostgreSQL connection string.
- `API_TOKEN`: Bearer token for securing API endpoints; mandatory for paid visibility POST requests, optional elsewhere.
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`: Multi-model visibility testing keys.
- `INDEXNOW_KEY`, `INDEXNOW_HOST`: Instant Bing / ChatGPT search indexation configuration.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`: Google Search Console & Indexing API credentials.
- `SMTP_*`: Notification and scheduled report delivery settings.

---

## License & Attribution

This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)**.

### Author & Attribution
- **Original Author**: Umut ADALI ([@kobeumut](https://github.com/kobeumut))
- **Source Repository**: [https://github.com/kobeumut/ai-visibility](https://github.com/kobeumut/ai-visibility)

### Terms:
1. **Attribution (BY)**: Any fork, redistribution, or modification of this software must clearly credit **Umut ADALI** as the original creator and provide a direct link to the original repository.
2. **Non-Commercial (NC)**: You may **not** sell, sublicense, or distribute this software or derivative works for commercial advantage or monetary compensation.
3. **Share-Alike (SA)**: If you modify, transform, or build upon this codebase, you must distribute your contributions under the identical CC BY-NC-SA 4.0 license.
4. **Disclaimer of Liability**: This software is provided "AS IS", without warranty of any kind, express or implied. In no event shall the author or copyright holder (**Umut ADALI**) be liable for any claim, damages, or other liability arising from the use of or inability to use this software.
