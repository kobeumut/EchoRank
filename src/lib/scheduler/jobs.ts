import { randomUUID } from "node:crypto";
import { Prisma, type MetricSnapshot, type Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { HttpError } from "../http";
import type { JobName, JobTrigger, SnapshotKind } from "../constants";
import { runDistributionCycle } from "../distribution";
import { getDistributionSettings } from "../distribution/config";
import { getIndexNowKey, verifyKeyFile } from "../distribution/indexnow";
import { dispatchSite } from "../distribution/queue";
import { anomaliesOf, captureSnapshot } from "../monitoring/trends";
import { processDueReports, sendAnomalyAlerts } from "../reports/dispatch";
import { executeAudit, getAuditRunner, startAudit } from "../services/audit";
import { runVisibility, suggestQueries } from "../services/visibility";
import { VISIBILITY_MODELS } from "../visibility-analysis";
import { providerConfig } from "../visibility-providers";

// Scheduled jobs (GENE-99). Every run is logged in JobRun and guarded by a JobLock lease, so cron,
// the CLI and the HTTP trigger can overlap safely (also across processes / replicas).
//
//   daily        quick check: LLM visibility for every site + IndexNow key check & queue flush,
//                then a daily trend snapshot and anomaly alerts.
//   weekly       full check: crawl -> knowledge graph -> GEO/SEO/E-E-A-T scoring (audit runner),
//                then a weekly trend snapshot and anomaly alerts.
//   reports      sends due scheduled reports (e-mail / webhooks).
//   distribution flushes the IndexNow / Google queue and due syndication webhooks for all sites.
//   snapshot     records a manual trend snapshot for every site (no external calls).

const LEASE_MS: Record<JobName, number> = {
  daily: 3 * 3_600_000,
  weekly: 12 * 3_600_000,
  reports: 3_600_000,
  distribution: 30 * 60_000,
  snapshot: 30 * 60_000,
};

/** Per-site opt-outs under `Site.settings.monitoring`. */
export const monitoringSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Daily paid LLM visibility checks. */
    dailyVisibility: z.boolean().default(true),
    /** Weekly full crawl + scoring audit. */
    weeklyAudit: z.boolean().default(true),
  })
  .prefault({});

export function getMonitoringSettings(site: Pick<Site, "settings">) {
  const raw = site.settings && typeof site.settings === "object" && !Array.isArray(site.settings) ? (site.settings as Record<string, unknown>).monitoring : undefined;
  const parsed = monitoringSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : monitoringSettingsSchema.parse({});
}

export class JobBusyError extends HttpError {
  constructor(job: string, until: Date) {
    super(409, `Job "${job}" is already running`, { lockedUntil: until.toISOString() });
  }
}

export interface JobOptions {
  trigger?: JobTrigger;
  dryRun?: boolean;
  siteId?: string;
  now?: Date;
}

type StepStatus = "ok" | "skipped" | "failed";
interface Step {
  status: StepStatus;
  detail?: unknown;
}
type SiteResult = { siteId: string; url: string; steps: Record<string, Step> };

async function acquireLock(job: JobName, runId: string, now: Date) {
  const expiresAt = new Date(now.getTime() + LEASE_MS[job]);
  try {
    await prisma.jobLock.create({ data: { job, runId, expiresAt } });
    return;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  // Take over an expired lease (a crashed worker) with compare-and-set.
  const taken = await prisma.jobLock.updateMany({ where: { job, expiresAt: { lt: now } }, data: { runId, expiresAt } });
  if (taken.count === 1) return;
  const lock = await prisma.jobLock.findUnique({ where: { job } });
  throw new JobBusyError(job, lock?.expiresAt ?? expiresAt);
}

async function releaseLock(job: JobName, runId: string) {
  await prisma.jobLock.deleteMany({ where: { job, runId } });
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function step(fn: () => Promise<Step | unknown>): Promise<Step> {
  try {
    const out = await fn();
    return out && typeof out === "object" && "status" in out ? (out as Step) : { status: "ok", detail: out };
  } catch (err) {
    return { status: "failed", detail: errMsg(err) };
  }
}

async function targetSites(siteId?: string) {
  const sites = await prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { createdAt: "asc" } });
  if (siteId && !sites.length) throw new HttpError(404, "Site not found");
  return sites;
}

function configuredModels() {
  return VISIBILITY_MODELS.filter((m) => {
    try {
      providerConfig(m);
      return true;
    } catch {
      return false;
    }
  });
}

async function snapshotAndAlert(site: Site, kind: SnapshotKind, now: Date, dryRun: boolean): Promise<Record<string, Step>> {
  const ref: { row?: MetricSnapshot } = {};
  const snapshot = await step(async () => {
    const s = (ref.row = await captureSnapshot(site.id, { kind, now }));
    return { status: "ok", detail: { id: s.id, geoScore: s.geoScore, visibilityRate: s.visibilityRate, anomalies: anomaliesOf(s) } };
  });
  const row = ref.row;
  const alerts: Step = row
    ? await step(async () => {
        const res = await sendAnomalyAlerts(site, row, { dryRun });
        return { status: res.status === "failed" ? "failed" : "ok", detail: res };
      })
    : { status: "skipped", detail: "no snapshot" };
  return { snapshot, alerts };
}

async function dailySite(site: Site, now: Date, dryRun: boolean): Promise<SiteResult> {
  const monitoring = getMonitoringSettings(site);
  const steps: Record<string, Step> = {};

  steps.visibility = await step(async () => {
    if (!monitoring.dailyVisibility) return { status: "skipped", detail: "disabled in site settings (monitoring.dailyVisibility)" };
    const models = configuredModels();
    if (!models.length) return { status: "skipped", detail: "no LLM provider configured (see .env.example)" };
    const queries = await suggestQueries(site.id);
    if (!queries.length) return { status: "skipped", detail: "no queries: set targetKeywords or run an audit first" };
    if (dryRun) return { status: "skipped", detail: `dry run: would check ${queries.length} queries x ${models.length} models` };
    // refresh: a 24h cache would otherwise swallow a check that runs at the same time every day.
    const res = await runVisibility(site.id, { models, refresh: true });
    return { status: res.successful ? "ok" : "failed", detail: { attempted: res.attempted, successful: res.successful, failed: res.failed, citationRate: res.citationRate } };
  });

  steps.indexnow = await step(async () => {
    const distribution = getDistributionSettings(site);
    if (!distribution.enabled || !distribution.channels.indexnow) return { status: "skipped", detail: "IndexNow channel disabled" };
    const key = getIndexNowKey(site);
    if (!key) return { status: "skipped", detail: "IndexNow key not configured" };
    if (dryRun) return { status: "skipped", detail: "dry run: key file check and queue flush skipped" };
    const keyFile = await verifyKeyFile(site, key);
    const dispatch = await dispatchSite(site.id);
    return { status: keyFile.valid ? "ok" : "failed", detail: { keyFile, dispatch } };
  });

  Object.assign(steps, await snapshotAndAlert(site, "daily", now, dryRun));
  return { siteId: site.id, url: site.url, steps };
}

async function weeklySite(site: Site, now: Date, dryRun: boolean): Promise<SiteResult> {
  const monitoring = getMonitoringSettings(site);
  const steps: Record<string, Step> = {};
  steps.audit = await step(async () => {
    if (!monitoring.weeklyAudit) return { status: "skipped", detail: "disabled in site settings (monitoring.weeklyAudit)" };
    if (dryRun) return { status: "skipped", detail: "dry run: full crawl / scoring skipped" };
    let job;
    try {
      job = await startAudit(site.id, { trigger: "scheduled" });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return { status: "skipped", detail: "an audit is already in progress" };
      throw err;
    }
    if (!getAuditRunner()) {
      return { status: "ok", detail: { auditId: job.audit.id, execution: "queued", note: "GEO_AUDIT_BIN not set: waiting for an external worker" } };
    }
    await executeAudit(job);
    const audit = await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id }, select: { status: true, geoScore: true, seoScore: true, eeatScore: true, error: true } });
    return { status: audit.status === "failed" ? "failed" : "ok", detail: { auditId: job.audit.id, ...audit } };
  });
  Object.assign(steps, await snapshotAndAlert(site, "weekly", now, dryRun));
  return { siteId: site.id, url: site.url, steps };
}

async function perSite(sites: Site[], fn: (site: Site) => Promise<SiteResult>) {
  const results: SiteResult[] = [];
  for (const site of sites) {
    try {
      results.push(await fn(site));
    } catch (err) {
      results.push({ siteId: site.id, url: site.url, steps: { error: { status: "failed", detail: errMsg(err) } } });
    }
  }
  return results;
}

const JOBS: Record<JobName, (o: Required<Pick<JobOptions, "dryRun">> & { now: Date; siteId?: string }) => Promise<unknown>> = {
  daily: async ({ now, dryRun, siteId }) => ({ sites: await perSite(await targetSites(siteId), (s) => dailySite(s, now, dryRun)) }),
  weekly: async ({ now, dryRun, siteId }) => ({ sites: await perSite(await targetSites(siteId), (s) => weeklySite(s, now, dryRun)) }),
  reports: async ({ now, dryRun, siteId }) => processDueReports({ now, dryRun, siteId }),
  distribution: async ({ now, dryRun }) => (dryRun ? { skipped: "dry run" } : runDistributionCycle(now)),
  snapshot: async ({ now, siteId }) => ({
    sites: await perSite(await targetSites(siteId), async (site) => {
      const s = await captureSnapshot(site.id, { kind: "manual", now });
      return { siteId: site.id, url: site.url, steps: { snapshot: { status: "ok", detail: { id: s.id, anomalies: anomaliesOf(s) } } } };
    }),
  }),
};

/** Collects every failed step / delivery so the run can be marked partial. */
function countFailures(summary: unknown): { failed: number; total: number } {
  let failed = 0;
  let total = 0;
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (typeof o.status === "string" && ["ok", "failed", "sent", "partial", "simulated"].includes(o.status)) {
      total++;
      if (o.status === "failed" || o.status === "partial") failed++;
    }
    Object.values(o).forEach(visit);
  };
  visit(summary);
  return { failed, total };
}

/** Runs a job synchronously and returns its JobRun row (status completed | partial | failed). */
export async function runJob(job: JobName, opts: JobOptions = {}) {
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun || process.env.REPORTS_DRY_RUN === "true";
  const run = await prisma.jobRun.create({ data: { job, trigger: opts.trigger ?? "manual", dryRun, startedAt: now } });
  const lockId = randomUUID();
  try {
    await acquireLock(job, lockId, new Date());
  } catch (err) {
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "skipped", error: errMsg(err), finishedAt: new Date() } });
    throw err;
  }
  try {
    const summary = await JOBS[job]({ now, dryRun, siteId: opts.siteId });
    const { failed } = countFailures(summary);
    return await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: failed ? "partial" : "completed", summary: summary as Prisma.InputJsonValue, finishedAt: new Date() },
    });
  } catch (err) {
    return await prisma.jobRun.update({ where: { id: run.id }, data: { status: "failed", error: errMsg(err), finishedAt: new Date() } });
  } finally {
    await releaseLock(job, lockId);
  }
}

export async function listJobRuns(opts: { job?: JobName; limit: number }) {
  return prisma.jobRun.findMany({ where: opts.job ? { job: opts.job } : {}, orderBy: { startedAt: "desc" }, take: opts.limit });
}
