import type { CrawlSession, GeoAudit, Site } from "@prisma/client";
import { prisma } from "../db";
import { HttpError } from "../http";
import type { StartAuditInput } from "../validation";
import { onCrawlCompleted } from "../distribution";
import { getSiteOrThrow } from "./sites";
import { defaultAuditRunner } from "./audit-runner";

export interface AuditJob {
  site: Site;
  crawlSession: CrawlSession;
  audit: GeoAudit;
}

/**
 * Pluggable executor for an audit job (crawl -> graph -> scoring -> actions).
 * Registered by the crawler / scoring modules. When nothing is registered the
 * job stays `queued` so an external worker can pick it up.
 */
export type AuditRunner = (job: AuditJob) => Promise<void>;

// Default: the `geo-audit` CLI runner when GEO_AUDIT_BIN is set (see audit-runner.ts), else none.
let runner: AuditRunner | null = defaultAuditRunner();
export function registerAuditRunner(fn: AuditRunner | null) {
  runner = fn;
}
export function getAuditRunner() {
  return runner;
}

const ACTIVE_CRAWL = ["queued", "running"];

export async function startAudit(siteId: string, input: StartAuditInput, reportRunId?: string): Promise<AuditJob> {
  const site = await getSiteOrThrow(siteId);
  const settings = (site.settings ?? {}) as { maxPages?: number; maxDepth?: number };

  return prisma.$transaction(async (tx) => {
    const active = await tx.crawlSession.findFirst({
      where: { siteId, status: { in: ACTIVE_CRAWL } },
      select: { id: true, status: true },
    });
    if (active) throw new HttpError(409, "An audit is already in progress for this site", active);

    const crawlSession = await tx.crawlSession.create({
      data: {
        siteId,
        trigger: input.trigger,
        maxPages: input.maxPages ?? settings.maxPages ?? Number(process.env.CRAWLER_MAX_PAGES ?? 500),
        maxDepth: input.maxDepth ?? settings.maxDepth ?? 5,
      },
    });
    const audit = await tx.geoAudit.create({
      data: { siteId, crawlSessionId: crawlSession.id },
    });
    // Link ownership atomically: a crashed report can recover its crawl without touching manual jobs.
    if (reportRunId) await tx.reportRun.update({ where: { id: reportRunId }, data: { auditId: audit.id, crawlSessionId: crawlSession.id } });
    return { site, crawlSession, audit };
  });
}

/** Runs the registered runner, marking the job failed on error; on success hands off to distribution. */
export async function executeAudit(job: AuditJob) {
  const fn = runner;
  if (!fn) return;
  try {
    await fn(job);
  } catch (err) {
    await markFailed(job, err);
    return;
  }
  // Successful crawl: announce changed URLs (IndexNow / Google). Never fails the audit itself.
  const session = await prisma.crawlSession.findUnique({ where: { id: job.crawlSession.id }, select: { status: true } });
  if (session?.status === "completed") {
    await onCrawlCompleted(job.site.id).catch((err) => console.error("distribution sync failed", err));
  }
}

async function markFailed(job: AuditJob, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.$transaction([
    prisma.crawlSession.update({
      where: { id: job.crawlSession.id },
      data: { status: "failed", error: message, finishedAt: new Date() },
    }),
    prisma.geoAudit.update({ where: { id: job.audit.id }, data: { status: "failed", error: message } }),
  ]);
}

export async function listAudits(siteId: string, limit = 20) {
  await getSiteOrThrow(siteId);
  return prisma.geoAudit.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      crawlSession: {
        select: { id: true, status: true, pagesCrawled: true, pagesFailed: true, startedAt: true, finishedAt: true },
      },
      _count: { select: { actionItems: true } },
    },
  });
}
