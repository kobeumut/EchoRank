# Wikidata entity reconciliation & JSON-LD `@graph`

AI answer engines (ChatGPT search, Perplexity, Gemini, Claude) disambiguate brands, companies and authors
against public knowledge graphs. Linking site entities to their Wikidata item through Schema.org `sameAs`
tells them exactly *which* "Ayşe Yılmaz" or "Brevio" the page is about.

## Pipeline (Python, `services/crawler`)

```bash
geo-audit https://example.com --reconcile --crawl-records crawl.json --jsonld schema.json   # audit + reconcile
geo-crawler https://example.com -o graph.json --reconcile --jsonld schema.json             # crawl only
geo-reconcile graph.json -o graph.reconciled.json --jsonld schema.json [--lang tr]          # existing graph
```

`CRUNCHBASE_API_KEY` enables the Crunchbase fallback. `--max-concepts` (default 15) bounds how many keyword
concepts are looked up; schema.org `about`/`mentions` concepts always go first.

For every `Organization`, `Brand`, `Person`, `Product` and `Concept` node (`geo_crawler/wikidata.py`):

1. A Wikidata URL already in the site's own `sameAs` → `declared` (trusted, confidence 1).
2. `wbsearchentities` (site language, then English) → `wbgetentities` (labels, aliases, claims, sitelinks).
3. Each candidate is scored 0–1:
   `0.5·name + 0.25·type + 0.15·sector context + 0.10·search rank`
   - **name**: Turkish-aware folding, legal suffixes (A.Ş., Ltd. Şti., Inc.) ignored, aliases count.
   - **type**: `P31` against accepted classes (organization/company/brand/human/product…); unknown classes go
     through a SPARQL `P31/P279*` closure query (skipped gracefully when the endpoint is busy).
     Disambiguation pages, given/family-name items and Wikimedia lists score 0 and are multiplied by 0.3.
   - **context**: candidate description vs. the site's category / concept vocabulary; a person whose
     employer (`P108`) is the site's matched organisation counts as full context.
   - **official website** (`P856`) on the site's domain → at least 0.97.
   - A person without any corroboration is capped at 0.7: namesakes must be confirmed by a human.
4. `≥ 0.8` → `matched`; `≥ 0.55` → `review`; else Wikipedia search (a linked item is re-scored; an unlinked
   article is only a suggestion) → Crunchbase (exact-name suggestion) → `unmatched`.

Only `matched` / `declared` / `verified` results publish anything. Node properties:

| property | meaning |
| --- | --- |
| `wikidataId`, `wikidataUrl`, `wikipediaUrl` | the accepted item |
| `sameAs` | Wikidata, Wikipedia, LinkedIn, Crunchbase, X, Facebook, Instagram, YouTube, GitHub, ORCID, VIAF + site-declared profiles |
| `confidence` | 0–1 score of the best candidate |
| `alumniOf`, `knowsAbout`, `hasCredential`, `employerWikidataIds` | Person facts from `P69`, `P101`/`P106`, `P512`, `P108` |
| `reconciliation` | `{status, method, confidence, candidates[top 3 with signals], lang, suggested?, rejectedQids?, reconciledAt, verifiedAt?}` |

Graph edges: `entity ─same_as→ wikidata:Q…` (`WikidataEntity` node) and `same_as` between two site entities
that resolved to the same QID (e.g. Brand "Brevio" and Organization "Brevio A.Ş.").

## Review API (Next.js, `src/lib/services/wikidata.ts`)

| endpoint | purpose |
| --- | --- |
| `GET /api/sites/:id/reconciliation?status=review,unmatched&type=Person` | review queue + `byStatus` counts (review first) |
| `POST /api/sites/:id/reconciliation/:entityId` `{"action":"verify","qid":"Q42"}` | pin a QID (confidence 1, status `verified`) |
| `POST …` `{"action":"reject"}` | drop the match/suggestion; the QID is added to `rejectedQids` and never auto-matched again |
| `POST …` `{"action":"requery","query"?:"…","lang"?:"tr"}` | search Wikidata again with the same scoring |
| `GET /api/sites/:id/jsonld` | `{jsonld, valid, errors, script}` — site-wide `@graph` and a paste-ready `<script>` tag |

Manual decisions survive re-crawls: when crawl records are ingested, `verified` / `rejected` entities keep
their reconciliation properties and `same_as` link, whatever the crawler matched this time.

## JSON-LD `@graph` (`geo_crawler/jsonld.py`, `src/lib/jsonld.ts`)

One connected graph, every cross-reference by `@id`:
`WebSite → publisher → Organization`, `Article → author → Person → knowsAbout → Thing`,
`Article → about → Thing`, `Product → brand → Brand`, `Offer → seller → Organization`,
`Person → worksFor → Organization` (when Wikidata `P108` is the site's organisation).

Nodes that would fail Google Rich Results are omitted (Product without Offer/AggregateRating, Offer without a
positive price + ISO 4217 currency, Article without a named author); headlines are cut to 110 characters,
non-ISO dates and relative URLs are dropped or resolved. `validate_jsonld` / `validateJsonLd` enforce the same
rules (required properties, dangling `@id` references, absolute `sameAs` URLs, ItemAvailability URLs,
ISO 8601 dates) and both test suites require generated output to validate with zero errors.
