import { prisma } from "../db";
import type { ReportFrequency } from "../constants";
import { getSiteOrThrow } from "../services/sites";
import { aggregateVisibility, anomaliesOf, type Anomaly, type CompetitorStat, type ModelStats } from "../monitoring/trends";

// Periodic (daily / weekly) executive report: data only. Renderers live in html.ts / pdf.ts.

const DAY = 86_400_000;
const PERIOD_DAYS: Record<ReportFrequency, number> = { daily: 1, weekly: 7 };
const TREND_POINTS: Record<ReportFrequency, number> = { daily: 14, weekly: 8 };

export interface ReportAction {
  id: string;
  title: string;
  category: string;
  impact: string;
  effort: string | null;
  status: string;
  priority: number | null;
  targetUrl: string | null;
  expectedGain: number | null;
  resolvedAt: string | null;
}

export interface ScoreLine {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

export interface TrendPoint {
  date: string;
  geoScore: number | null;
  seoScore: number | null;
  eeatScore: number | null;
  visibilityRate: number | null;
}

export interface PeriodicReport {
  version: 1;
  frequency: ReportFrequency;
  /** Stable id of the reported period, e.g. "weekly:2026-11-09" (UTC end date). */
  periodKey: string;
  generatedAt: string;
  site: { id: string; url: string; title: string };
  period: { start: string; end: string; days: number; previousStart: string };
  headline: { text: string; direction: "up" | "down" | "flat" | "none"; changePct: number | null; changePoints: number | null };
  executiveSummary: string[];
  scores: { geo: ScoreLine; seo: ScoreLine; eeat: ScoreLine; auditedAt: string | null; newAuditInPeriod: boolean };
  visibility: {
    current: { totalChecks: number; visibilityRate: number | null; citationRate: number | null; cited: number; mentioned: number };
    previous: { totalChecks: number; visibilityRate: number | null; citationRate: number | null; cited: number; mentioned: number };
    perModel: Array<{ model: string; current: ModelStats | null; previousVisibilityRate: number | null }>;
    competitors: CompetitorStat[];
  };
  actions: {
    resolved: ReportAction[];
    resolvedCount: number;
    pendingCritical: ReportAction[];
    pendingCount: number;
    pendingByImpact: Record<string, number>;
    openedCount: number;
  };
  anomalies: Array<Anomaly & { detectedAt: string }>;
  trend: TrendPoint[];
}

const fmt1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** "%12,5" — Turkish puts the percent sign first. */
export const trPct = (n: number) => `%${fmt1.format(n)}`;

export function periodKeyOf(frequency: ReportFrequency, end: Date) {
  return `${frequency}:${end.toISOString().slice(0, 10)}`;
}

export function visibilityHeadline(frequency: ReportFrequency, current: number | null, previous: number | null): PeriodicReport["headline"] {
  const label = frequency === "weekly" ? "Bu hafta" : "Son 24 saatte";
  if (current == null) {
    return { text: `${label} yapay zeka görünürlük kontrolü yapılmadı.`, direction: "none", changePct: null, changePoints: null };
  }
  if (previous == null) {
    return {
      text: `${label} yapay zeka aramalarındaki görünürlüğünüz ${trPct(current)} (karşılaştırılacak önceki dönem verisi yok).`,
      direction: "none",
      changePct: null,
      changePoints: null,
    };
  }
  const points = current - previous;
  if (points === 0) {
    return { text: `${label} yapay zeka aramalarındaki görünürlüğünüz değişmedi (${trPct(current)}).`, direction: "flat", changePct: 0, changePoints: 0 };
  }
  const direction = points > 0 ? "up" : "down";
  const verb = points > 0 ? "arttı" : "azaldı";
  if (previous === 0) {
    return {
      text: `${label} yapay zeka aramalarındaki görünürlüğünüz ${trPct(0)} → ${trPct(current)} yükseldi.`,
      direction,
      changePct: null,
      changePoints: points,
    };
  }
  const changePct = Math.round((Math.abs(points) / previous) * 1000) / 10;
  return {
    text: `${label} yapay zeka aramalarındaki görünürlüğünüz ${trPct(changePct)} ${verb} (${trPct(previous)} → ${trPct(current)}).`,
    direction,
    changePct: points > 0 ? changePct : -changePct,
    changePoints: points,
  };
}

function toAction(a: {
  id: string; title: string; category: string; impact: string; effort: string | null; status: string;
  priority: number | null; targetUrl: string | null; details: unknown; resolvedAt: Date | null;
}): ReportAction {
  const gain = a.details && typeof a.details === "object" ? (a.details as Record<string, unknown>).expected_gain : null;
  return {
    id: a.id,
    title: a.title,
    category: a.category,
    impact: a.impact,
    effort: a.effort,
    status: a.status,
    priority: a.priority,
    targetUrl: a.targetUrl,
    expectedGain: typeof gain === "number" ? gain : null,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

const line = (current: number | null | undefined, previous: number | null | undefined): ScoreLine => ({
  current: current ?? null,
  previous: previous ?? null,
  delta: current != null && previous != null ? current - previous : null,
});

const IMPACT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export async function buildPeriodicReport(siteId: string, frequency: ReportFrequency, now = new Date()): Promise<PeriodicReport> {
  const site = await getSiteOrThrow(siteId);
  const days = PERIOD_DAYS[frequency];
  const end = now;
  const start = new Date(end.getTime() - days * DAY);
  const previousStart = new Date(start.getTime() - days * DAY);
  const endExclusive = new Date(end.getTime() + 1);
  const trendSince = new Date(end.getTime() - TREND_POINTS[frequency] * days * DAY);
  const ACTIVE = ["open", "in_progress"];

  const [currentAudit, previousAudit, cur, prev, resolved, resolvedCount, pending, pendingGroups, openedCount, snapshots, auditHistory] =
    await Promise.all([
      prisma.geoAudit.findFirst({
        where: { siteId, status: "completed", createdAt: { lte: end } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.geoAudit.findFirst({
        where: { siteId, status: "completed", createdAt: { lt: start } },
        orderBy: { createdAt: "desc" },
      }),
      aggregateVisibility(siteId, start, endExclusive),
      aggregateVisibility(siteId, previousStart, start),
      prisma.actionItem.findMany({
        where: { siteId, status: "resolved", resolvedAt: { gte: start, lte: end } },
        orderBy: [{ priority: "desc" }, { resolvedAt: "desc" }],
        take: 10,
      }),
      prisma.actionItem.count({ where: { siteId, status: "resolved", resolvedAt: { gte: start, lte: end } } }),
      prisma.actionItem.findMany({
        where: { siteId, status: { in: ACTIVE }, impact: { in: ["high", "medium"] } },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        take: 50,
      }),
      prisma.actionItem.groupBy({ by: ["impact"], where: { siteId, status: { in: ACTIVE } }, _count: { _all: true } }),
      prisma.actionItem.count({ where: { siteId, createdAt: { gte: start, lte: end } } }),
      prisma.metricSnapshot.findMany({
        where: { siteId, capturedAt: { gte: trendSince, lte: end } },
        orderBy: { capturedAt: "asc" },
      }),
      prisma.geoAudit.findMany({
        where: { siteId, status: "completed", createdAt: { gte: trendSince, lte: end } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, geoScore: true, seoScore: true, eeatScore: true },
      }),
    ]);

  // Trend: snapshots matching the report cadence; fall back to any snapshot, then to raw audit history.
  const sameKind = snapshots.filter((s) => s.kind === frequency);
  const series = sameKind.length >= 2 ? sameKind : snapshots;
  const trend: TrendPoint[] = (
    series.length
      ? series.map((s) => ({ date: s.capturedAt, geoScore: s.geoScore, seoScore: s.seoScore, eeatScore: s.eeatScore, visibilityRate: s.visibilityRate }))
      : auditHistory.map((a) => ({ date: a.createdAt, geoScore: a.geoScore, seoScore: a.seoScore, eeatScore: a.eeatScore, visibilityRate: null }))
  )
    .slice(-TREND_POINTS[frequency])
    .map((p) => ({ ...p, date: p.date.toISOString() }));

  // Anomalies detected inside the period; keep the latest per metric.
  const seen = new Set<string>();
  const anomalies: PeriodicReport["anomalies"] = [];
  for (const s of [...snapshots].reverse()) {
    if (s.capturedAt < start) break;
    for (const a of anomaliesOf(s)) {
      if (seen.has(a.metric)) continue;
      seen.add(a.metric);
      anomalies.push({ ...a, detectedAt: s.capturedAt.toISOString() });
    }
  }

  const pendingCritical = pending
    .sort((a, b) => (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) || (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 10)
    .map(toAction);
  const pendingByImpact: Record<string, number> = { high: 0, medium: 0, low: 0 };
  let pendingCount = 0;
  for (const g of pendingGroups) {
    pendingByImpact[g.impact] = (pendingByImpact[g.impact] ?? 0) + g._count._all;
    pendingCount += g._count._all;
  }

  const newAuditInPeriod = !!currentAudit && currentAudit.createdAt >= start;
  const scores = {
    geo: line(currentAudit?.geoScore, previousAudit?.geoScore),
    seo: line(currentAudit?.seoScore, previousAudit?.seoScore),
    eeat: line(currentAudit?.eeatScore, previousAudit?.eeatScore),
    auditedAt: currentAudit?.createdAt.toISOString() ?? null,
    newAuditInPeriod,
  };
  const headline = visibilityHeadline(frequency, cur.visibilityRate, prev.visibilityRate);
  const models = [...new Set([...Object.keys(cur.perModel), ...Object.keys(prev.perModel)])].sort();

  const report: PeriodicReport = {
    version: 1,
    frequency,
    periodKey: periodKeyOf(frequency, end),
    generatedAt: new Date().toISOString(),
    site: { id: site.id, url: site.url, title: site.title },
    period: { start: start.toISOString(), end: end.toISOString(), days, previousStart: previousStart.toISOString() },
    headline,
    executiveSummary: [],
    scores,
    visibility: {
      current: { totalChecks: cur.totalChecks, visibilityRate: cur.visibilityRate, citationRate: cur.citationRate, cited: cur.cited, mentioned: cur.mentioned },
      previous: { totalChecks: prev.totalChecks, visibilityRate: prev.visibilityRate, citationRate: prev.citationRate, cited: prev.cited, mentioned: prev.mentioned },
      perModel: models.map((model) => ({
        model,
        current: cur.perModel[model] ?? null,
        previousVisibilityRate: prev.perModel[model]?.visibilityRate ?? null,
      })),
      competitors: cur.competitors.slice(0, 5),
    },
    actions: { resolved: resolved.map(toAction), resolvedCount, pendingCritical, pendingCount, pendingByImpact, openedCount },
    anomalies,
    trend,
  };
  report.executiveSummary = executiveSummary(report);
  return report;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Plain-language bullets for the "Yönetici Özeti" section. */
export function executiveSummary(r: PeriodicReport): string[] {
  const out = [r.headline.text];
  const { geo, seo, eeat } = r.scores;
  if (geo.current != null) {
    const parts = [
      `GEO ${geo.current}${geo.delta != null ? ` (${signed(geo.delta)})` : ""}`,
      seo.current != null ? `SEO ${seo.current}${seo.delta != null ? ` (${signed(seo.delta)})` : ""}` : null,
      eeat.current != null ? `E-E-A-T ${eeat.current}${eeat.delta != null ? ` (${signed(eeat.delta)})` : ""}` : null,
    ].filter(Boolean);
    out.push(`Güncel skorlar: ${parts.join(", ")}${r.scores.newAuditInPeriod ? "" : " — bu dönemde yeni denetim yapılmadı"}.`);
  } else {
    out.push("Henüz tamamlanmış bir GEO/SEO denetimi yok; ilk haftalık denetimden sonra skorlar burada görünecek.");
  }
  const v = r.visibility;
  if (v.current.totalChecks) {
    const citeDelta = v.previous.totalChecks ? ` (önceki dönem: ${v.previous.cited})` : "";
    out.push(`${v.current.totalChecks} yapay zeka yanıtında ${v.current.cited} doğrudan atıf, ${v.current.mentioned} marka bahsi alındı${citeDelta}.`);
  }
  const best = r.visibility.perModel.filter((m) => m.current?.total).sort((a, b) => b.current!.visibilityRate - a.current!.visibilityRate);
  if (best.length > 1) {
    out.push(`En iyi model: ${best[0].model} (${trPct(best[0].current!.visibilityRate)}); en zayıf: ${best.at(-1)!.model} (${trPct(best.at(-1)!.current!.visibilityRate)}).`);
  }
  if (v.competitors.length) {
    out.push(`Yanıtlarda en sık atıf alan rakip: ${v.competitors[0].domain} (yanıt payı ${trPct(v.competitors[0].share)}).`);
  }
  if (r.anomalies.length) {
    const high = r.anomalies.filter((a) => a.severity === "high").length;
    out.push(`${r.anomalies.length} anormallik tespit edildi${high ? ` (${high} kritik)` : ""}: ${r.anomalies[0].message}`);
  }
  out.push(
    `Bu dönemde ${r.actions.resolvedCount} aksiyon çözüldü; ${r.actions.pendingCount} aksiyon bekliyor (${r.actions.pendingByImpact.high ?? 0} yüksek etkili).`,
  );
  return out;
}
