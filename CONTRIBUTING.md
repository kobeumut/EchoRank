# Contributing to EchoRank

Thank you for your interest in improving EchoRank. This guide explains how to set up the project, how changes
are reviewed, and the conventions we follow, in particular for internationalization.

By contributing you agree that your contribution is licensed under the project license, **CC BY-NC-SA 4.0** (see
[`LICENSE`](LICENSE)). Please report security issues privately, as described in [`SECURITY.md`](SECURITY.md), not in
public issues or pull requests.

## Ways to contribute

- Report bugs and request features by opening an issue. Include the steps to reproduce, what you expected, what
  happened, and your versions (Node.js, Python, OS). Remove API keys, tokens and private URLs from logs.
- Improve documentation under `docs/` and the READMEs.
- Add or improve translations (see [Internationalization rules](#internationalization-rules)).
- Fix bugs or implement features. For anything larger than a small fix, open an issue first so we can agree on the approach.

## Development setup

Prerequisites: Node.js 22 or newer with npm, and Python 3.10 or newer for the crawler / scoring engine.

```bash
git clone https://github.com/kobeumut/ai-visibility.git echorank
cd echorank

# Web app and API
npm ci                      # also runs `prisma generate`
cp .env.example .env        # defaults work for local development; never commit .env
npm run db:migrate          # creates the SQLite database in prisma/dev.db and loads demo data (re-run with `npm run db:seed`)
npm run dev                 # http://localhost:3000

# Python engine
cd services/crawler
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

To let the web app run audits locally, set `GEO_AUDIT_BIN=services/crawler/.venv/bin/geo-audit` in `.env`.
The project layout and configuration are described in [`README.md`](README.md).

Note for Next.js work: this repository uses Next.js 16, which has breaking changes compared to older releases.
Read the relevant guide in `node_modules/next/dist/docs/` before changing routing, caching or rendering code
(see also `AGENTS.md`).

## Branches and pull requests

1. Fork the repository and create a topic branch from `main`, for example `fix/queue-backoff` or `feat/new-language`.
2. Keep changes focused: one concern per pull request, and avoid unrelated reformatting.
3. Write clear commit messages in English, preferably in the Conventional Commits style used in the history
   (`feat(i18n): add Turkish catalogs`, `fix(distribution): retry on 429`).
4. Make sure the checks below pass locally, then open a pull request against `main`. Describe what changed and why,
   link the issue, and list how you tested it. Add screenshots for UI changes in both light and dark themes.
5. Respond to review comments by pushing additional commits. A maintainer merges once the review is complete.

Do not change public API shapes, JSON field names, stored enum values or the database schema without discussing it
first. Schema changes need a Prisma migration (`npm run db:migrate`) committed with the change.

## Checks to run before opening a pull request

```bash
npm run lint
npm run typecheck           # on a fresh clone run `npx next typegen` once to generate route types
npm test                    # Vitest, uses a throw-away SQLite database (prisma/test.db)
cd services/crawler && .venv/bin/python -m pytest -q
```

Run a single test file with `npx vitest run tests/<file>.test.ts` or `.venv/bin/python -m pytest -q tests/<file>.py`.

## Code style

- **TypeScript:** strict mode, ESLint with `eslint-config-next`. Validate every request body and query with Zod
  (`src/lib/validation.ts` and the service modules show the pattern), keep route handlers thin and put logic in
  `src/lib/services/`. Use the `@/` import alias.
- **Python:** type hints, `from __future__ import annotations`, small modules under `geo_crawler/`, `pytest` with
  `respx` for HTTP mocking. Public builders take keyword-only options such as `lang`.
- **General:** follow the style of the surrounding code (no formatter is enforced), prefer clear names over comments, and
  keep comments for the reason behind non-obvious decisions. All identifiers, comments, docstrings, log and error
  messages are written in English.
- **Outbound requests:** anything that fetches user-supplied URLs must reuse the existing SSRF guards
  (`src/lib/distribution/net.ts`, `src/lib/reports/outbound.ts`) and enforce timeouts and body-size limits.
- **Secrets:** never hard-code keys, tokens or credentials, never log them, and do not add real values to `.env.example`.

## Testing

- Add or update tests for every behaviour change. Web tests live in `tests/` (Vitest), crawler tests in
  `services/crawler/tests/` (pytest).
- Tests must not use the network or paid APIs: mock HTTP (`respx` in Python, `fetch` mocks in Vitest) and use the
  temporary SQLite database the Vitest setup creates.
- The bot simulator has a cross-language contract: `tests/bot-simulator.test.ts` reads the fixtures in `tests/fixtures/`,
  which are generated from the Python implementation. If you intentionally change the Python report format, regenerate them with
  `BOTSIM_UPDATE=1 .venv/bin/python -m pytest -q -k contract` from `services/crawler`, and keep the TypeScript port in sync.

## Internationalization rules

The product is English-first, with English (`en`, default and fallback) and Turkish (`tr`) localization.
The architecture is summarized in the README ([Internationalization](README.md#internationalization)).

1. **No hard-coded user-facing strings.** Everything a user can read (UI text, API error messages, generated
   recommendations, reports, CLI output) goes through the message catalogs.
   - Web app: use `useT()` (client) or `getT()` / `serverT(locale)` (server) from `src/lib/i18n/`. Pure helpers take a
     `t: Translator` or `locale` parameter instead of returning literal text. Use `useFormat()` for dates, numbers and
     relative times: never hard-code `"tr-TR"` or `"en-US"` in UI code.
   - Python: `get_translator(lang)` from `geo_crawler.i18n`, with a keyword-only `lang: str = "en"` parameter threaded through
     public functions and every CLI that prints text (`--lang en|tr`).
2. **Add `en` and `tr` keys together in the single source.** Catalogs are flat, with globally unique dotted keys prefixed by the namespace
   (`"actions.empty.noOpen"`). Add the English text to `locales/en/<namespace>.json` and the Turkish text to
   `locales/tr/<namespace>.json`. Both the TypeScript frontend/backend and Python crawler read from these exact files.
   Use `{name}` placeholders (never string concatenation) and `key_one` / `key_other` variants plus a `count` parameter for plurals.
3. **English is the source of truth.** Write the English message first; the Turkish message must keep the same
   `{placeholders}`. If you cannot write Turkish, add an English-text placeholder to `tr` and say so in the pull request:
   a maintainer or another contributor can translate it. Missing keys fall back to English at runtime, but the
   parity tests require the keys to exist.
4. **Do not change stored values by locale.** JSON field names, enum values, database columns and endpoint paths are
   language-independent. Text that the platform generates and persists (reports, suggestions, action cards) is
   stored in the language of the request that generated it.
5. **Comments, identifiers, test titles and docs are English.** Turkish is allowed only in the `tr` catalogs and in
   *deliberate language data*: Turkish morphology (`src/lib/text/turkish.ts`), Turkish template variants, stop-word
   lists, patterns that recognize Turkish web content, and Turkish sample content in tests that exercises those
   code paths. Every such block needs an English comment explaining why it is Turkish.
6. **New language:** follow the steps in the README ("Adding a language").

### Parity tests and the Turkish-text check

```bash
npx vitest run tests/i18n.test.ts                                   # every locale has the same keys and {placeholders} as English,
                                                                    # and every literal t("ns.key") in src/ exists
cd services/crawler && .venv/bin/python -m pytest -q tests/test_i18n.py   # the same for the Python catalogs
```

To find Turkish text that slipped into code, comments or docs, list every line with a Turkish-only letter outside the
`tr` catalogs:

```bash
git grep -nIP '[çğıöşüÇĞİÖŞÜ]' -- . ':(exclude)package-lock.json' ':(exclude)*.svg' ':(exclude)*.ico' \
  ':(exclude)locales/tr'
```

Every remaining hit must be deliberate language data with an explanatory English comment (see rule 5). Turkish words
written in plain ASCII are not caught by this pattern, so also review diffs for untranslated text.

## Documentation

Update the relevant page in `docs/` (and the README tables) whenever you change an endpoint, a CLI flag, an environment
variable or a scoring rule. Examples must match the implementation: run the commands you document. Sample output in
docs shows the English default; mention `?lang=tr` or `--lang tr` where the language matters.

## Questions

Open a GitHub issue on https://github.com/kobeumut/ai-visibility. Thank you for contributing!
