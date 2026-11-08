# Scheduled jobs, trends, reports & notifications (GENE-99)

Background monitoring keeps every site's GEO / SEO / LLM-visibility picture up to date, records it as a
time series, detects regressions and delivers daily / weekly executive reports by e-mail and webhooks.

## Jobs

| Job | Default cron (UTC) | What it does |
| --- | --- | --- |
| `daily` | `0 5 * * *` | Quick check per site: LLM visibility for the site's queries on every configured provider (`refresh: true`), IndexNow key-file check + queue flush, then a **daily snapshot** and anomaly alerts |
| `weekly` | `0 2 * * 1` | Full check per site: scheduled audit (crawl → knowledge graph → GEO/SEO/E-E-A-T scoring via `GEO_AUDIT_BIN`; queued for an external worker when unset), then a **weekly snapshot** and anomaly alerts |
| `reports` | `*/15 * * * *` | Sends every enabled `ScheduledReport` whose `nextRunAt` has passed (06:00 UTC daily, Monday 06:00 UTC weekly) |
| `distribution` | `*/10 * * * *` | `runDistributionCycle()` — IndexNow / Google queues and syndication webhooks for all sites |
| `snapshot` | off | Manual trend snapshot for every site (no external calls) |

Each run is written to `JobRun` (status `completed`, `partial` = some site step or delivery failed, `failed`,
`skipped` = already running). A `JobLock` lease (3 h daily, 12 h weekly, 1 h reports) prevents the same job from
running twice at once — across the cron worker, the CLI and the HTTP trigger, and across replicas. A crashed
worker's lease is taken over once it expires.

Per-site opt-outs live in `Site.settings.monitoring`: `{ "enabled": true, "dailyVisibility": true, "weeklyAudit": true }`.

### Running

```bash
npm run scheduler                         # long-running node-cron worker (Ctrl+C / SIGTERM to stop)
npm run jobs -- run daily --dry-run       # manual trigger; --dry-run makes no paid calls and sends nothing
npm run jobs -- run weekly --site <siteId>
npm run jobs -- run reports
npm run jobs -- list                      # recent JobRun rows
npm run jobs -- schedules                 # effective cron expressions
npm run jobs -- preview <siteId> --frequency weekly --out ./reports   # writes HTML + PDF + JSON
npm run jobs -- send <scheduleId> [--dry-run] [--force]
```

Without a long-running worker (serverless, Kubernetes CronJob, system cron) set the `CRON_*` variables to `off`
and call the HTTP trigger instead:

```bash
curl -X POST https://app.example.com/api/jobs/run \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"job":"daily"}'
```

Real runs need `API_TOKEN` (they make paid LLM calls and send e-mail); `{"dryRun": true}` runs don't.

## Trends & anomaly detection

`MetricSnapshot` stores GEO / SEO / E-E-A-T (information trust) scores, visibility & citation rates, cited /
mentioned counts, per-model stats, top competitor domains and open / critical action counts. Visibility figures
cover the snapshot window (1 day for daily, 7 days for weekly/manual).

A new snapshot is compared with the last snapshots **of the same kind**:

| Anomaly | Rule |
| --- | --- |
| `score_drop` | score fell ≥ 8 points vs the previous snapshot (≥ 15 → high), or z-score ≤ −2.5 vs the last ≤ 8 points (≥ 4 points of history) |
| `visibility_drop` / `citation_drop` | rate fell ≥ 15 points (≥ 30 → high), or halved from ≥ 20 % (high). Both windows need ≥ 4 LLM answers |
| `competitor_surge` | a competitor domain's share of answers grew ≥ 20 points with ≥ 3 citations (≥ 35 → high) |

When a snapshot has anomalies, an alert is pushed once to every channel of the site's enabled schedules with
`alerts: true` (event `anomaly.detected`).

## Reports

`GET /api/sites/:id/reports/summary?frequency=weekly&format=json|html|pdf|text[&download=1]`

* **Headline** — "Bu hafta yapay zeka aramalarındaki görünürlüğünüz %X arttı/azaldı (%A → %B)": relative change
  of the visibility rate vs the previous period of the same length.
* **Yönetici Özeti** — scores and deltas, citations, best / weakest model, top competitor, anomalies, action status.
* **Actions** — resolved in the period, and pending critical (high / medium impact) ordered by impact and priority.
* Per-model visibility, top competitors, score trend (last 8 weeks / 14 days).

The HTML is e-mail safe (tables + inline styles, no scripts / SVG / external assets). The PDF is generated without
dependencies (core Helvetica with a Windows-1254 encoding, so Turkish characters render in every viewer).

### Schedules & channels

```http
POST /api/sites/:id/reports/schedules
{ "frequency": "weekly", "recipients": ["ceo@example.com"],
  "webhooks": [{ "url": "https://hooks.slack.com/services/..." },
               { "url": "https://discord.com/api/webhooks/..." },
               { "url": "https://example.com/hooks/aiv", "type": "generic" }],
  "alerts": true }
```

| Endpoint | |
| --- | --- |
| `GET/PATCH/DELETE /api/sites/:id/reports/schedules/:scheduleId` | read / partial update (frequency or enabled changes re-plan `nextRunAt`) / delete |
| `POST /api/sites/:id/reports/schedules/:scheduleId/send` | send now `{ dryRun?, force? }` (does not move `nextRunAt`) |
| `GET /api/sites/:id/reports/deliveries` | delivery log (`ReportDelivery`) |
| `GET/POST /api/sites/:id/trends?days=90&kind=weekly` | time series + anomalies / record a manual snapshot |
| `GET /api/jobs?job=&limit=` · `POST /api/jobs/run` | job history and configured cron · trigger a job |

* **E-mail**: one message per recipient (addresses are not disclosed to each other) with the HTML body, a text
  alternative and the PDF attached. `EMAIL_PROVIDER=auto` picks Resend → SendGrid → SMTP; with nothing configured
  deliveries are **simulated** (logged, status `simulated`).
* **Webhooks**: Slack Block Kit and Discord embeds are detected from the URL; other URLs receive the full JSON report
  signed like syndication webhooks (`X-AIV-Signature: sha256=HMAC(webhookSecret, "<timestamp>.<body>")`). Private
  network targets are refused unless `ALLOW_PRIVATE_NETWORK_TARGETS=true`.
* **Idempotency**: a schedule is claimed by moving `nextRunAt` with a compare-and-set; a target that already
  received a period (`periodKey`, e.g. `weekly:2026-11-09`) is skipped, so re-sending after a partial failure only
  retries the failed targets. Dry-run / simulated deliveries never block a real send.

### Simulating delivery

* `REPORTS_DRY_RUN=true` (or `--dry-run` / `{"dryRun": true}`) — every channel is simulated, nothing leaves the server.
* `EMAIL_PROVIDER=log` — e-mails are simulated while webhooks are sent.
* Tests replace the transport with `setEmailTransport()` and stub `fetch` (`tests/scheduler-reports.test.ts`).
