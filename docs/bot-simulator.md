# Live AI crawler simulator: WAF and JS render diagnosis

A robots.txt `Allow` does not mean an AI crawler can read the page. Bot protection (Cloudflare Managed Challenge /
Turnstile, Imperva, Akamai, AWS WAF, DataDome, Vercel Firewall), user-agent rules and client-side rendering often
hand GPTBot, ClaudeBot or PerplexityBot a 403/503, an interstitial or an empty `<div id="root">`, and nothing
reports it. The simulator requests live URLs using each crawler's published User-Agent and request headers. Like
the real crawlers, it sends no cookies, no client hints and runs no JavaScript. It also fetches each URL once as a
browser for comparison, then reports what every bot actually received.

There are two implementations with the same report format (snake_case JSON):

| Where | Entry point | Used by |
| --- | --- | --- |
| Python (crawler) | `geo_crawler.scoring.bot_simulator.simulate_bots`, CLI `geo-botsim` | `geo-audit` (homepage + 2 key pages) |
| Next.js | `src/lib/services/bot-simulator.ts` → `simulateBots` | `POST /api/sites/:id/bot-simulator` (on demand) |

Contract tests (`tests/bot-simulator.test.ts`) parse a real Python report and require identical summaries,
token estimates, word counts and fix recipes from the TypeScript port.

## Bots

| robots.txt token | Request identity | Note |
| --- | --- | --- |
| `GPTBot` | `…compatible; GPTBot/1.3; +https://openai.com/gptbot` | default |
| `ClaudeBot` | `…compatible; ClaudeBot/1.0; +claudebot@anthropic.com` | default |
| `PerplexityBot` | `…compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot` | default |
| `Google-Extended` | Googlebot/2.1 | default. Google-Extended is only a robots.txt token; Google fetches with Googlebot |
| `Applebot-Extended` | Applebot/0.1 | default. Same as above: Apple fetches with Applebot |
| `OAI-SearchBot`, `ChatGPT-User`, `Claude-User`, `Perplexity-User` | official UAs | optional (`bots` / `--bots`) |

## What is checked

**Access, per bot and URL.** Each response gets an `outcome`:

- `ok` or `degraded` (the bot received less than 50% of the browser's words: cloaking or a cut-down template)
- `challenge` (JS challenge / CAPTCHA)
- `blocked`
- `rate_limited`
- `error` (connection dropped or timed out)
- `not_found` or `server_error`

Protection is detected from headers (`cf-mitigated`, `x-vercel-mitigated`, `x-amzn-waf-action`) and from the
response body: Cloudflare `_cf_chl_opt` with its `cType` (managed / non-interactive / interactive), error codes
1020 and 1015, Imperva `_Incapsula_Resource`, Akamai `Reference #`, CloudFront/AWS WAF, DataDome
`captcha-delivery.com`, PerimeterX and Sucuri. Weak markers such as reCAPTCHA, hCaptcha and Turnstile widgets
only count on interstitial-like pages (HTTP ≥ 400 or fewer than 150 words), so a CAPTCHA on a contact form is
not reported. Each result also records:

- `robots_allowed`: the RFC 9309 verdict for the bot's robots.txt token.
- `silent_block`: robots.txt allows the bot, but the server refuses it.
- `general`: the browser was refused too, which points to a bot wall, an IP/geo block or a site outage.

**Render integrity.** This is the crawler's `classify_render` applied to the HTML the bot received:

| Mode | Meaning |
| --- | --- |
| `static`, `ssr_hydrated` | The content is in the HTML |
| `heavy_js` | Under 2% text/HTML and fewer than 200 words |
| `thin` | Fewer than 50 words |
| `csr_shell` | Fewer than 50 words plus an empty `#root` / `#app` / `#__next` / `#__nuxt` or a script-heavy page |

The framework (`__NEXT_DATA__`, RSC, Nuxt…) and a `<noscript>` "enable JavaScript" notice are also recorded.

**Token weight.** The report includes:

- HTML tokens and readable-text tokens. The tokenizer is `cl100k_base` (GPT-4). Counts are exact when
  `tiktoken` is installed (`pip install -e '.[tokens]'`). Otherwise they come from a linear model over the
  cl100k pre-tokenizer chunks, which is within about 12% of tiktoken on HTML, Markdown, JSON, Turkish and English.
- `signal_ratio`, the share of HTML tokens that are readable text.
- Decoded and transferred KB, and the compression in use.
- DOM node count and depth, plus embedded JSON state (`__NEXT_DATA__`, the RSC `self.__next_f` payload,
  `__NUXT__`, Redux/Apollo) and the bytes of inline CSS, SVG and data URIs.

**Scores (0-100).** The overall score is `0.6·access + (0.25·render + 0.15·tokens) · access/100`, so render and
token efficiency only count to the extent that bots get in. Token efficiency is 100 at a `signal_ratio` of 10% or
more and 40 at 1%. It loses 15 points for uncompressed HTML over 20 KB and 10–20 points for HTML over 1–2 MB.

## Findings and fix recipes

Findings carry a `severity`:

| Severity | Findings |
| --- | --- |
| `critical` | `waf_challenge`, `waf_block`, `general_block`, `csr_shell` |
| `warning` | `rate_limited`, `content_parity`, `robots_disallow`, `slow_response`, `thin_html`, `token_bloat`, `large_html` |
| `info` | `low_signal`, `no_compression` |

Fix recipes are generated for the bots that were refused. If no bot was refused, recipes are generated for every
simulated bot and marked `preventive: true`. A recipe is marked `recommended: true` when its platform matches the
detected CDN/WAF.

| id | Content |
| --- | --- |
| `cloudflare_waf_skip` | Custom-rule expression `(http.user_agent contains "GPTBot") or … or (cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant"})` → **Skip** (custom rules, rate limiting, managed rules, Super Bot Fight Mode), a stricter verified-bots-only variant, the Bot settings to turn off ("Block AI bots", "AI Labyrinth") and the Rulesets API JSON |
| `nginx_allow` | `map $http_user_agent $is_ai_bot`, a rate-limit key that exempts AI bots, and the UA-block exception |
| `apache_allow` | `SetEnvIfNoCase` + RewriteCond exception, `Require env ai_bot`, and a ModSecurity/CRS `ctl:ruleRemoveByTag=attack-reputation-scanner` exception |
| `aws_waf_allow` | Only when AWS WAF is detected: a RegexMatch Allow rule + an override for Bot Control `CategoryAI` |
| `<vendor>_console` | Console steps for Akamai, Imperva, Vercel, Sucuri, DataDome and HUMAN |
| `ssr_render` | Server Component / ISR example, and prerender options for SPAs |
| `token_diet` | Trimming embedded state, the DOM and inline assets, plus compression |

> Requests come from this server, not from the AI vendors' IP ranges. A WAF that verifies bots by IP (for
> example Cloudflare verified bots) can treat a spoofed UA differently from the real crawler. Reports that contain
> blocks include this caveat. Confirm blocks in the WAF's event log (Cloudflare → Security Events).

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/sites/:id/bot-simulator` | `{ auditId, completedAt, summary }`. The `metrics.botSimulation` summary from the latest completed audit |
| `POST` | `/api/sites/:id/bot-simulator` | Runs now and returns the full report. Body (optional): `{ "urls": ["https://site/…"], "bots": ["GPTBot", "ChatGPT-User"] }` |

`POST` accepts at most 5 URLs, and they must be on the site's host (with or without `www.`). The server never
fetches third-party URLs. Results are returned to the caller and not stored. Audits store the summary.

```bash
curl -X POST localhost:3000/api/sites/$SITE/bot-simulator -H 'content-type: application/json' \
  -d '{"urls":["https://example.com/","https://example.com/urun/x"]}'
```

## Audit integration

When the audit runs with `probe_user_agents` (the default; `--no-ua-probe` turns it off), `geo-audit`:

- Simulates the homepage plus the two most citable key pages and puts the full report under `bot_simulation`
  in the audit JSON and the summary under `metrics.botSimulation`.
- Adds the simulation's evidence to `crawler.waf_ua_block`. The fix snippet becomes the recipes for the detected
  vendor, recommended one first.
- Emits `crawler.bot_content_parity` when bots receive less than the browser.
- Emits `technical.ai_token_bloat` when DOM/JSON bloat or HTML over 1 MB is found.

The GEO score formula does not change. Simulation failures are logged and never fail the audit.

```bash
cd services/crawler
.venv/bin/geo-botsim https://example.com/ --code        # text report + recipes
.venv/bin/geo-botsim https://example.com/ --json        # full JSON (exit 1 if any bot lacks access)
```
