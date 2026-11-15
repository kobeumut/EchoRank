# AI Visibility — GEO & SEO Platform

AI Visibility is a self-hosted platform for **Generative Engine Optimization (GEO)** and SEO. It measures how a website
appears in AI answer engines (ChatGPT, Google Gemini, Anthropic Claude, Perplexity), scores how well the site can be
crawled, understood and trusted by those engines, builds an entity knowledge graph from the crawl, and tells you
exactly what to fix. It also notifies search indexes (IndexNow, Google) and publishes `llms.txt` and feeds so that
updates reach AI crawlers quickly.

The project is a monorepo: a Next.js 16 application (dashboard + REST API + database) and a Python crawler / scoring
engine (`services/crawler`) that the web app can run for every audit.

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Dashboard](#dashboard)
- [API overview](#api-overview)
- [AI distribution engine](#ai-distribution-engine)
- [Scheduled reports](#scheduled-reports)
- [Data model](#data-model)
- [Internationalization](#internationalization)
- [Development](#development)
- [Documentation](#documentation)
- [Contributing, security and license](#contributing-security-and-license)

---

## Features

- **Multi-LLM visibility tracking.** Runs bounded, cached query checks against ChatGPT, Gemini, Claude and Perplexity
  through their search-enabled APIs and records citations, mentions, positions and competing sources.
- **Four-pillar GEO scoring** (0-100) with prioritized, copy-paste fixes:
  1. *AI crawler access*: robots.txt rules per AI bot (RFC 9309), WAF/CDN user-agent probes, render mode (SSR vs. client-side shell).
  2. *LLM readability*: FAQ and direct-answer blocks, information density, Schema.org coverage, `llms.txt`.
  3. *Trust and E-E-A-T*: authors, authority signals, HTTPS/HSTS, contact and policy pages, factual consistency.
  4. *Technical SEO*: titles, meta tags, canonicals, broken URLs, thin content, internal links.
- **AutoGEO content engine.** Scores page content on six metrics (statistics, quotations, citations, answer capsules,
  authority/fluency, keyword stuffing) and proposes block-level Markdown/HTML rewrites as diffs.
- **Live AI crawler simulator.** Fetches your pages as GPTBot, ClaudeBot, PerplexityBot and others, detects WAF
  challenges, silent blocks and empty client-side shells, and generates Cloudflare / nginx / Apache / AWS WAF allow rules.
- **Knowledge graph.** Extracts products, brands, categories, FAQs, authors and organizations into a queryable graph,
  detects structural gaps and reconciles entities with Wikidata to produce a valid Schema.org JSON-LD `@graph`.
- **Competitor intelligence.** Share of Model against configured competitors, citation gaps, sentiment and brand-safety evidence.
- **AI distribution.** IndexNow, Google Search Console / Indexing API, `llms.txt`, `llms-full.txt`, AI sitemap and
  RSS / Atom / JSON feeds, driven by a change queue.
- **Scheduled reports.** Daily and weekly reports (HTML / PDF / JSON) delivered by e-mail or webhook.
- **English and Turkish UI**, with English as the default and fallback ([details](#internationalization)).

---

## Architecture

```
                 ┌─────────────────────────────────────────────────────────┐
 Browser ──────► │ Next.js 16 app (src/)                                   │
 API clients ──► │  dashboard (App Router)  ·  REST API (/api/*)           │
                 │  services: audit, graph, visibility, distribution, ...  │
                 └───────┬───────────────────────────┬─────────────────────┘
                         │ Prisma                    │ execFile (GEO_AUDIT_BIN)
                         ▼                           ▼
              SQLite (dev) / PostgreSQL     Python engine (services/crawler)
                                            crawl → graph → score → AutoGEO → bot simulation
                                                         │
                         LLM provider APIs · IndexNow · Google · Wikidata · your site
```

An audit is a crawl plus scoring run. When `GEO_AUDIT_BIN` points at the `geo-audit` executable, `POST /api/sites/:id/audit`
runs it in-process and stores the result. Without it, audits stay `queued` and an external worker can post results
to `/api/sites/:id/audit/:auditId/result` (see [`docs/geo-scoring.md`](docs/geo-scoring.md)).

### Project layout

```
ai-visibility/
├── src/
│   ├── app/                   # App Router pages and REST API route handlers (src/app/api)
│   ├── components/dashboard/  # Client UI: site shell, overview, actions, studio, graph, bots, visibility, distribution
│   ├── lib/
│   │   ├── services/          # Domain services (audit, graph, visibility, competitors, wikidata, autogeo, ...)
│   │   ├── distribution/      # AI distribution engine (IndexNow, Google, llms.txt, feeds, queue)
│   │   ├── reports/           # Scheduled report snapshots, rendering (HTML/PDF), delivery
│   │   ├── dashboard/         # Pure UI helpers (score bands, diffing, competitor intel, graph insights)
│   │   ├── i18n/              # Locale config, translator, en/tr message catalogs
│   │   ├── text/turkish.ts    # Turkish morphology helpers (language data, deliberately Turkish)
│   │   ├── validation.ts      # Zod request validators
│   │   └── db.ts              # Prisma client singleton
│   └── proxy.ts               # API token / dashboard session guard
├── locales/                   # Canonical single source of truth for all translations (locales/{en,tr}/*.json)
├── prisma/                    # Schema, SQLite migrations, demo seed
├── scripts/                   # Report worker and sample report renderer
├── services/crawler/          # Python 3.10+ crawler, graph, scoring and simulation engine (geo-crawler package)
│   ├── src/geo_crawler/       # crawler, parser, extractor, graph, scoring/ (consumes shared root locales/)
│   └── tests/                 # pytest suite (respx-mocked HTTP)
├── tests/                     # Vitest suite (API, services, i18n parity)
└── docs/                      # Feature and API documentation
```

### Tech stack

- **Web and API:** Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 4, `d3-force`, Zod 4.
- **Data:** Prisma 6 with SQLite for development and PostgreSQL for production.
- **Crawler and scoring engine:** Python 3.10+, HTTPX (async), BeautifulSoup4, lxml, NetworkX.
- **Tests:** Vitest (web), pytest + respx (Python).

---

## Quick start

### Prerequisites

- Node.js 22 or newer (the report scripts use `node --env-file-if-exists`) and npm
- Python 3.10 or newer (only for the crawler / audit engine)

### 1. Web application and API

```bash
npm ci                       # installs dependencies and runs `prisma generate`
cp .env.example .env         # review the values, see "Configuration"
npm run db:migrate           # creates prisma/dev.db (SQLite), applies migrations and, on a fresh database, loads the demo data
npm run dev                  # http://localhost:3000
```

Useful scripts: `npm run db:seed` (re-create the demo site: graph, audits, visibility checks and actions),
`npm run db:studio` (browse the database), `npm run build && npm start` (production build),
`npm test` (Vitest), `npm run lint`, `npm run typecheck`.

### 2. Crawler and scoring engine (optional but recommended)

```bash
cd services/crawler
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'     # add the `tokens` extra for exact token counts: '.[dev,tokens]'
.venv/bin/python -m pytest -q

# Crawl a site and export its knowledge graph
.venv/bin/geo-crawler https://example.com -o graph.json --db-records records.json --depth 2 --max-pages 50 --rps 5 -v

# Full GEO audit with a human-readable report on stderr
.venv/bin/geo-audit https://example.com -o audit.json --text --code
```

To let the web app run audits itself, set `GEO_AUDIT_BIN=services/crawler/.venv/bin/geo-audit` in `.env` (relative paths
resolve against the directory the server was started in) and restart the dev server.
All CLIs are documented in [`services/crawler/README.md`](services/crawler/README.md).

### 3. First audit

1. Open http://localhost:3000, add a site (for example `https://example.com`) and click **Add and audit**.
2. Wait for the audit to finish. The header polls `GET /api/sites/:id/audit` and refreshes every screen when it completes.
3. Open **What to Do?** for the prioritized fix list, and **AI Bot Diagnostics** to test live AI crawler access.

Or use the API (`$API_TOKEN` only if you configured one):

```bash
curl -X POST localhost:3000/api/sites -H 'content-type: application/json' -H "Authorization: Bearer $API_TOKEN" \
  -d '{"url":"https://example.com"}'
curl -X POST localhost:3000/api/sites/$SITE_ID/audit -H "Authorization: Bearer $API_TOKEN"
```

### PostgreSQL

The committed migrations are SQLite SQL. For PostgreSQL, set `provider = "postgresql"` in `prisma/schema.prisma`, point
`DATABASE_URL` at your database, remove `prisma/migrations/` (including `migration_lock.toml`) in your deployment fork and
create a fresh baseline with `npx prisma migrate dev --name init`. The schema only uses portable types: enum-like fields are
`String` columns validated in `src/lib/constants.ts`.

---

## Configuration

Copy `.env.example` to `.env`. Next.js loads it automatically; the `reports:*` scripts load it with
`node --env-file-if-exists=.env`. Never commit `.env` (it is git-ignored).

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db` | SQLite file (relative to `prisma/schema.prisma`) or a PostgreSQL URL |
| `API_TOKEN` | empty | When set, `/api/*` requires `Authorization: Bearer <API_TOKEN>` (or a dashboard session) and pages redirect to `/login`. Required for paid visibility checks and scheduled reports. Generate with `openssl rand -hex 32` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | empty | ChatGPT visibility checks (OpenAI Responses API with `web_search`). Both key and model must be set |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | empty | Gemini visibility checks (`google_search` grounding) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | empty | Claude visibility checks (`web_search` tool) |
| `PERPLEXITY_API_KEY`, `PERPLEXITY_MODEL` | empty / `sonar` | Perplexity visibility checks |
| `INDEXNOW_KEY` | empty | Fallback IndexNow key for single-site deployments (per-site keys are generated through the API) |
| `INDEXNOW_ENDPOINT` | `https://api.indexnow.org/indexnow` | IndexNow endpoint |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SERVICE_ACCOUNT_FILE` | empty | Google Search Console / Indexing API service account (JSON content or key file path), used when a site has no `googleServiceAccount` integration |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `false` | Disables the SSRF guard: lets site URLs, the crawler / simulators, webhooks and IndexNow checks reach localhost and private networks. Development only. Scheduled-report webhooks always require public addresses |
| `SESSION_SECRET` | empty | Optional extra secret for signing dashboard session cookies. Generate with `openssl rand -hex 32` |
| `GEO_AUDIT_BIN` | empty | Path to the `geo-audit` executable. Empty: audits stay `queued` for an external worker |
| `GEO_AUDIT_ARGS` | empty | Extra flags for `geo-audit`, split on whitespace (for example `--rps 2 --no-ua-probe`) |
| `CRAWLER_MAX_PAGES` | `500` | Default page cap for audits whose site settings do not set `maxPages` |
| `RESEND_API_KEY`, `REPORT_FROM_EMAIL` | empty | E-mail delivery of scheduled reports through [Resend](https://resend.com) |
| `CRUNCHBASE_API_KEY` | empty | Optional Crunchbase fallback for Wikidata reconciliation (read by the Python engine) |
| `CRAWLER_USER_AGENT`, `CRAWLER_CONCURRENCY`, `SMTP_*` | | Reserved: present in `.env.example` but not read by the current code |

Per-site integration secrets (IndexNow key, Google service account, webhook secret) are stored in the database
(`Site.integrations`) and masked in API output. See [`SECURITY.md`](SECURITY.md) before deploying.

---

## Authentication

Without `API_TOKEN` the API and dashboard are open, which is suitable for local development only. Paid operations
(`POST /api/sites/:id/visibility`) and the scheduled-report endpoints stay disabled (HTTP 503) until a token is configured.

When `API_TOKEN` is set:

- `/api/*` accepts `Authorization: Bearer <API_TOKEN>` (machine clients) or the dashboard session cookie. `/api/health` and
  `/api/auth` are public. Dashboard pages redirect to `/login`.
- `POST /api/auth {"token": "..."}` exchanges the token for an `HttpOnly; SameSite=Strict` cookie (`aiv_session`, 7 days)
  that carries an expiry and an HMAC signature, never the token itself (optionally keyed with `SESSION_SECRET`; repeated wrong tokens
  are rate-limited). `DELETE /api/auth` logs out and
  `GET /api/auth` reports `{ required, authenticated }`.
- Cookie-authenticated unsafe requests must be same-origin (CSRF guard). The scheduled-report endpoints require the bearer
  header and ignore the cookie.

This is a shared-token, single-tenant design: there are no per-user accounts or roles.

---

## Dashboard

`npm run dev` serves the dashboard at http://localhost:3000. It talks to the REST API below (there are no hidden
server-only data paths) and provides loading skeletons, empty states and inline error / retry. The light or dark theme
follows the OS and can be toggled; the language switcher in the header selects English or Turkish.

| Screen | Route | What it does |
| --- | --- | --- |
| Sites | `/` | Site cards with GEO / SEO / E-E-A-T scores and open action counts, search, and an add-site form ("Add and audit" creates the site and starts an audit) |
| Overview | `/sites/:id` | GEO score (grade, delta), AI bot accessibility, E-E-A-T and technical SEO checks, per-model visibility, score history, 4-pillar breakdown, top actions, audit history |
| What to Do? | `/sites/:id/actions` | Prioritized action cards (Critical / Important / Improvement = impact high / medium / low), category filter, evidence, affected URLs, copy / download of ready-made JSON-LD, robots.txt and `llms.txt` snippets. "Mark as Resolved" and "Re-check" (a new audit verifies the fix; still-failing items reopen), dismiss / reopen |
| Content Studio | `/sites/:id/studio` | AutoGEO workspace: side-by-side diffs, answer capsules, tables, GEO score predictor, filters, "Apply to CMS" webhook ([details](docs/autogeo.md)) |
| Knowledge Graph | `/sites/:id/graph` | Interactive force-directed graph (canvas + `d3-force`) with filters, search and node details; flags orphan pages, isolated nodes, schema-less and thin pages. Verified Wikidata entities carry a **W** badge, and a search / reconcile modal and a JSON-LD `@graph` preview are built in |
| AI Bot Diagnostics | `/sites/:id/bots` | Live AI crawler diagnostic center ([details](docs/bot-simulator.md)): status per bot (OK, WAF block with vendor, JS shell), load time, token weight, URL x bot matrix and a copy-paste allow-rule generator |
| LLM Visibility | `/sites/:id/visibility` | Runs bounded paid visibility checks (query x model) and shows each answer with the site's name, domain and cited URLs highlighted ([details](docs/visibility.md)) |
| Share of Model & Competitors | `/sites/:id/competitors` | Share of Model against configured competitors, citation gaps, trend and brand safety ([details](docs/geo-api.md)) |
| AI Distribution | `/sites/:id/distribution` | IndexNow key management, channel toggles, queue counters, dispatch / sync / manual announce, submission history and live `llms.txt` preview |

---

## API overview

All routes live under `/api` and answer JSON unless noted. Validation errors use the shared shape
`{ "error": "...", "details"?: ... }` with `400` (validation), `401`, `404`, `409` (conflict) and `5xx`.
Route details and payloads: [`docs/geo-api.md`](docs/geo-api.md), [`docs/geo-scoring.md`](docs/geo-scoring.md) and the other pages under [`docs/`](docs).

### Core

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Service and database health |
| `GET` `POST` `DELETE` | `/api/auth` | Session status / exchange `API_TOKEN` for a cookie / log out |
| `GET` `POST` | `/api/sites` | List tracked sites with their latest audit summary / register a site |
| `GET` `PATCH` `DELETE` | `/api/sites/:id` | Site details / update settings and integrations / delete with all related data |
| `GET` `POST` | `/api/sites/:id/audit` | Recent audits and crawl progress / queue a crawl + audit (`202`) |
| `POST` | `/api/sites/:id/audit/:auditId/result` | Ingest scoring output from an external worker |
| `GET` | `/api/sites/:id/actions` | Prioritized action cards (`?status=&category=&impact=&limit=`) |
| `PATCH` | `/api/sites/:id/actions/:actionId` | Set status `open` / `in_progress` / `resolved` / `dismissed` |
| `GET` | `/api/sites/:id/graph` | Knowledge-graph nodes, edges and gaps |
| `GET` | `/api/sites/:id/jsonld` | Site-wide Schema.org `@graph` and a paste-ready `<script>` tag |
| `GET` | `/api/sites/:id/reports` | Score trends, visibility metrics and action metrics (`?days=30`) |

### GEO analysis

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` `POST` | `/api/sites/:id/visibility` | Query suggestions and history / bounded multi-model visibility checks ([usage](docs/visibility.md)) |
| `GET` | `/api/sites/:id/queries` | Generated multi-intent test prompts ([details](docs/query-generator.md)) |
| `GET` `POST` | `/api/sites/:id/queries/synthetic` | Stored test prompts: generate, add manually, archive |
| `GET` `POST` | `/api/sites/:id/autogeo` | AutoGEO metrics and persisted suggestions / extract suggestions ([usage](docs/autogeo.md)) |
| `PATCH` | `/api/sites/:id/autogeo/:suggestionId` | Mark a suggestion `applied` / `dismissed` / `pending` |
| `POST` | `/api/sites/:id/autogeo/:suggestionId/apply` | Send the suggestion to the site's webhooks ("Apply to CMS") |
| `GET` | `/api/sites/:id/competitors` | Share of Model, citation gaps, trend, brand safety |
| `GET` `POST` | `/api/sites/:id/entities/reconcile` | Wikidata enrichments and verified `sameAs`: sync / verify / reject / requery |
| `GET` | `/api/sites/:id/reconciliation` | Wikidata review queue ([details](docs/wikidata.md)) |
| `POST` | `/api/sites/:id/reconciliation/:entityId` | Verify / reject / requery one entity |
| `GET` `POST` | `/api/sites/:id/bot-simulator` | Latest audit's AI crawler summary / run a live simulation now ([usage](docs/bot-simulator.md)) |
| `GET` `POST` | `/api/sites/:id/simulation/bots` | Persisted per-run bot probe records |

### Distribution and reports

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` `PATCH` | `/api/sites/:id/distribution` | Settings, channel readiness, queue counters, last submissions / partial settings update |
| `GET` `POST` | `/api/sites/:id/distribution/indexnow-key` | Show / create the IndexNow key (`{ "rotate": true }` replaces it, `?format=txt` downloads the key file) |
| `POST` | `/api/sites/:id/distribution/indexnow-key/verify` | Fetch the published key file from the site and check it |
| `GET` `POST` | `/api/sites/:id/distribution/queue` | Queue rows (`?status=&channel=&limit=`) / announce URLs now `{ urls, reason?, channels? }` (`202`, CMS hook) |
| `POST` | `/api/sites/:id/distribution/sync` | Diff the latest crawl against the queue `{ mode?: "notify" \| "baseline" }` |
| `POST` | `/api/sites/:id/distribution/dispatch` | Send due queue rows now |
| `GET` `POST` | `/api/sites/:id/distribution/syndicate` | Preview / push this period's rotation to webhooks `{ force? }` |
| `GET` | `/api/sites/:id/ai/llms.txt`, `llms-full.txt` | Generated `llms.txt` files (Markdown) |
| `GET` | `/api/sites/:id/ai/sitemap-ai.xml` | Prioritized sitemap of indexable URLs |
| `GET` | `/api/sites/:id/ai/ai-feed.xml`, `ai-feed.atom`, `ai-feed.json` | RSS 2.0 / Atom / JSON Feed 1.1 of the current rotation |
| `POST` | `/api/distribution/run` | Cron hook: flush due queues for all sites and publish due syndication periods |
| `GET` `POST` | `/api/sites/:id/reports/schedules` | List / create daily or weekly report schedules (bearer `API_TOKEN` required) |
| `PATCH` | `/api/sites/:id/reports/schedules/:scheduleId` | Enable or disable a schedule |
| `GET` | `/api/sites/:id/reports/runs`, `.../runs/:runId` | Report run history / one run (`?format=json\|html\|pdf`) |

---

## AI distribution engine

AI answer engines ground their answers on live web indexes (ChatGPT search on Bing, Gemini on Google, Perplexity on its
own crawler plus Bing), so the engine makes sure those indexes learn about changes quickly.

- **Change queue.** After each completed crawl (or `POST .../distribution/sync`) every indexable page gets a content
  fingerprint. New pages are queued as `created`, changed fingerprints as `updated` and removed pages as `deleted`.
- **IndexNow.** Notifies Bing, Yandex, Seznam, Naver and other participating engines in batches of up to 10,000 URLs.
- **Google Search Console.** Re-submits configured sitemaps through the Search Console API.
- **Google Indexing API.** Optional direct URL notifications.
- **`llms.txt` and feeds.** Generates `llms.txt`, `llms-full.txt`, `sitemap-ai.xml` and rotating RSS / Atom / JSON feeds
  that you serve from your own site (the endpoints above return the content).
- **Webhook syndication.** Pushes each period's rotation, and applied AutoGEO suggestions, to signed webhooks
  (`x-aiv-signature` HMAC-SHA256).

Call `POST /api/distribution/run` from cron to flush queues and publish due periods.

---

## Scheduled reports

Create a schedule with `POST /api/sites/:id/reports/schedules` (`{ "frequency": "daily" | "weekly", "recipients": [...], "webhookUrl"?: "https://..." }`,
bearer `API_TOKEN` required). A separate foreground worker executes due schedules; it never runs inside the Next.js server:

```bash
npm run reports:worker    # long-running worker, checks every minute (UTC)
npm run reports:run       # run all due schedules once and exit
npm run reports:sample    # render a synthetic sample report to artifacts/ (HTML and PDF)
```

Weekly runs also start an audit when `GEO_AUDIT_BIN` is configured. E-mail needs `RESEND_API_KEY` and `REPORT_FROM_EMAIL`;
webhook targets must resolve to public addresses. Each run stores an immutable snapshot that can be downloaded as JSON, HTML or PDF.

---

## Data model

| Model | Purpose |
| --- | --- |
| `Site` | Tracked site: normalized origin URL (unique), title, `settings`, `targetKeywords`, `integrations` (secrets, masked in API output) |
| `CrawlSession` | One crawl run: status, trigger, limits, pages crawled / failed, timings |
| `CrawledPage` | Latest technical snapshot per `(site, url)`: status, page type, title, meta, canonical, H1, word count, extracted data |
| `GraphEntity` | Knowledge-graph node, unique per `(site, key)` for idempotent upserts. Types are listed in `src/lib/constants.ts` (`Page`, `Product`, `Category`, `FAQ`, `Organization`, `Brand`, `Person`, `Article`, `Concept`, ...) |
| `GraphRelation` | Edge (`links_to`, `has_category`, `contains_product`, `written_by`, `mentions_entity`, `answers_question`, `same_as`, ...), unique per `(source, target, type)` |
| `GeoAudit` | GEO / SEO / E-E-A-T scores (0-100) plus detailed `metrics` |
| `ActionItem` | Recommendation: category (`crawler`, `schema`, `content`, `authority`, `technical`), impact, status, evidence, fix snippet |
| `LlmVisibilityRecord` | One AI engine check: model, query, `cited` / `mentioned` / `none`, position, excerpt |
| `AutoGeoSuggestion` | One block-level AutoGEO rewrite or insertion, with a user decision that survives re-runs |
| `CompetitorAnalysis` | Latest Share-of-Model snapshot per configured competitor |
| `EntityEnrichment` | Queryable mirror of Wikidata reconciliation results |
| `BotSimulationRecord` | One live fetch per URL x bot, grouped by run |
| `SyntheticQuery` | Stored test prompts with intent, language and difficulty |
| `ScheduledReport`, `ReportRun` | Report schedules and immutable run evidence with delivery outcomes |
| `PlatformSubmission` | Log of URL / content pushes (`indexnow`, `google_indexing`, `google_search_console`, `webhook`) with the remote response |
| `SubmissionQueueItem` | Outbound notification queue: one row per `(site, url, channel)` with change reason, fingerprint and retry state |

---

## Internationalization

The user interface, the text generated by audits and analyses, and reports are available in **English (`en`, default and fallback)** and
**Turkish (`tr`)**.

**Dashboard and API locale.** The locale is resolved per request, without changing URLs:

1. the `locale` cookie, which the language switcher in the header sets (EN / TR), then
2. the `Accept-Language` header, then
3. `en`.

API clients can also pass `?lang=en|tr` (or `?locale=`), which takes precedence over the cookie and the header. Programmatic
clients without any of these (cron jobs, `curl`) receive English. A message missing in the requested language falls back
to English.

**Generated content.** Text that the platform generates and stores (audit labels, findings and action cards, bot-simulator
diagnostics, AutoGEO suggestions, reports) is written in the language of the request that triggers it and stays in that
language afterwards: re-run the audit or analysis in the other language to regenerate it. Background jobs have no
request, so scheduled audits and reports use the site's language (`settings.locale`: `tr*` means Turkish, anything else
English), and each report snapshot records the `locale` it was written in. The web app passes the locale to the Python
engine with `--lang <locale>`; add `--lang` to `GEO_AUDIT_BIN` arguments (`GEO_AUDIT_ARGS`) to pin the engine language.
The Python CLIs that print localized text (`geo-audit`, `geo-autogeo`, `geo-botsim`) accept `--lang en|tr` (default `en`).
JSON field names, enum values and endpoint paths never change with the locale.

**Related, but different, language settings.** The site's own content language (`settings.locale`, for example `tr-TR`) decides
whether synthetic test prompts are generated in Turkish, English or both (`languages=tr,en`). Wikidata lookups take their own
search language (`--wikidata-lang` on `geo-audit`, `--lang` on `geo-crawler` and `geo-reconcile`, `lang` on the requery action).
These are independent of the UI locale.

**Turkish language data is intentional.** Some Turkish text in the repository is functional data and is not translated:
Turkish morphology (`src/lib/text/turkish.ts`), Turkish query-template variants, stop-word lists, and the patterns used to
recognize Turkish web content (privacy / returns / shipping pages), plus the Turkish sample content in tests that exercises
those paths. Each occurrence carries an English comment explaining why.

### How to add or edit a translation

All translations across the web application and Python engine live in **one single place**: `locales/{en,tr}/<namespace>.json`.

1. **Editing an existing message:** Locate the namespace file under `locales/en/<namespace>.json` and `locales/tr/<namespace>.json`. Update the string, preserving any `{name}` placeholders and plural suffix conventions (`_one` / `_other`).
2. **Adding a new message:** Add the key and its value to `locales/en/<namespace>.json` and the corresponding translated value to `locales/tr/<namespace>.json`. TypeScript derives `MessageKey` statically from the English catalogs, giving immediate compile-time type safety in `t("...")` calls, while Python loads the exact same JSON files dynamically.

### Adding a new language

1. **Create the locale directory.** Add `locales/<lang>/` containing the matching JSON namespace files (`actions.json`, `overview.json`, etc.).
2. **Web app.** Register the new locale in `src/lib/i18n/config.ts` (`LOCALES`, `LOCALE_NAMES`, `INTL_LOCALES`) and register its imports in `src/lib/i18n/messages/index.ts`.
3. **Python engine.** Discovers all locale folders in `locales/` automatically without code changes.
4. **Run the parity tests**, which verify key parity and placeholder alignment against the single source:

   ```bash
   npm test tests/i18n.test.ts
   cd services/crawler && pytest tests/test_i18n.py
   ```

### Stored content on language switch

- **UI & Dashboard:** Switching languages re-renders all static and dynamically looked-up labels, navigation items, filters, toasts, and action badges immediately.
- **Action items:** Recommendations store their rendered text in the generation locale as a baseline, but also include `ruleId` and `details.title_key` / `details.title_params` where feasible. When a translation key exists, the dashboard retranslates the card title dynamically into the active language on switch.
- **Reports & Historical Snapshots:** Report runs (`ReportRun` / `ReportSnapshot`) and audit evidence records are immutable point-in-time audit certificates. They store their prose in the generation locale to prevent template bit-rot or wording divergence across software versions.

Catalog conventions: flat dotted keys prefixed by the namespace (`"actions.empty.noOpen"`), `{name}` placeholders, plural
variants `key_one` / `key_other` selected by `count`. User-facing strings must never be hard-coded; see
[`CONTRIBUTING.md`](CONTRIBUTING.md#internationalization-rules).

---

## Development

```bash
npm test                  # Vitest: API, services and i18n parity (creates and removes prisma/test.db)
npm run lint              # ESLint
npm run typecheck         # tsc --noEmit (run `npx next typegen` once on a fresh clone)
npm run build             # production build

cd services/crawler && .venv/bin/python -m pytest -q   # Python tests (no network required)
```

Tests never call paid providers: HTTP is mocked and the database is a throw-away SQLite file.

## Documentation

| Page | Topic |
| --- | --- |
| [`docs/geo-scoring.md`](docs/geo-scoring.md) | How audit results reach the database and API; action item lifecycle |
| [`docs/geo-api.md`](docs/geo-api.md) | AutoGEO, competitors, entities, bot simulation and synthetic query endpoints |
| [`docs/visibility.md`](docs/visibility.md) | Multi-model visibility checks, providers, caching and cost bounds |
| [`docs/query-generator.md`](docs/query-generator.md) | Multi-intent synthetic prompt generation |
| [`docs/autogeo.md`](docs/autogeo.md) | AutoGEO content metrics, rewrites and Content Studio |
| [`docs/bot-simulator.md`](docs/bot-simulator.md) | Live AI crawler simulation, WAF and render diagnosis |
| [`docs/wikidata.md`](docs/wikidata.md) | Wikidata reconciliation and JSON-LD `@graph` |
| [`services/crawler/README.md`](services/crawler/README.md) | Python engine: CLIs, graph model, scoring pillars |

## Contributing, security and license

- Contributions are welcome: read [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md). Do not open public issues for them.

### License

This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License
(CC BY-NC-SA 4.0)**, as stated in [`LICENSE`](LICENSE). Note that it includes a **non-commercial clause**: you may not use the
material for commercial purposes, so check that your use case is permitted before adopting it.

- **Attribution (BY):** give appropriate credit to the original author, **Umut ADALI**
  ([@kobeumut](https://github.com/kobeumut)), link to the license and to the original repository
  (https://github.com/kobeumut/ai-visibility), and indicate if changes were made.
- **Non-commercial (NC):** you may not sell, rent, lease, license or sublicense the software or derivative works for
  monetary compensation or direct commercial advantage.
- **Share-alike (SA):** if you remix, transform or build upon the material, you must distribute your contributions under the same license.
- **No warranty:** the software is provided "as is"; see `LICENSE` for the full disclaimer.

`LICENSE` is the authoritative text.
