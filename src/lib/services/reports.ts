import { prisma } from "../db";
import type { ReportFrequency } from "../constants";
import { getSiteOrThrow } from "./sites";

/** Next run time: daily -> +1 day, weekly -> +7 days, aligned to 06:00 UTC. */
export function computeNextRun(frequency: ReportFrequency, from = new Date()): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 6, 0, 0));
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  if (frequency === "weekly") {
    // Align to Monday 06:00 UTC.
    while (next.getUTCDay() !== 1) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export async function getSiteReport(siteId: string, days: number) {
  const site = await getSiteOrThrow(siteId);
  const since = new Date(Date.now() - days * 86_400_000);

  const [audits, visibility, actionGroups, schedules] = await Promise.all([
    prisma.geoAudit.findMany({
      where: { siteId, status: "completed", createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { id: true, geoScore: true, seoScore: true, eeatScore: true, metrics: true, createdAt: true },
    }),
    prisma.llmVisibilityRecord.groupBy({
      by: ["model", "citationStatus"],
      where: { siteId, checkedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.actionItem.groupBy({
      by: ["status", "impact", "category"],
      where: { siteId },
      _count: { _all: true },
    }),
    // Overview never exposes notification addresses, secret webhook paths, or worker claims.
    prisma.scheduledReport.findMany({ where: { siteId }, orderBy: { createdAt: "asc" }, select: { id: true, siteId: true, frequency: true, enabled: true, lastRunAt: true, nextRunAt: true, createdAt: true, updatedAt: true } }),
  ]);

  const latest = audits.at(-1) ?? null;
  const previous = audits.length > 1 ? audits[audits.length - 2] : null;
  const delta = (k: "geoScore" | "seoScore" | "eeatScore") =>
    latest?.[k] != null && previous?.[k] != null ? latest[k]! - previous[k]! : null;

  // Visibility per model: share of answers that cite or mention the site.
  const perModel: Record<string, { cited: number; mentioned: number; none: number; total: number; visibilityRate: number; citationRate: number }> = {};
  for (const row of visibility) {
    const m = (perModel[row.model] ??= { cited: 0, mentioned: 0, none: 0, total: 0, visibilityRate: 0, citationRate: 0 });
    const n = row._count._all;
    if (row.citationStatus === "cited" || row.citationStatus === "mentioned" || row.citationStatus === "none") {
      m[row.citationStatus] += n;
    }
    m.total += n;
  }
  let visTotal = 0;
  let visHit = 0;
  let visCited = 0;
  for (const m of Object.values(perModel)) {
    m.visibilityRate = m.total ? Math.round(((m.cited + m.mentioned) / m.total) * 100) : 0;
    m.citationRate = m.total ? Math.round((m.cited / m.total) * 100) : 0;
    visTotal += m.total;
    visHit += m.cited + m.mentioned;
    visCited += m.cited;
  }

  const actions = { open: 0, byImpact: { high: 0, medium: 0, low: 0 } as Record<string, number>, byCategory: {} as Record<string, number>, byStatus: {} as Record<string, number> };
  for (const g of actionGroups) {
    const n = g._count._all;
    actions.byStatus[g.status] = (actions.byStatus[g.status] ?? 0) + n;
    if (g.status === "open" || g.status === "in_progress") {
      actions.open += n;
      actions.byImpact[g.impact] = (actions.byImpact[g.impact] ?? 0) + n;
      actions.byCategory[g.category] = (actions.byCategory[g.category] ?? 0) + n;
    }
  }

  return {
    site: { id: site.id, url: site.url, title: site.title },
    period: { days, since: since.toISOString(), until: new Date().toISOString() },
    scores: latest
      ? {
          geo: latest.geoScore,
          seo: latest.seoScore,
          eeat: latest.eeatScore,
          metrics: latest.metrics,
          auditedAt: latest.createdAt,
          delta: { geo: delta("geoScore"), seo: delta("seoScore"), eeat: delta("eeatScore") },
        }
      : null,
    history: audits.map((a) => ({ date: a.createdAt, geo: a.geoScore, seo: a.seoScore, eeat: a.eeatScore })),
    visibility: {
      totalChecks: visTotal,
      citationRate: visTotal ? Math.round((visCited / visTotal) * 100) : 0,
      visibilityRate: visTotal ? Math.round((visHit / visTotal) * 100) : 0,
      perModel,
    },
    actions,
    schedules,
  };
}

/**
 * API view of a schedule: webhook URLs usually embed a secret (Slack/Discord tokens), so only the origin is
 * returned, and the worker's internal claim fields are dropped.
 */
export function serializeSchedule<T extends { webhookUrl: string | null; claimId?: string | null }>(schedule: T) {
  const { claimId: _claimId, ...rest } = schedule;
  let webhookUrl = schedule.webhookUrl;
  if (webhookUrl) {
    try {
      webhookUrl = `${new URL(webhookUrl).origin}/…`;
    } catch {
      webhookUrl = "…";
    }
  }
  return { ...rest, webhookUrl, running: !!schedule.claimId };
}

export async function createSchedule(
  siteId: string,
  input: { frequency: ReportFrequency; recipients: string[]; enabled: boolean; webhookUrl?: string },
) {
  await getSiteOrThrow(siteId);
  return serializeSchedule(
    await prisma.scheduledReport.create({
      data: { siteId, ...input, nextRunAt: input.enabled ? computeNextRun(input.frequency) : null },
    }),
  );
}
