# Multi-model visibility checks

`GET /api/sites/:id/visibility?limit=50&offset=0` returns stored records, total count, up to ten suggested `queries` and `querySuggestions` (up to 40, with intent / language / difficulty / volume labels). Suggestions come from the [synthetic query generator](query-generator.md): `Site.targetKeywords` first, then a round-robin over the four intents (informational, comparative, transactional, reputation) and the site's languages. An explicit POST `queries` list replaces suggestions; a site with neither keywords nor relevant graph data gets HTTP 400 rather than a biased brand-only fallback.

## Run a batch

Configure `API_TOKEN` plus the key and model environment variables for each provider you want to use (see `.env.example`). Model IDs must support the selected search tool and be available to your account; unavailable models produce per-provider failures, not fabricated results.

```sh
curl -X POST "http://localhost:3000/api/sites/$SITE_ID/visibility" \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"queries":["En iyi doğal zeytinyağı markaları"],"models":["chatgpt","gemini","claude","perplexity"]}'
```

- Empty body / `{}`: generated queries and all four providers. With generated queries, `intents` (subset of the four) and `languages` (`tr`, `en`) narrow the selection; each record's `responseMeta` then carries `queryIntent`, `queryLanguage`, `queryBranded` and `querySource` (explicit queries get a heuristic `queryIntent` only). `queries`: 1–10 strings, each 1–500 characters. `models`: subset of the four names. Duplicate queries/models collapse. `refresh: true` bypasses cache.
- Paid POST requires `API_TOKEN` even when the existing optional proxy guard is disabled (503 if unconfigured, 401 for invalid credentials). This is a shared-token, single-tenant API, not per-user authorization.
- A response contains `items`, `attempted`, `successful`, `failed`, overall `citationRate`, and `perModel`. Each item has either `{ record, cached }` or a sanitized `error`: `not_configured`, `rate_limited`, `timeout`, `provider_error`, `invalid_response`.
- Partial or total upstream failure returns HTTP 200 with explicit counts/errors. Validation/not-found/conflict errors use 400/404/409. Database failures remain HTTP 500, not successful provider outcomes.

## Providers and evidence

| Name | Endpoint / search mechanism | Parsed sources |
| --- | --- | --- |
| chatgpt | OpenAI `/v1/responses`, `web_search` | Message URL annotations |
| gemini | Google `v1beta/models/:model:generateContent`, `google_search` | Grounding chunk web URIs |
| claude | Anthropic `/v1/messages`, `web_search_20250305` (up to 3 searches) | Text-block web citations |
| perplexity | `/chat/completions`, configured Sonar model | `citations` array |

The Sonar endpoint is a compatibility integration (the provider now recommends Agent API). The adapter is isolated for migration. Tests use deterministic mocked HTTP responses, not paid accounts; current account/model compatibility must be smoke-tested before deployment.

Prompts request current web sources and numbered alternatives, without injecting the tracked site or title. A provider can still answer without invoking search; absence of returned source metadata is not proof of a grounded answer. API experiments are not measurements of the consumer ChatGPT/Gemini/Claude UI.

A successful check saves one `LlmVisibilityRecord`. `responseMeta` stores model ID, cache version/key, `isCited`, `isMentioned`, cited/source URLs, competitor domains and extraction methods. Credentials and raw provider envelopes are not stored. Queries, excerpts and source URLs are application data: don't submit secrets as prompts.

- **Citation:** target hostname (including subdomains and `www`) in structured sources or an HTTP(S) link in the answer. Lookalike domains and user-info URLs do not match. Links are model-produced evidence, not independently verified pages.
- **Mention:** standalone title/brand or domain in prose (case-insensitive, Unicode-aware). URL-only evidence does not imply a textual mention. Set the site's title to the intended brand rather than a marketing slogan.
- **Position:** explicit numbered line containing the target label, otherwise `null`. Source order and prose order are not recommendation ranks. A deterministic heuristic, not semantic rank adjudication.
- **Competitors:** other source hostnames, explicitly labelled `other-source-domains`. These are candidates; a cited publisher is not necessarily a recommended business competitor.
- Citation URLs are never fetched. In particular, opaque Google grounding redirect URIs cannot be attributed to their hidden destination; this can undercount citations. No guessed redirect attribution or arbitrary-URL SSRF is introduced.

## Scores and cost bounds

`citationRate = 100 × cited successful checks / successful checks`, rounded to an integer, per model and overall. Failed checks are excluded; a batch with zero successes yields `null` rather than false zero visibility. `/reports?days=30` adds the same citation-only metric to the existing mention-inclusive `visibilityRate`. Empty historical reports retain the existing zero convention; `totalChecks` distinguishes no data. Historical aggregation weights recorded checks equally, not models equally.

Successful records are reused for 24 hours for the same site URL/title, provider/model, query and extraction version. Reuse returns the original ID/time and does not insert duplicate observations or inflate reports. Refresh performs a new measurement. Changing the site's title/URL or model invalidates the cache. Failures are never cached or inserted as `none`.

A batch makes at most 40 calls, two at a time, with a 20-second request/body deadline and 1 MB response limit per call. No automatic retries (especially no paid-call replay after 429). One active batch per Node process returns 409 to competing batches. This is not a distributed rate limiter: use one replica, and add a shared queue/quotas before multi-replica or multi-tenant deployment. There is no detached background work; the request waits for the batch. Worst-case wall time is about 400 seconds plus DB overhead; hosting must support the 450-second route duration, or callers must use smaller batches. Provider/hosting timeouts may still incur charges.

## Verification

```sh
npm test
npm run build
npm run typecheck
npm run lint
```

`tests/visibility.test.ts` runs four adapter fixtures through native-fetch mocks and a real migrated SQLite database. It covers query generation, extraction, score denominators, cache expiry/invalidation, pagination/site isolation, authorization/validation, partial failure, oversized/malformed bodies, timeouts and concurrent-batch limits. No live provider traffic is required.
