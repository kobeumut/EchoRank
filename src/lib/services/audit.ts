import type { CrawlSession, GeoAudit, Site } from "@prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../http";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import type { StartAuditInput } from "../validation";
import { onCrawlCompleted } from "../distribution";
import { getSiteOrThrow } from "./sites";
import { defaultAuditRunner } from "./audit-runner";

export interface AuditJob {
  site: Site;
  crawlSession: CrawlSession;
  audit: GeoAudit;
  /** Language of the text the scoring engine generates (labels, findings, action cards); English when absent. */
  locale?: Locale;
  /** Aborted when the audit is cancelled: a runner must stop its work (kill its process) when this fires. */
  signal?: AbortSignal;
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
const ACTIVE_AUDIT = ["pending", "running"];

// One controller per running audit, on globalThis so every route bundle and dev hot-reload sees the same map.
const globalControllers = globalThis as { __auditControllers?: Map<string, AbortController> };
const controllers = (globalControllers.__auditControllers ??= new Map<string, AbortController>());

/** `locale` is the language of the request (or site) that triggered the audit; it is passed on to the scoring engine as `--lang`. */
export async function startAudit(siteId: string, input: StartAuditInput, reportRunId?: string, locale: Locale = DEFAULT_LOCALE): Promise<AuditJob> {
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
    return { site, crawlSession, audit, locale };
  });
}

/** Runs the registered runner, marking the job failed on error; on success hands off to distribution. */
export async function executeAudit(job: AuditJob) {
  const fn = runner;
  if (!fn) return;
  const controller = new AbortController();
  controllers.set(job.audit.id, controller);
  try {
    try {
      await fn({ ...job, signal: controller.signal });
    } catch (err) {
      await markFailed(job, err);
      return;
    }
    // Successful crawl: announce changed URLs (IndexNow / Google). Never fails the audit itself.
    const session = await prisma.crawlSession.findUnique({ where: { id: job.crawlSession.id }, select: { status: true } });
    if (session?.status === "completed") {
      await onCrawlCompleted(job.site.id).catch((err) => console.error("distribution sync failed", err));
    }
  } finally {
    controllers.delete(job.audit.id);
  }
}

/** Only an audit that is still active can fail: a cancelled (or already finished) one keeps its state. */
async function markFailed(job: AuditJob, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.$transaction([
    prisma.crawlSession.updateMany({
      where: { id: job.crawlSession.id, status: { in: ACTIVE_CRAWL } },
      data: { status: "failed", error: message, finishedAt: new Date() },
    }),
    prisma.geoAudit.updateMany({ where: { id: job.audit.id, status: { in: ACTIVE_AUDIT } }, data: { status: "failed", error: message } }),
  ]);
}

const AUDIT_INCLUDE = {
  crawlSession: {
    select: { id: true, status: true, pagesCrawled: true, pagesFailed: true, pagesTotal: true, progress: true, stage: true, startedAt: true, finishedAt: true },
  },
  _count: { select: { actionItems: true } },
} as const;

/**
 * Cancels a queued or running audit. The state flips first (atomically, only while still active, so a
 * result that has just been ingested is never overwritten), then the runner is told to stop. A stale job
 * that no process is working on any more (server restart, no runner configured) is released the same way.
 */
export async function cancelAudit(siteId: string, auditId: string) {
  const audit = await prisma.geoAudit.findUnique({ where: { id: auditId }, select: { siteId: true, status: true, crawlSessionId: true } });
  if (!audit || audit.siteId !== siteId) throw notFound("Audit");
  const now = new Date();
  const cancelled = await prisma.$transaction(async (tx) => {
    const { count } = await tx.geoAudit.updateMany({ where: { id: auditId, status: { in: ACTIVE_AUDIT } }, data: { status: "cancelled", error: null } });
    if (!count) return false;
    if (audit.crawlSessionId) {
      await tx.crawlSession.updateMany({ where: { id: audit.crawlSessionId, status: { in: ACTIVE_CRAWL } }, data: { status: "cancelled", finishedAt: now } });
    }
    return true;
  });
  if (!cancelled) {
    const current = await prisma.geoAudit.findUnique({ where: { id: auditId }, select: { status: true } });
    throw new HttpError(409, "Audit is not running or queued", { status: current?.status });
  }
  controllers.get(auditId)?.abort();
  return prisma.geoAudit.findUniqueOrThrow({ where: { id: auditId }, include: AUDIT_INCLUDE });
}

export async function listAudits(siteId: string, limit = 20) {
  await getSiteOrThrow(siteId);
  return prisma.geoAudit.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: AUDIT_INCLUDE,
  });
}
