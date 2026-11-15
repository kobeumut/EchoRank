# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull requests or discussions.**

Use GitHub's private vulnerability reporting instead:

1. Open the repository at https://github.com/kobeumut/EchoRank.
2. Go to the **Security** tab and choose **Report a vulnerability**.
3. Describe the issue, the affected version or commit, the impact, and steps to reproduce (a minimal proof of concept
   helps). Do not include real credentials, tokens or other people's data.

If the **Report a vulnerability** option is not available, open a public issue that only says you would like to report a
security problem privately (no technical details), and the maintainer will arrange a private channel.

What to expect:

- We acknowledge reports on a best-effort basis and aim to confirm receipt within a few days.
- We investigate, keep you informed, and agree on a coordinated disclosure date once a fix is available.
- You are credited in the release notes or advisory if you wish.

This is a community project maintained on a best-effort basis: there is no bug bounty and no guaranteed response time.

## Supported versions

The project is pre-1.0 (`0.x`). Security fixes are made on the latest commit of the `main` branch and included in the
next release. Older releases and forks do not receive backports; please update before reporting.

| Version | Supported |
| --- | --- |
| `main` (latest) | Yes |
| Older `0.x` releases | No |

## Scope

In scope: the Next.js application and its API (`src/`), the scheduled-report worker (`scripts/`), the Python crawler and
scoring engine (`services/crawler`), the Prisma schema and migrations, and the default configuration shipped in this
repository (for example `.env.example`).

Out of scope: vulnerabilities in third-party dependencies that have no exploitable path in this project (report them
upstream), issues that require an attacker to already hold `API_TOKEN` or shell access to the server, denial of service by
sending excessive traffic to a deployment that has no rate limiting in front of it, and findings about sites or services
that you do not operate and have not been authorized to test.

## Deployment hardening

EchoRank is a single-tenant tool for operators. Its defaults are meant for local development, so review the
following before exposing an instance to a network.

### Authentication

- **Set `API_TOKEN` in every deployment that is reachable by anyone other than you.** Without it, the whole API and
  dashboard are open: anyone can register sites, start crawls, read data and change settings. Use a long random value, for example
  `openssl rand -hex 32`, and store it in a secret manager rather than in a file in the repository.
- With `API_TOKEN` set, all `/api/*` routes (except `/api/health` and `/api/auth`) and all dashboard pages require the bearer token
  or a dashboard session. Paid LLM checks (`POST /api/sites/:id/visibility`) and the scheduled-report endpoints refuse to run
  (HTTP 503) until a token is configured.
- The token is a **single shared secret**: there are no user accounts, roles or per-site permissions. Anyone who holds it can read
  and modify every site, trigger paid provider calls and cause outbound requests. Do not share it with untrusted users.
- The dashboard session cookie (`aiv_session`) is `v2.<expiry>.<HMAC-SHA-256>`: it expires after 7 days on the server side, cannot be
  extended or forged without the signing key, and never contains the token. The key is derived from `API_TOKEN` and the optional
  `SESSION_SECRET` (set it to a random value so a weak `API_TOKEN` cannot be guessed offline from a leaked cookie); rotating either one
  invalidates all sessions. The cookie is `HttpOnly` and `SameSite=Strict`, and `Secure` when `NODE_ENV=production`: serve the app
  **only over HTTPS** (terminate TLS in a reverse proxy) and run it with `NODE_ENV=production`.
- `POST /api/auth` locks a client out for up to 15 minutes after 10 wrong tokens (plus a global cap of 200 failures per window). The
  counters are stored in the database (`LoginThrottle`, keyed by a SHA-256 hash of the client key), so the limit is shared by every
  instance that uses the same database. If a database call fails, that request falls back to per-process counters and the event is
  logged; `LOGIN_RATE_LIMIT_STORE=memory` opts into per-process counters, and a custom shared store (for example Redis) can be registered
  with `configureLoginLimiters`. The client is identified by `X-Forwarded-For`, so make sure the reverse proxy overwrites that header;
  rate limiting at the proxy / WAF is still recommended as a first line.
- The app sets baseline security headers on every response (`X-Content-Type-Options`, `X-Frame-Options: DENY`, a `frame-ancestors 'none'`
  Content-Security-Policy, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`) and removes `X-Powered-By`. It does not
  set `Strict-Transport-Security` (set it at the TLS-terminating proxy) or a full script-src CSP.
- Restrict `/api/distribution/run` (the cron hook) and the other state-changing routes at the network level as well, and call
  them only with the bearer token.

### Outbound requests and SSRF

The platform makes requests to URLs that users supply: sites to crawl, webhooks, IndexNow key files and report targets.

- Keep `ALLOW_PRIVATE_NETWORK_TARGETS` unset or `false` in production. When it is `false`:
  - registering a site whose URL is `localhost`, a private IP literal or an internal-looking name (`.local`, `.internal`, …) is rejected;
  - the audit runner, the Python crawler / site-signal probes / `geo-botsim` / `geo-autogeo` clients, `POST /api/sites/:id/bot-simulator`,
    the persisted bot simulation (`/simulation/bots`), syndication / "Apply to CMS" webhooks, IndexNow submissions and key verification,
    and the Google OAuth token request refuse targets that resolve to loopback, private, link-local, CGNAT, reserved or other internal
    addresses — **including every redirect hop**;
  - those connections are **DNS-pinned**: the name is resolved once, every address is checked, and the socket connects to exactly the
    checked address (Node: an undici dispatcher with a guarded `lookup`, see `pinnedFetch` in `src/lib/distribution/net.ts`; Python: the
    `PinnedAsyncTransport` / `PinnedTransport` httpx transports in `services/crawler/src/geo_crawler/netguard.py`). The original host name
    is kept for the `Host` header, TLS SNI and certificate verification, so a DNS-rebinding answer cannot redirect the connection to an
    internal address after the check;
  - the service-account `token_uri` is only honoured for Google's own HTTPS endpoints (anything else is replaced by the default);
  - scheduled-report webhooks are always restricted to public addresses with a DNS-pinned connection, must use HTTPS, and do not follow
    redirects.
- Defence in depth for fully untrusted targets: use egress filtering, block cloud metadata endpoints (for example `169.254.169.254`) and
  keep databases and admin interfaces on networks the app host cannot reach. An outbound HTTP proxy configured through the environment is
  not used by the pinned clients.
- `GEO_AUDIT_BIN` and `GEO_AUDIT_ARGS` are executed with `execFile` (no shell) and must only be set by the operator.
  Run the audit engine as an unprivileged user, preferably in a container with limited network access.

### Secrets and data

- Never commit `.env` or any file containing keys. `.gitignore` excludes `.env*` (except `.env.example`), `*.pem` and `*.key`.
  `.env.example` must contain placeholders only.
- Provider keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`), `RESEND_API_KEY`,
  `CRUNCHBASE_API_KEY`, Google service-account credentials and `API_TOKEN` are read on the server only. Use dedicated, least-privilege
  keys with spending limits, and rotate them if they may have leaked.
- Per-site integration secrets (IndexNow key, Google service account JSON, webhook secrets) are **encrypted at rest** in
  `Site.integrations` with AES-256-GCM (random IV per value, the field name bound as authenticated data) using `SECRETS_ENCRYPTION_KEY`.
  Set it in every deployment: with `NODE_ENV=production` the app refuses to store an integration secret without it. Keep the key outside
  the database and its backups (a secret manager), encrypt existing plaintext rows once with `npm run secrets:encrypt`, and rotate it with
  `SECRETS_ENCRYPTION_KEY_PREVIOUS` (see README, Configuration). API responses mask secrets down to the last four characters (values
  shorter than 16 characters and JSON credentials are fully masked); scheduled-report webhook URLs are returned as their origin only.
  Still restrict database access and use PostgreSQL with a least-privilege role in production (SQLite is intended for development).
- Visibility checks store queries, answer excerpts and source URLs as application data. Do not submit secrets or personal data as
  prompts, and apply your own retention policy to the database.
- Never paste real tokens, keys or customer data into issues, logs or pull requests.

### Operations

- Visibility batches use an in-process lock and cost bounds. Run a single replica, and add shared queues and quotas before
  multi-replica or multi-tenant use (see `docs/visibility.md`).
- Run `npm audit` and keep Node.js, Next.js, Prisma and the Python dependencies up to date.
- Monitor provider spending and outbound traffic from the host that runs the crawler.
