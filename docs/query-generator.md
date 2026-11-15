# Synthetic query discovery (multi-intent prompts)

`src/lib/services/query-generator.ts` turns a site's knowledge graph into the long, conversational prompts people send to AI search engines, following the GEO-bench idea of covering several user intents rather than single keywords.

## Inputs

| Source | Used as |
| --- | --- |
| `Site.targetKeywords` | Manual prompts — always first, never quality-filtered |
| `GraphEntity` Product (+ `has_brand`, `has_category`, `price`, `currency`, `rating`, `pagerank`) | Product prompts, "A vs B" between products of the same category, budget prompts ("What are the best … under $15,000?") from the category's median price |
| Category / Brand / Concept entities | Category, brand and concept prompts |
| FAQ entities, question-shaped article headings (`CrawledPage.h1`) | Kept verbatim — they are real user phrasings |
| `settings.visibilityAnalysis.competitors` | "Site vs competitor" prompts |
| `settings.locale` | Languages: `tr*` → Turkish, `en*` → English, otherwise both |

Crawled names are cleaned (`"Barista Pro X | Shop"` → `Barista Pro X`); URLs, navigation labels ("Home" and its Turkish equivalent), sentences and over-long names are dropped. Category and concept names are lower-cased mid-sentence and never used in templates of the other language (a Turkish category name such as "Kahve Makineleri", "coffee machines", is never put into an English template, so "best Kahve Makineleri brands" is not generated).

## Intents

Each intent has an English and a Turkish template set (`TEMPLATES` in `src/lib/services/query-generator.ts`). Examples of the English output:

1. **informational**: "What is X and how does it work?", "What should I look for when buying X?"
2. **comparative**: "Which brands make the best X?", "A vs B: which one is better?", "What are the best alternatives to X?", budget and value-for-money prompts
3. **transactional**: "Where can I buy X?", discounts, stock and shipping, authorized retailers
4. **reputation**: "Is [Site] legit and trustworthy?", "What are the common problems with [Product]?", user reviews

### Turkish templates

<!-- The Turkish examples in this section are deliberate: they show the output of the Turkish template set, which is language data (not UI text). -->

Turkish prompts are generated only when the `tr` language is selected: the `languages` option, which defaults to the site's `settings.locale` (`tr*` → Turkish, `en*` → English, otherwise both). This prompt language is independent of the dashboard / API locale. Examples:

| Intent | Turkish prompt | Meaning |
| --- | --- | --- |
| informational | "X nedir ve nasıl çalışır?" | What is X and how does it work? |
| comparative | "En iyi X markaları hangileri?", "A mı B mi? Hangisi daha iyi?" | Which are the best X brands? / A or B? Which is better? |
| transactional | "X nereden satın alınır?" | Where can I buy X? |
| reputation | "[Site] güvenilir mi?", "[Product]'ın kronik sorunları" | Is [Site] trustworthy? / Chronic problems of [Product] |

Turkish grammar is handled by `src/lib/text/turkish.ts`: vowel harmony, consonant assimilation and apostrophes for proper nouns (`Kahvecim'den`, `Doğuş'tan`, `Samsung'un`), the pronominal *n* of possessive compounds (`Kahve Dünyası'ndan`), pronunciation of numbers and acronyms (`iPhone 15'in`, `S3'ten`, `BMW'nin`), and the separately written question particle (`Acme mi`, `Rival mı`). Foreign names follow spelling except the common consonant + "le" / "-lle" endings (`Apple'ın`, `Breville'in`).

## Expansion, scoring, filtering

- **Template expansion** (default on): conversational variants of the strongest seeds, for example "As of 2026, …", "I'm new to this, so please keep it simple: …" and "… Please cite reliable sources." (each language has its own wrapper set; the Turkish ones are language data). Each intent/language bucket keeps at least one.
- **LLM expansion** (opt-in): `expandWithLlm(seeds, complete)` takes any text-completion function, asks for rephrasings, and labels/filters them. Nothing in the app calls a paid model for generation implicitly.
- **difficulty** (competition) and **volume** are 0–100 heuristics with `low / medium / high` levels: generic head terms ("best X brands") are hard and frequent, long, specific or self-branded prompts are easy and rare. They are relative estimates, not keyword-planner data.
- **quality** (0–1) rejects malformed prompts (unfilled placeholders, URLs, too short/long) and penalises stutters and shouted names; minimum 0.6.
- **Duplicates**: token Jaccard on folded, stop-word-free 5-character stems + character-trigram Dice; ≥ 0.8 within a language counts as duplicate and the better-scored query wins.
- **Selection**: round-robin intent × language, `perIntent` each; one entity is not repeated within a bucket while alternatives exist. `branded: true` marks prompts naming the site — answers mention the site by construction, so filter them out when measuring organic share of voice.

## API

```sh
curl "http://localhost:3000/api/sites/$SITE_ID/queries?intents=comparative,reputation&languages=tr&perIntent=5&expand=true"
```

Returns `{ items, total, byIntent }`; each item has `text`, `intent`, `language`, `targets[{name, kind}]`, `branded`, `source` (`manual | template | faq | expansion | llm`), `templateId`, `difficulty`, `volume`, `quality`, `score`. Generation is deterministic and makes no external calls. The visibility engine (`/api/sites/:id/visibility`) uses the same generator for its suggestions and for POST runs without explicit `queries`.
