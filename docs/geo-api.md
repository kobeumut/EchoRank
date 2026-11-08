# GEO REST API (Stage 2)

Persisted data and endpoints for AutoGEO suggestions, competitor Share of Model, Wikidata entity enrichment,
live AI bot simulation and synthetic test prompts. All routes live under `/api/sites/:id/…`, validate input with
Zod and answer JSON. Errors use the shared shape `{ "error": "...", "details"?: ... }`: `400` validation,
`404` unknown site/row, `409` conflict, `422` unknown Wikidata item. When `API_TOKEN` is set, every route needs the
bearer token or a dashboard session (see `src/proxy.ts`).

| Model | Written by | Purpose |
| --- | --- | --- |
| `AutoGeoSuggestion` | audit ingestion, `POST /autogeo` | One block-level rewrite/insert per page; user decision survives re-runs |
| `CompetitorAnalysis` | `GET /competitors` | Latest SoM snapshot per configured competitor |
| `EntityEnrichment` | `GET/POST /entities/reconcile` | Queryable mirror of the reconciliation stored on `GraphEntity.properties` |
| `BotSimulationRecord` | `POST /simulation/bots` | One live fetch per URL × bot, grouped by `runId` |
| `SyntheticQuery` | `POST /queries/synthetic` | Test prompts with intent, language, difficulty |

## AutoGEO — `/autogeo`

- `GET ?status=pending,applied&ruleType=stats,quotes,citations,answer_capsule,tone,keyword_stuffing,comparison_table&pageUrl=&minGain=&sort=gain|recent&limit=&offset=`
  returns the previous contract (`auditId`, `completedAt`, `summary`, `items`) plus
  `suggestions { items, total, byStatus, pendingByRuleType }`. Default status filter: `pending,applied`.
- `POST {}` rebuilds suggestions from the open AutoGEO action items; `POST { "report": <crawler autogeo report> }`
  ingests a report directly. Audits that carry AutoGEO data store suggestions automatically.
- Idempotent: rows are keyed by a hash of page + rule type + both snippets. Pending suggestions of a re-analysed page
  that the new run no longer proposes become `superseded`; proposed again, they return to `pending`.
- `PATCH /autogeo/:suggestionId { "status": "applied" | "dismissed" | "pending" }`.

Insertions keep their anchor block in `suggestedSnippet`, so applying a suggestion always means
"replace `originalSnippet` with `suggestedSnippet`".

- `POST /autogeo/:suggestionId/apply` — "Apply to CMS". Sends a signed `autogeo.suggestion.applied` event
  (`x-aiv-event`, `x-aiv-timestamp`, `x-aiv-signature` = HMAC-SHA256 like syndication) to every syndication webhook
  configured under AI Dağıtım. Payload: `site`, `suggestion { id, pageUrl, ruleType, ruleId, title, expectedGain,
  original {markdown, html}, suggested {markdown, html}, inserted?, diffMarkdown }`. At least one `2xx` → status
  `applied`. No webhook configured → `{ configured: false }`, nothing sent, status unchanged. Every webhook failed →
  `502` with `details.deliveries`, status unchanged. Each delivery is logged as a `PlatformSubmission`.

## Competitors — `GET /competitors?days=30&gapLimit=50&refresh=true`

Recomputes the Share-of-Model analysis over stored visibility checks and upserts one `CompetitorAnalysis` row per
competitor in `settings.visibilityAnalysis.competitors` (removed competitors are deleted). Response: `site` (the
site's own metrics), `competitors[]` (`shareOfModel`, `mentionShare`, `citedQueriesCount`, `gapQueriesCount`,
`topCitedUrls`, `sentimentScore`), `citationGaps[]` (queries a competitor wins and the site does not, with missing
cite-magnet factors), `perModel` shares and the analysis `window`. Shares are among the site and configured
competitors only. `refresh=false` returns the stored rows without recomputing.

## Entities — `/entities/reconcile`

- `GET ?status=matched,review&type=Organization&verified=true&minConfidence=0.8&limit=&offset=` re-syncs the mirror
  and returns `items`, `byStatus` and `sameAs` (verified entities with their links, ready for Schema.org `sameAs`).
- `isVerified` = a human pinned the QID, or an automatic/declared match has confidence ≥ 0.8.
- `POST` actions: `{ "action": "sync" }` (default), `{ "action": "verify", "entityId", "qid": "Q42" }`,
  `{ "action": "reject", "entityId" }`, `{ "action": "requery", "entityId", "query"?, "lang"? }`. They run through
  the Wikidata reconciler (`docs/wikidata.md`), so graph `same_as` edges stay consistent.

## Bot simulation — `/simulation/bots`

- `POST { "urls"?: ["/", "/blog/x"], "bots"?: ["GPTBot", "ClaudeBot", ...], "includeBaseline"?: true }` → `201`.
  Default URLs: home page + up to 4 recently crawled 2xx pages (max 10). Default bots: GPTBot, ClaudeBot,
  PerplexityBot, Google-Extended, Applebot-Extended (also available: OAI-SearchBot). The `Browser` control request
  separates bot-only blocks from site-wide failures.
- Each record: `statusCode`, `isBlocked` + `blockedBy` (`cloudflare`, `imperva`, `akamai`, `aws_waf`, `sucuri`,
  `datadome`, `captcha`, `http_status`, `network`), `isCsrShell` (empty `#root/#app/#__next/...` mount or
  script-heavy page with little HTML text), `tokenCount` (visible text ÷ 4), `bytes`, `loadTimeMs`, selected
  response `headers` (never cookies) and `diagnostics`.
- Response `summary`: `perBot` verdicts, `botOnlyBlocks`, `csrShellUrls`.
- `GET ?runId=&bot=&blocked=true&limit=&offset=` — latest (or given) run.
- Safety: URLs must be on the site's host or a subdomain; every redirect hop is checked against private networks
  (`ALLOW_PRIVATE_NETWORK_TARGETS=true` for local development); 15 s timeout, 2 MB body cap, one run per site at a time.
  Google-Extended and Applebot-Extended are robots.txt tokens: they are simulated with the Googlebot / Applebot agents.

## Synthetic queries — `/queries/synthetic`

- `POST { "mode": "generate", "languages"?: ["tr","en"], "intents"?: [...], "maxPerIntent"?: 10, "save"?: true }`
  expands TR/EN templates for the four intents (informational, comparative, transactional, reputation) over the
  knowledge graph (products, categories, concepts, FAQ questions), target keywords, the site brand and configured
  competitors. `save: false` previews.
- `POST { "mode": "manual", "queries": [{ "query", "intent", "language"? }] }` stores hand-written prompts;
  `POST { "mode": "archive", "ids": [...] }` retires them (re-adding revives).
- Exact duplicates are caught case/diacritics-insensitively (`Güvenilir` = `guvenilir`), near duplicates by token
  Jaccard ≥ 0.8. `difficulty` (0-100) is a heuristic: comparative > transactional > reputation > informational,
  unbranded prompts are harder, prompts naming the site's own brand easier.
- `GET ?intent=comparative,reputation&language=tr&status=active&source=template&limit=&offset=` → `items`, `total`, `byIntent`.
