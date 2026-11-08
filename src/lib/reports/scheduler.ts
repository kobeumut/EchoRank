import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { executeAudit, getAuditRunner, startAudit } from "../services/audit";
import { computeNextRun } from "../services/reports";
import { runVisibility, visibilityInput } from "../services/visibility";
import { describeKeyFile, getIndexNowKey } from "../distribution/indexnow";
import { getDistributionSettings } from "../distribution/config";
import { dispatchSite } from "../distribution/queue";
import { publicRequest } from "./outbound";
import { buildSnapshot, snapshotJson, type Step } from "./snapshot";
import { deliverReport, type Delivery } from "./notify";

export async function runSchedule(id: string, options: { force?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const claimId = randomUUID();
  const claimed = await prisma.$transaction(async (tx) => {
    const count = await tx.scheduledReport.updateMany({
      where: { id, enabled: true, claimId: null, ...(options.force ? {} : { nextRunAt: { lte: now } }) },
      data: { claimId, claimedAt: now },
    });
    if (!count.count) return null;
    const schedule = await tx.scheduledReport.findUniqueOrThrow({ where: { id }, include: { site: true } });
    const run = await tx.reportRun.create({ data: { id: claimId, siteId: schedule.siteId, scheduleId: id, frequency: schedule.frequency } });
    return { schedule, run };
  });
  if (!claimed) return null;
  const { schedule, run } = claimed;
  const steps: Step[] = [];
  let deliveries: Delivery[] = [];
  let status = "failed";
  async function step(name: string, fn: () => Promise<string>) {
    try { steps.push({ name, status: "ok", detail: await fn() }); }
    // Do not persist raw exception messages: provider / webhook errors may contain credentials.
    catch { steps.push({ name, status: "failed", detail: "Check failed; verify configuration and service availability" }); }
  }
  try {
    if (schedule.frequency === "weekly") {
      if (!getAuditRunner()) steps.push({ name: "crawl-graph-eeat", status: "skipped", detail: "Configure GEO_AUDIT_BIN; no crawl was queued" });
      else await step("crawl-graph-eeat", async () => {
        const job = await startAudit(schedule.siteId, { trigger: "scheduled" }, run.id);
        await executeAudit(job);
        const audit = await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id } });
        if (audit.status !== "completed") throw new Error("Audit did not complete");
        return `Completed audit ${audit.id}: crawl, knowledge graph and E-E-A-T scoring`;
      });
    }
    await step("llm-visibility", async () => {
      const result = await runVisibility(schedule.siteId, visibilityInput.parse({ refresh: true }));
      if (result.failed) {
        steps.push({ name: "llm-provider-coverage", status: "failed", detail: `${result.successful}/${result.attempted} checks succeeded; missing or failed providers were not recorded as zero scores` });
      }
      return `${result.successful}/${result.attempted} fresh checks succeeded (cache bypassed)`;
    });
    const key = getIndexNowKey(schedule.site);
    if (!key) steps.push({ name: "indexnow", status: "skipped", detail: "No valid IndexNow key configured" });
    else await step("indexnow", async () => {
      const response = await publicRequest(describeKeyFile(schedule.site, key).keyLocation);
      if (response.status !== 200 || response.body.replace(/^\uFEFF/, "").trim() !== key) throw new Error("Key verification failed");
      return "Published key matches; this is not proof of indexing or search inclusion";
    });
    const distribution = getDistributionSettings(schedule.site);
    if (distribution.enabled && distribution.channels.indexnow) await step("indexnow-queue", async () => {
      const result = await dispatchSite(schedule.siteId, { limit: 100, channels: ["indexnow"] });
      const sent = result.channels.reduce((n, c) => n + c.sent, 0);
      if (result.channels.some((c) => c.failed || c.deferred)) throw new Error("IndexNow submissions failed or deferred");
      return `${sent}/${result.claimed} queued notifications submitted; not proof of indexing`;
    });
    const snapshot = await buildSnapshot(schedule.siteId, schedule.frequency === "weekly" ? 7 : 1, new Date(), steps);
    // Save evidence before any outbound side effect. Interrupted delivery is never silently retried.
    await prisma.reportRun.update({ where: { id: run.id }, data: { snapshot: snapshotJson(snapshot), steps } });
    deliveries = await deliverReport(schedule, run.id, snapshot);
    status = steps.every((s) => s.status === "ok") && deliveries.every((d) => d.status === "sent") ? "completed" : "partial";
  } catch {
    steps.push({ name: "report", status: "failed", detail: "Report generation failed; no automatic delivery retry" });
  }
  const finishedAt = new Date();
  // ponytail: non-expiring DB claim favors no duplicate paid checks/deliveries over automatic crash retry.
  // Operators recover interrupted claims only after stopping their worker (see docs/reporting.md).
  await prisma.$transaction([
    prisma.reportRun.update({ where: { id: run.id }, data: { status, steps, deliveries, finishedAt } }),
    prisma.scheduledReport.updateMany({ where: { id, claimId }, data: { claimId: null, claimedAt: null, lastRunAt: finishedAt, nextRunAt: computeNextRun(schedule.frequency as "daily" | "weekly", finishedAt) } }),
  ]);
  return prisma.reportRun.findUniqueOrThrow({ where: { id: run.id } });
}

/** Bounded sequential dispatch; missed intervals coalesce into one fresh report, not a paid backlog. */
export async function runDueReports(now = new Date()) {
  const due = await prisma.scheduledReport.findMany({ where: { enabled: true, claimId: null, nextRunAt: { lte: now } }, orderBy: { nextRunAt: "asc" }, take: 20, select: { id: true } });
  const results = [];
  for (const item of due) {
    // Isolate infrastructure errors too, so a deleted/broken site cannot starve other schedules.
    try { const run = await runSchedule(item.id, { now }); if (run) results.push({ id: run.id, status: run.status }); }
    catch { results.push({ id: item.id, status: "dispatch_failed" }); }
  }
  return results;
}

/** Explicit recovery only: caller MUST first stop every worker that could own this schedule. */
export async function recoverSchedule(id: string) {
  return prisma.$transaction(async (tx) => {
    const schedule = await tx.scheduledReport.findUniqueOrThrow({ where: { id } });
    if (!schedule.claimId) return false;
    const run = await tx.reportRun.findUnique({ where: { id: schedule.claimId } });
    if (run?.crawlSessionId) await tx.crawlSession.updateMany({
      where: { id: run.crawlSessionId, siteId: schedule.siteId, status: { in: ["queued", "running"] } },
      data: { status: "failed", error: "Interrupted scheduled report; recovered by operator", finishedAt: new Date() },
    });
    if (run?.auditId) await tx.geoAudit.updateMany({
      where: { id: run.auditId, siteId: schedule.siteId, status: { in: ["pending", "running"] } },
      data: { status: "failed", error: "Interrupted scheduled report; recovered by operator" },
    });
    await tx.reportRun.updateMany({ where: { id: schedule.claimId, status: "running" }, data: { status: "interrupted", finishedAt: new Date() } });
    await tx.scheduledReport.update({ where: { id }, data: { claimId: null, claimedAt: null, enabled: false, nextRunAt: null } });
    return true;
  });
}
