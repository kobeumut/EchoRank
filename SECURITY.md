# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull requests or discussions.**

Use GitHub's private vulnerability reporting instead:

1. Open the repository at https://github.com/kobeumut/ai-visibility.
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

AI Visibility is a single-tenant tool for operators. Its defaults are meant for local development, so review the
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
- The dashboard session cookie (`aiv_session`) contains a SHA-256 digest derived from the token, so rotating `API_TOKEN` invalidates
  all sessions. The cookie is `HttpOnly` and `SameSite=Strict`, and `Secure` when `NODE_ENV=production`: serve the app **only over HTTPS**
  (terminate TLS in a reverse proxy) and run it with `NODE_ENV=production`.
- There is no built-in rate limiting or lockout on `/api/auth` or any other route. Add rate limiting at the reverse proxy / WAF.
- The app does not set security headers such as `Content-Security-Policy`, `Strict-Transport-Security` or `X-Frame-Options`.
  Set them at the reverse proxy.
- Restrict `/api/distribution/run` (the cron hook) and the other state-changing routes at the network level as well, and call
  them only with the bearer token.

### Outbound requests and SSRF

The platform makes requests to URLs that users supply: sites to crawl, webhooks, IndexNow key files and report targets.

- Keep `ALLOW_PRIVATE_NETWORK_TARGETS` unset or `false` in production. When it is `false`, syndication / "Apply to CMS" webhooks, IndexNow
  key verification and the persisted bot simulation (`/simulation/bots`) refuse targets that resolve to loopback, private, link-local
  or other internal addresses. Scheduled-report webhooks are always restricted to public addresses with a DNS-pinned connection,
  must use HTTPS, and do not follow redirects.
- **Known limitation:** the Python crawler (started through `GEO_AUDIT_BIN`) and the on-demand `POST /api/sites/:id/bot-simulator`
  fetch the site URLs that an authenticated caller registers and do not apply this private-network guard. Treat site registration as a
  privileged action and run the application where it cannot reach internal services: use egress filtering, block cloud metadata endpoints
  (for example `169.254.169.254`), and keep databases and admin interfaces on networks the app host cannot reach.
- `GEO_AUDIT_BIN` and `GEO_AUDIT_ARGS` are executed with `execFile` (no shell) and must only be set by the operator.
  Run the audit engine as an unprivileged user, preferably in a container with limited network access.

### Secrets and data

- Never commit `.env` or any file containing keys. `.gitignore` excludes `.env*` (except `.env.example`), `*.pem` and `*.key`.
  `.env.example` must contain placeholders only.
- Provider keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`), `RESEND_API_KEY`,
  `CRUNCHBASE_API_KEY`, Google service-account credentials and `API_TOKEN` are read on the server only. Use dedicated, least-privilege
  keys with spending limits, and rotate them if they may have leaked.
- Per-site integration secrets (IndexNow key, Google service account JSON, webhook secrets) are stored **unencrypted** in the database
  (`Site.integrations`) and masked in API responses. Restrict database access, encrypt storage and backups, and use PostgreSQL with a
  least-privilege role in production (SQLite is intended for development).
- Visibility checks store queries, answer excerpts and source URLs as application data. Do not submit secrets or personal data as
  prompts, and apply your own retention policy to the database.
- Never paste real tokens, keys or customer data into issues, logs or pull requests.

### Operations

- Visibility batches use an in-process lock and cost bounds. Run a single replica, and add shared queues and quotas before
  multi-replica or multi-tenant use (see `docs/visibility.md`).
- Run `npm audit` and keep Node.js, Next.js, Prisma and the Python dependencies up to date.
- Monitor provider spending and outbound traffic from the host that runs the crawler.
