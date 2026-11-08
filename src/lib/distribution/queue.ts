import { createHash, randomUUID } from "node:crypto";
import type { Prisma, Site, SubmissionQueueItem } from "@prisma/client";
import { prisma } from "../db";
import { HttpError } from "../http";
import type { ChangeReason, QueueChannel } from "../constants";
import { getSiteOrThrow } from "../services/sites";
import { getDistributionSettings } from "./config";
import { normalizeForCompare } from "./content";
import { publishUrlNotification, getServiceAccount, submitSitemaps } from "./google";
import { getIndexNowKey, submitIndexNow } from "./indexnow";

// Outbound notification queue. One row per (site, url, channel); re-enqueueing a URL resets
// its row, so a product edited five times before the next dispatch is announced once.
// Dispatch claims rows with a random claimId first, so overlapping runs (cron + manual) never
// send the same row twice. Failed sends back off exponentially; 400/422-style errors fail fast.

export const MAX_ATTEMPTS = 6;
const STALE_CLAIM_MS = 10 * 60_000;
const GSC_MIN_INTERVAL_MS = 60 * 60_000;

export function backoffMs(attempts: number) {
  return Math.min(6 * 3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Channels a URL change should go to, given the site's settings. */
export function enabledChannels(site: Site): QueueChannel[] {
  const s = getDistributionSettings(site);
  if (!s.enabled) return [];
  const out: QueueChannel[] = [];
  if (s.channels.indexnow) out.push("indexnow");
  if (s.channels.googleIndexingApi) out.push("google_indexing");
  return out;
}

/** Validates that URLs belong to the site's host (IndexNow rejects foreign hosts with 422). */
export function partitionSiteUrls(site: Site, urls: string[]) {
  const host = new URL(site.url).host;
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const raw of urls) {
    try {
      const u = new URL(raw.trim());
      if ((u.protocol === "http:" || u.protocol === "https:") && u.host === host) {
        u.hash = "";
        accepted.push(u.toString());
      } else rejected.push(raw);
    } catch {
      rejected.push(raw);
    }
  }
  return { accepted: [...new Set(accepted)], rejected };
}

export interface EnqueueInput {
  url: string;
  reason: ChangeReason;
  contentHash?: string | null;
}

/** Upserts queue rows back to `pending`. Returns number of rows touched. */
export async function enqueue(siteId: string, items: EnqueueInput[], channels: QueueChannel[]) {
  let count = 0;
  for (const channel of channels) {
    for (const item of items) {
      const data = {
        reason: item.reason,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        claimId: null,
        lastError: null,
        ...(item.contentHash !== undefined && { contentHash: item.contentHash }),
      };
      await prisma.submissionQueueItem.upsert({
        where: { siteId_url_channel: { siteId, url: item.url, channel } },
        create: { siteId, url: item.url, channel, ...data },
        update: data,
      });
      count++;
    }
  }
  return count;
}

/** API entry point: explicit URL notifications (e.g. a CMS "product saved" hook). */
export async function enqueueUrls(
  siteId: string,
  input: { urls: string[]; reason: ChangeReason; channels?: QueueChannel[] },
) {
  const site = await getSiteOrThrow(siteId);
  const { accepted, rejected } = partitionSiteUrls(site, input.urls);
  if (!accepted.length) throw new HttpError(400, "No URL belongs to this site's host", { rejected });
  const channels = input.channels ?? enabledChannels(site);
  if (!channels.length) throw new HttpError(409, "No notification channel is enabled for this site");
  const queued = await enqueue(
    siteId,
    accepted.map((url) => ({ url, reason: input.reason })),
    channels,
  );
  return { queued, accepted: accepted.length, rejected, channels };
}

/** Fingerprint of what search engines care about on a page (content, status, offer data). */
export function pageFingerprint(input: {
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  wordCount: number;
  excerpt: string | null;
  offers: unknown[];
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
}

/**
 * Change detection: compares the latest crawl snapshot with what was last queued and enqueues
 * created / updated / deleted URLs. `baseline` records fingerprints without notifying anyone
 * (use it when onboarding a site whose pages are already indexed).
 */
export async function syncFromCrawl(siteId: string, opts: { mode?: "notify" | "baseline" } = {}) {
  const site = await getSiteOrThrow(siteId);
  const channels = enabledChannels(site);
  const summary = { created: 0, updated: 0, deleted: 0, unchanged: 0, ignored: 0, channels, mode: opts.mode ?? "notify" };
  if (!channels.length) return summary;

  const [pages, products, existing] = await Promise.all([
    prisma.crawledPage.findMany({ where: { siteId } }),
    prisma.graphEntity.findMany({ where: { siteId, entityType: "Product" }, select: { url: true, properties: true } }),
    prisma.submissionQueueItem.findMany({ where: { siteId, channel: { in: channels } } }),
  ]);

  const offersByUrl = new Map<string, unknown[]>();
  for (const p of products) {
    const props = (p.properties ?? {}) as Record<string, unknown>;
    const url = (typeof props.url === "string" && props.url) || p.url;
    if (!url) continue;
    const k = normalizeForCompare(url);
    offersByUrl.set(k, [...(offersByUrl.get(k) ?? []), [props.price ?? null, props.currency ?? null, props.availability ?? null]]);
  }
  const rows = new Map<string, SubmissionQueueItem>();
  for (const r of existing) rows.set(`${r.channel}|${r.url}`, r);
  const host = new URL(site.url).host;

  const changes = new Map<QueueChannel, EnqueueInput[]>(channels.map((c) => [c, []]));
  for (const page of pages) {
    if (new URL(page.url).host !== host) {
      summary.ignored++;
      continue;
    }
    const data = (page.data ?? {}) as Record<string, unknown>;
    const meta = (data.meta ?? {}) as Record<string, unknown>;
    const gone = page.statusCode === 404 || page.statusCode === 410;
    const noindex = String(meta.robots ?? "").toLowerCase().includes("noindex");
    const canonicalElsewhere = !!page.canonical && normalizeForCompare(page.canonical) !== normalizeForCompare(page.url);
    const errored = page.statusCode !== null && !gone && (page.statusCode < 200 || page.statusCode >= 300);
    const hash = pageFingerprint({
      statusCode: page.statusCode,
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1,
      canonical: page.canonical,
      wordCount: page.wordCount,
      excerpt: typeof data.text_excerpt === "string" ? data.text_excerpt : null,
      offers: offersByUrl.get(normalizeForCompare(page.url)) ?? [],
    });

    for (const channel of channels) {
      const row = rows.get(`${channel}|${page.url}`);
      let reason: ChangeReason | null = null;
      if (gone) {
        // Only announce removals of URLs we previously announced.
        if (!row) {
          summary.ignored++;
          continue;
        }
        if (row.reason !== "deleted") reason = "deleted";
      } else if (noindex || canonicalElsewhere || errored) {
        summary.ignored++;
        continue;
      } else if (!row) reason = "created";
      else if (row.contentHash !== hash || row.reason === "deleted") reason = "updated";

      if (!reason) summary.unchanged++;
      else {
        summary[reason]++;
        changes.get(channel)!.push({ url: page.url, reason, contentHash: hash });
      }
    }
  }

  for (const [channel, items] of changes) {
    if (!items.length) continue;
    if (summary.mode === "baseline") {
      for (const item of items) {
        await prisma.submissionQueueItem.upsert({
          where: { siteId_url_channel: { siteId, url: item.url, channel } },
          create: { siteId, url: item.url, channel, reason: item.reason, contentHash: item.contentHash, status: "skipped" },
          update: { reason: item.reason, contentHash: item.contentHash, status: "skipped", claimId: null },
        });
      }
    } else {
      await enqueue(siteId, items, [channel]);
    }
  }
  return summary;
}

async function finish(
  rows: SubmissionQueueItem[],
  claimId: string,
  outcome: { ok: boolean; retryable: boolean; message: string; submissionId: string | null },
) {
  const now = new Date();
  for (const row of rows) {
    const attempts = row.attempts + 1;
    const data: Prisma.SubmissionQueueItemUpdateManyMutationInput = outcome.ok
      ? { status: "sent", sentAt: now, attempts, lastError: null, claimId: null, submissionId: outcome.submissionId }
      : outcome.retryable && attempts < MAX_ATTEMPTS
        ? {
            status: "pending",
            attempts,
            lastError: outcome.message,
            claimId: null,
            submissionId: outcome.submissionId,
            nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
          }
        : { status: "failed", attempts, lastError: outcome.message, claimId: null, submissionId: outcome.submissionId };
    // Guard on claimId: if the URL was re-enqueued meanwhile, leave the fresh pending row alone.
    await prisma.submissionQueueItem.updateMany({ where: { id: row.id, claimId }, data });
  }
}

async function release(rows: SubmissionQueueItem[], claimId: string, message: string, delayMs = 0) {
  await prisma.submissionQueueItem.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, claimId },
    data: { status: "pending", claimId: null, lastError: message, nextAttemptAt: new Date(Date.now() + delayMs) },
  });
}

export interface ChannelReport {
  channel: string;
  claimed: number;
  sent: number;
  failed: number;
  deferred: number;
  message?: string;
}

/** Sends every due pending row of one site. Safe to call concurrently. */
export async function dispatchSite(siteId: string, opts: { limit?: number } = {}) {
  const site = await getSiteOrThrow(siteId);
  const settings = getDistributionSettings(site);
  const now = new Date();

  // Recover rows whose dispatcher died mid-flight.
  await prisma.submissionQueueItem.updateMany({
    where: { siteId, status: "processing", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: "pending", claimId: null },
  });

  const due = await prisma.submissionQueueItem.findMany({
    where: { siteId, status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: opts.limit ?? 10_000,
    select: { id: true },
  });
  const claimId = randomUUID();
  if (due.length) {
    await prisma.submissionQueueItem.updateMany({
      where: { id: { in: due.map((d) => d.id) }, status: "pending" },
      data: { status: "processing", claimId },
    });
  }
  const claimed = await prisma.submissionQueueItem.findMany({ where: { claimId }, orderBy: { url: "asc" } });
  const reports: ChannelReport[] = [];

  const indexnowRows = claimed.filter((r) => r.channel === "indexnow");
  if (indexnowRows.length) reports.push(await dispatchIndexNow(site, indexnowRows, claimId));
  const googleRows = claimed.filter((r) => r.channel === "google_indexing");
  if (googleRows.length) reports.push(await dispatchGoogleIndexing(site, googleRows, claimId, settings.google.indexingDailyQuota));
  const unknown = claimed.filter((r) => r.channel !== "indexnow" && r.channel !== "google_indexing");
  if (unknown.length) {
    await finish(unknown, claimId, { ok: false, retryable: false, message: "Unknown channel", submissionId: null });
  }

  const anySent = reports.some((r) => r.sent > 0);
  if (anySent && settings.enabled && settings.channels.googleSearchConsole) {
    reports.push(await maybeSubmitSitemaps(site));
  }
  return { siteId, claimed: claimed.length, channels: reports };
}

async function dispatchIndexNow(site: Site, rows: SubmissionQueueItem[], claimId: string): Promise<ChannelReport> {
  const report: ChannelReport = { channel: "indexnow", claimed: rows.length, sent: 0, failed: 0, deferred: 0 };
  const key = getIndexNowKey(site);
  if (!key) {
    // Configuration problem, not a delivery failure: keep rows pending without burning attempts.
    await release(rows, claimId, "IndexNow key is not configured", 3_600_000);
    return { ...report, deferred: rows.length, message: "IndexNow key is not configured" };
  }
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const results = await submitIndexNow(site, [...byUrl.keys()], key);
  for (const result of results) {
    const submission = await prisma.platformSubmission.create({
      data: {
        siteId: site.id,
        platform: "indexnow",
        status: result.ok ? "sent" : "failed",
        urls: result.urls,
        payload: { host: new URL(site.url).host, count: result.urls.length },
        response: { httpStatus: result.status, message: result.message },
      },
    });
    const batchRows = result.urls.map((u) => byUrl.get(u)!);
    await finish(batchRows, claimId, { ...result, submissionId: submission.id });
    if (result.ok) report.sent += batchRows.length;
    else if (result.retryable) report.deferred += batchRows.length;
    else report.failed += batchRows.length;
    if (!result.ok) report.message = result.message;
  }
  return report;
}

async function dispatchGoogleIndexing(
  site: Site,
  rows: SubmissionQueueItem[],
  claimId: string,
  dailyQuota: number,
): Promise<ChannelReport> {
  const report: ChannelReport = { channel: "google_indexing", claimed: rows.length, sent: 0, failed: 0, deferred: 0 };
  const sa = getServiceAccount(site);
  if (!sa) {
    await release(rows, claimId, "Google service account is not configured", 3_600_000);
    return { ...report, deferred: rows.length, message: "Google service account is not configured" };
  }
  const usedToday = await prisma.submissionQueueItem.count({
    where: { siteId: site.id, channel: "google_indexing", status: "sent", sentAt: { gte: new Date(Date.now() - 86_400_000) } },
  });
  const budget = Math.max(0, dailyQuota - usedToday);
  const now = rows.slice(0, budget);
  const later = rows.slice(budget);
  if (later.length) {
    await release(later, claimId, "Daily Indexing API quota reached", 3_600_000);
    report.deferred += later.length;
  }
  if (!now.length) return { ...report, message: "Daily Indexing API quota reached" };

  const results = [];
  for (const row of now) {
    results.push({ row, result: await publishUrlNotification(sa, row.url, row.reason === "deleted" ? "URL_DELETED" : "URL_UPDATED") });
  }
  const submission = await prisma.platformSubmission.create({
    data: {
      siteId: site.id,
      platform: "google_indexing",
      status: results.every((r) => r.result.ok) ? "sent" : "failed",
      urls: now.map((r) => r.url),
      response: results.map((r) => ({ url: r.row.url, httpStatus: r.result.status, message: r.result.message })),
    },
  });
  for (const { row, result } of results) {
    await finish([row], claimId, { ...result, submissionId: submission.id });
    if (result.ok) report.sent++;
    else if (result.retryable) report.deferred++;
    else report.failed++;
  }
  return report;
}

/** Search Console sitemap re-submit, at most once per hour per site. */
async function maybeSubmitSitemaps(site: Site): Promise<ChannelReport> {
  const report: ChannelReport = { channel: "google_search_console", claimed: 0, sent: 0, failed: 0, deferred: 0 };
  const sa = getServiceAccount(site);
  if (!sa) return { ...report, message: "Google service account is not configured" };
  const recent = await prisma.platformSubmission.findFirst({
    where: { siteId: site.id, platform: "google_search_console", status: "sent", createdAt: { gte: new Date(Date.now() - GSC_MIN_INTERVAL_MS) } },
  });
  if (recent) return { ...report, message: "Sitemaps submitted less than an hour ago" };
  let results;
  try {
    results = await submitSitemaps(site, sa);
  } catch (err) {
    results = [{ target: "*", ok: false, status: null, retryable: true, message: (err as Error).message }];
  }
  await prisma.platformSubmission.create({
    data: {
      siteId: site.id,
      platform: "google_search_console",
      status: results.every((r) => r.ok) ? "sent" : "failed",
      urls: results.map((r) => r.target),
      response: results.map((r) => ({ sitemap: r.target, httpStatus: r.status, message: r.message })),
    },
  });
  report.claimed = results.length;
  report.sent = results.filter((r) => r.ok).length;
  report.failed = results.length - report.sent;
  return report;
}

/** Cron entry point: dispatches every site with due rows. */
export async function dispatchAllDue() {
  const sites = await prisma.submissionQueueItem.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date() } },
    distinct: ["siteId"],
    select: { siteId: true },
  });
  const results = [];
  for (const { siteId } of sites) results.push(await dispatchSite(siteId));
  return results;
}

export async function queueStats(siteId: string) {
  const groups = await prisma.submissionQueueItem.groupBy({
    by: ["channel", "status"],
    where: { siteId },
    _count: { _all: true },
  });
  const stats: Record<string, Record<string, number>> = {};
  for (const g of groups) (stats[g.channel] ??= {})[g.status] = g._count._all;
  return stats;
}

export async function listQueue(siteId: string, opts: { status?: string; channel?: string; limit: number }) {
  await getSiteOrThrow(siteId);
  return prisma.submissionQueueItem.findMany({
    where: { siteId, ...(opts.status && { status: opts.status }), ...(opts.channel && { channel: opts.channel }) },
    orderBy: { updatedAt: "desc" },
    take: opts.limit,
  });
}
