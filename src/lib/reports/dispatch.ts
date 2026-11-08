import type { MetricSnapshot, Prisma, ScheduledReport, Site } from "@prisma/client";
import { prisma } from "../db";
import type { ReportFrequency } from "../constants";
import { getIntegration, INTEGRATION_KEYS } from "../distribution/config";
import { anomaliesOf } from "../monitoring/trends";
import { sendEmail } from "../notify/email";
import { deliverWebhook, detectWebhookType, type NotificationEvent, type WebhookTarget } from "../notify/webhook";
import { computeNextRun } from "../services/reports";
import { getSiteOrThrow } from "../services/sites";
import { buildPeriodicReport, type PeriodicReport } from "./builder";
import { alertSubject, renderAlertHtml, renderAlertText, renderReportHtml, renderReportText, reportSubject, type AlertContent } from "./html";
import { renderReportPdf } from "./pdf";

// Delivery of scheduled reports and anomaly alerts over e-mail and webhooks.
// Every attempt is logged as a ReportDelivery row; a target that already received a period is
// skipped on re-runs (so retrying a partial failure only re-sends the failed targets).

export type DeliveryStatus = "sent" | "failed" | "simulated" | "skipped";
export type RunStatus = "sent" | "partial" | "failed" | "simulated" | "skipped";

export interface DeliveryOutcome {
  channel: "email" | "webhook";
  target: string;
  status: DeliveryStatus;
  detail: string;
  deliveryId?: string;
}

export function scheduleChannels(s: Pick<ScheduledReport, "recipients" | "webhooks">) {
  const recipients = Array.isArray(s.recipients) ? s.recipients.filter((r): r is string => typeof r === "string") : [];
  const webhooks = Array.isArray(s.webhooks)
    ? (s.webhooks as unknown[]).filter((w): w is WebhookTarget => !!w && typeof w === "object" && typeof (w as WebhookTarget).url === "string")
    : [];
  return { recipients, webhooks };
}

/** Absolute links to the online report when APP_BASE_URL is configured. */
export function reportLinks(siteId: string, frequency: ReportFrequency) {
  const base = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return { html: null, pdf: null };
  const path = `${base}/api/sites/${encodeURIComponent(siteId)}/reports/summary?frequency=${frequency}`;
  return { html: `${path}&format=html`, pdf: `${path}&format=pdf&download=1` };
}

export function reportFilename(r: PeriodicReport, ext: "pdf" | "html") {
  const host = new URL(r.site.url).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "-");
  return `ai-gorunurluk-${r.frequency === "weekly" ? "haftalik" : "gunluk"}-${host}-${r.period.end.slice(0, 10)}.${ext}`;
}

export function summarizeStatuses(outcomes: Pick<DeliveryOutcome, "status">[]): RunStatus {
  const attempted = outcomes.filter((o) => o.status !== "skipped");
  if (!attempted.length) return "skipped";
  const failed = attempted.filter((o) => o.status === "failed").length;
  if (failed === attempted.length) return "failed";
  if (failed) return "partial";
  return attempted.every((o) => o.status === "simulated") ? "simulated" : "sent";
}

async function alreadyDelivered(scheduleId: string | null, periodKey: string, channel: string, target: string) {
  const hit = await prisma.reportDelivery.findFirst({
    where: { scheduleId, periodKey, channel, target, status: "sent" },
    select: { id: true },
  });
  return !!hit;
}

async function record(data: {
  siteId: string;
  scheduleId: string | null;
  kind: "report" | "alert";
  channel: "email" | "webhook";
  target: string;
  status: DeliveryStatus;
  subject: string;
  periodKey: string;
  error?: string | null;
  response?: Prisma.InputJsonValue;
}) {
  return prisma.reportDelivery.create({ data: { ...data, error: data.error ?? null } });
}

/** Builds the report once and fans it out to the schedule's e-mail recipients and webhooks. */
export async function sendScheduledReport(
  scheduleId: string,
  opts: { now?: Date; dryRun?: boolean; force?: boolean } = {},
) {
  const schedule = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: scheduleId } });
  const site = await getSiteOrThrow(schedule.siteId);
  const frequency = schedule.frequency as ReportFrequency;
  const report = await buildPeriodicReport(site.id, frequency, opts.now ?? new Date());
  const links = reportLinks(site.id, frequency);
  const { recipients, webhooks } = scheduleChannels(schedule);
  const subject = reportSubject(report);
  const outcomes: DeliveryOutcome[] = [];

  // Render lazily: a re-run where every target was already served renders nothing.
  let rendered: { html: string; text: string; pdf: Buffer } | null = null;
  const render = () =>
    (rendered ??= {
      html: renderReportHtml(report, { reportUrl: links.html, pdfUrl: links.pdf }),
      text: renderReportText(report, { reportUrl: links.html, pdfUrl: links.pdf }),
      pdf: renderReportPdf(report),
    });

  for (const to of recipients) {
    if (!opts.force && !opts.dryRun && (await alreadyDelivered(schedule.id, report.periodKey, "email", to))) {
      outcomes.push({ channel: "email", target: to, status: "skipped", detail: "Already delivered for this period" });
      continue;
    }
    const r = render();
    const res = await sendEmail(
      {
        to,
        subject,
        html: r.html,
        text: r.text,
        attachments: [{ filename: reportFilename(report, "pdf"), content: r.pdf, contentType: "application/pdf" }],
      },
      { dryRun: opts.dryRun },
    );
    const row = await record({
      siteId: site.id,
      scheduleId: schedule.id,
      kind: "report",
      channel: "email",
      target: to,
      status: res.status,
      subject,
      periodKey: report.periodKey,
      error: res.error,
      response: { provider: res.provider, messageId: res.messageId ?? null, pdfBytes: r.pdf.length },
    });
    outcomes.push({ channel: "email", target: to, status: res.status, detail: res.error ?? `${res.provider}${res.messageId ? ` ${res.messageId}` : ""}`, deliveryId: row.id });
  }

  const secret = getIntegration(site, INTEGRATION_KEYS.webhookSecret);
  const event: NotificationEvent = { event: frequency === "weekly" ? "report.weekly" : "report.daily", report, links };
  for (const hook of webhooks) {
    if (!opts.force && !opts.dryRun && (await alreadyDelivered(schedule.id, report.periodKey, "webhook", hook.url))) {
      outcomes.push({ channel: "webhook", target: hook.url, status: "skipped", detail: "Already delivered for this period" });
      continue;
    }
    const res = await deliverWebhook(hook, event, { secret, dryRun: opts.dryRun });
    const row = await record({
      siteId: site.id,
      scheduleId: schedule.id,
      kind: "report",
      channel: "webhook",
      target: hook.url,
      status: res.status,
      subject,
      periodKey: report.periodKey,
      error: res.status === "failed" ? res.message : null,
      response: { type: res.type, httpStatus: res.httpStatus, message: res.message },
    });
    outcomes.push({ channel: "webhook", target: hook.url, status: res.status, detail: `${res.type}: ${res.message}`, deliveryId: row.id });
  }

  const status = summarizeStatuses(outcomes);
  if (status !== "skipped") {
    await prisma.scheduledReport.update({
      where: { id: schedule.id },
      data: {
        lastStatus: status,
        lastError: outcomes.find((o) => o.status === "failed")?.detail ?? null,
        ...(!opts.dryRun && { lastRunAt: opts.now ?? new Date() }),
      },
    });
  }
  return {
    scheduleId: schedule.id,
    siteId: site.id,
    frequency,
    periodKey: report.periodKey,
    headline: report.headline.text,
    status,
    dryRun: !!opts.dryRun,
    deliveries: outcomes,
  };
}

/**
 * Sends every enabled schedule whose nextRunAt has passed. Each schedule is claimed by moving
 * nextRunAt forward with a compare-and-set, so overlapping workers never send it twice.
 * Dry runs leave the schedule untouched.
 */
export async function processDueReports(opts: { now?: Date; dryRun?: boolean; siteId?: string; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await prisma.scheduledReport.findMany({
    where: { enabled: true, nextRunAt: { lte: now }, ...(opts.siteId && { siteId: opts.siteId }) },
    orderBy: { nextRunAt: "asc" },
    take: opts.limit ?? 200,
  });
  const results: Array<Awaited<ReturnType<typeof sendScheduledReport>> | { scheduleId: string; siteId: string; status: "failed" | "claimed_elsewhere"; error?: string }> = [];
  for (const s of due) {
    if (!opts.dryRun) {
      const claim = await prisma.scheduledReport.updateMany({
        where: { id: s.id, nextRunAt: s.nextRunAt },
        data: { nextRunAt: computeNextRun(s.frequency as ReportFrequency, now), lastRunAt: now },
      });
      if (claim.count !== 1) {
        results.push({ scheduleId: s.id, siteId: s.siteId, status: "claimed_elsewhere" });
        continue;
      }
    }
    try {
      results.push(await sendScheduledReport(s.id, { now, dryRun: opts.dryRun }));
    } catch (err) {
      const error = (err as Error).message;
      await prisma.scheduledReport.update({ where: { id: s.id }, data: { lastStatus: "failed", lastError: error.slice(0, 500) } }).catch(() => {});
      results.push({ scheduleId: s.id, siteId: s.siteId, status: "failed", error });
    }
  }
  return { due: due.length, results };
}

/**
 * Pushes the anomalies of a fresh snapshot to every channel of the site's alert-enabled schedules
 * (each target once). A snapshot alerts at most once (alertedAt compare-and-set).
 */
export async function sendAnomalyAlerts(site: Pick<Site, "id" | "url" | "title" | "integrations">, snapshot: MetricSnapshot, opts: { dryRun?: boolean } = {}) {
  const anomalies = anomaliesOf(snapshot);
  if (!anomalies.length) return { status: "none" as const, deliveries: [] as DeliveryOutcome[] };
  const schedules = await prisma.scheduledReport.findMany({ where: { siteId: site.id, enabled: true, alerts: true }, orderBy: { createdAt: "asc" } });
  if (!schedules.length) return { status: "no_channels" as const, deliveries: [] as DeliveryOutcome[] };
  if (!opts.dryRun) {
    const claim = await prisma.metricSnapshot.updateMany({ where: { id: snapshot.id, alertedAt: null }, data: { alertedAt: new Date() } });
    if (claim.count !== 1) return { status: "already_alerted" as const, deliveries: [] as DeliveryOutcome[] };
  }

  const alert: AlertContent = { site: { id: site.id, url: site.url, title: site.title }, anomalies, detectedAt: snapshot.capturedAt.toISOString() };
  const links = reportLinks(site.id, "weekly");
  const subject = alertSubject(alert);
  const html = renderAlertHtml(alert, { reportUrl: links.html });
  const text = renderAlertText(alert);
  const periodKey = `alert:${snapshot.id}`;
  const secret = getIntegration(site, INTEGRATION_KEYS.webhookSecret);
  const outcomes: DeliveryOutcome[] = [];
  const seen = new Set<string>();

  for (const schedule of schedules) {
    const { recipients, webhooks } = scheduleChannels(schedule);
    for (const to of recipients) {
      if (seen.has(`email|${to}`)) continue;
      seen.add(`email|${to}`);
      const res = await sendEmail({ to, subject, html, text }, { dryRun: opts.dryRun });
      const row = await record({
        siteId: site.id, scheduleId: schedule.id, kind: "alert", channel: "email", target: to, status: res.status, subject, periodKey,
        error: res.error, response: { provider: res.provider, messageId: res.messageId ?? null },
      });
      outcomes.push({ channel: "email", target: to, status: res.status, detail: res.error ?? res.provider, deliveryId: row.id });
    }
    for (const hook of webhooks) {
      if (seen.has(`webhook|${hook.url}`)) continue;
      seen.add(`webhook|${hook.url}`);
      const res = await deliverWebhook(hook, { event: "anomaly.detected", alert, links: { html: links.html } }, { secret, dryRun: opts.dryRun });
      const row = await record({
        siteId: site.id, scheduleId: schedule.id, kind: "alert", channel: "webhook", target: hook.url, status: res.status, subject, periodKey,
        error: res.status === "failed" ? res.message : null, response: { type: detectWebhookType(hook), httpStatus: res.httpStatus, message: res.message },
      });
      outcomes.push({ channel: "webhook", target: hook.url, status: res.status, detail: `${res.type}: ${res.message}`, deliveryId: row.id });
    }
  }
  return { status: summarizeStatuses(outcomes), deliveries: outcomes };
}

export async function listDeliveries(siteId: string, limit = 50) {
  await getSiteOrThrow(siteId);
  return prisma.reportDelivery.findMany({ where: { siteId }, orderBy: { createdAt: "desc" }, take: limit });
}
