import type { MetricSnapshot, Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { SnapshotKind } from "../constants";
import { getSiteOrThrow } from "../services/sites";

// Time series of a site's GEO / SEO / E-E-A-T scores and LLM visibility, plus anomaly detection
// (sudden drops, competitor surges). Snapshots are written by the scheduler (GENE-99).

const DAY = 86_400_000;

export interface ModelStats {
  total: number;
  cited: number;
  mentioned: number;
  visibilityRate: number;
  citationRate: number;
}

export interface CompetitorStat {
  domain: string;
  /** Answers in the window that cited this domain. */
  count: number;
  /** % of answers in the window that cited this domain. */
  share: number;
}

export interface VisibilityAggregate {
  totalChecks: number;
  cited: number;
  mentioned: number;
  /** null when no checks ran in the window. */
  visibilityRate: number | null;
  citationRate: number | null;
  perModel: Record<string, ModelStats>;
  competitors: CompetitorStat[];
}

/** Metrics compared by anomaly detection — a subset of MetricSnapshot. */
export interface SnapshotMetrics {
  geoScore: number | null;
  seoScore: number | null;
  eeatScore: number | null;
  visibilityRate: number | null;
  citationRate: number | null;
  totalChecks: number;
  competitors: CompetitorStat[];
}

export type AnomalyType = "score_drop" | "visibility_drop" | "citation_drop" | "competitor_surge";

export interface Anomaly {
  type: AnomalyType;
  /** geoScore | seoScore | eeatScore | visibilityRate | citationRate | competitor:<domain> */
  metric: string;
  severity: "high" | "medium";
  previous: number;
  current: number;
  /** current - previous, in points. */
  change: number;
  message: string;
}

export const ANOMALY_THRESHOLDS = {
  /** Score drop (points) vs the previous snapshot that flags an anomaly / a high-severity one. */
  scoreDrop: 8,
  scoreDropHigh: 15,
  /** z-score against the recent baseline that also flags a smaller drop (needs >= baselineMin points). */
  zScore: -2.5,
  baselineMin: 4,
  /** Visibility / citation-rate drop in percentage points. */
  rateDrop: 15,
  rateDropHigh: 30,
  /** Minimum LLM answers in both windows before rates are compared (avoids noise on tiny samples). */
  minChecks: 4,
  /** Competitor share increase (points) and minimum citations to call it a surge. */
  competitorSurge: 20,
  competitorSurgeHigh: 35,
  competitorMinCount: 3,
} as const;

const SCORE_LABELS = { geoScore: "GEO skoru", seoScore: "SEO skoru", eeatScore: "E-E-A-T (bilgi güvenilirliği) skoru" } as const;

const pct = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * Compares `current` with `history` (most recent first). Pure: no I/O, deterministic.
 * Only regressions are reported — improvements are surfaced by the report deltas instead.
 */
export function detectAnomalies(current: SnapshotMetrics, history: SnapshotMetrics[], t = ANOMALY_THRESHOLDS): Anomaly[] {
  const out: Anomaly[] = [];

  for (const metric of ["geoScore", "seoScore", "eeatScore"] as const) {
    const cur = current[metric];
    if (cur == null) continue;
    const series = history.map((h) => h[metric]).filter((v): v is number => v != null);
    if (!series.length) continue;
    const prev = series[0];
    const drop = prev - cur;
    if (drop <= 0) continue;
    const baseline = series.slice(0, 8);
    let zFlag = false;
    if (baseline.length >= t.baselineMin) {
      const sd = stdev(baseline);
      zFlag = sd > 0 && (cur - mean(baseline)) / sd <= t.zScore && drop >= 3;
    }
    if (drop >= t.scoreDrop || zFlag) {
      out.push({
        type: "score_drop",
        metric,
        severity: drop >= t.scoreDropHigh ? "high" : "medium",
        previous: prev,
        current: cur,
        change: cur - prev,
        message: `${SCORE_LABELS[metric]} ${prev} → ${cur} düştü (${cur - prev} puan).`,
      });
    }
  }

  const prevWithChecks = history.find((h) => h.totalChecks >= t.minChecks && h.visibilityRate != null);
  const enoughNow = current.totalChecks >= t.minChecks;
  if (prevWithChecks && enoughNow) {
    const rates = [
      ["visibilityRate", "visibility_drop", "Yapay zeka görünürlük oranı"],
      ["citationRate", "citation_drop", "Model atıf oranı"],
    ] as const;
    for (const [metric, type, label] of rates) {
      const cur = current[metric];
      const prev = prevWithChecks[metric];
      if (cur == null || prev == null) continue;
      const drop = prev - cur;
      const relativeCollapse = prev >= 20 && cur <= prev / 2;
      if (drop >= t.rateDrop || (relativeCollapse && drop >= 10)) {
        out.push({
          type,
          metric,
          severity: drop >= t.rateDropHigh || relativeCollapse ? "high" : "medium",
          previous: prev,
          current: cur,
          change: cur - prev,
          message: `${label} %${prev} → %${cur} düştü (${cur - prev} puan).`,
        });
      }
    }

    const prevShare = new Map(prevWithChecks.competitors.map((c) => [c.domain, c.share]));
    for (const c of current.competitors) {
      const before = prevShare.get(c.domain) ?? 0;
      const jump = c.share - before;
      if (jump >= t.competitorSurge && c.count >= t.competitorMinCount) {
        out.push({
          type: "competitor_surge",
          metric: `competitor:${c.domain}`,
          severity: jump >= t.competitorSurgeHigh ? "high" : "medium",
          previous: before,
          current: c.share,
          change: jump,
          message: `Rakip ${c.domain} yapay zeka yanıtlarında sıçradı: %${before} → %${c.share} (+${jump} puan).`,
        });
      }
    }
  }

  const rank = { high: 0, medium: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.change - b.change);
}

function competitorDomainsOf(meta: Prisma.JsonValue | null): string[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const list = (meta as Record<string, unknown>).competitorDomains;
  return Array.isArray(list) ? [...new Set(list.filter((d): d is string => typeof d === "string" && d.length > 0))] : [];
}

/** Aggregates LLM visibility records with checkedAt in [from, to). */
export async function aggregateVisibility(siteId: string, from: Date, to: Date): Promise<VisibilityAggregate> {
  const records = await prisma.llmVisibilityRecord.findMany({
    where: { siteId, checkedAt: { gte: from, lt: to } },
    select: { model: true, citationStatus: true, responseMeta: true },
  });
  const perModel: Record<string, ModelStats> = {};
  const competitorCounts = new Map<string, number>();
  let cited = 0;
  let mentioned = 0;
  for (const r of records) {
    const m = (perModel[r.model] ??= { total: 0, cited: 0, mentioned: 0, visibilityRate: 0, citationRate: 0 });
    m.total++;
    if (r.citationStatus === "cited") {
      m.cited++;
      cited++;
    } else if (r.citationStatus === "mentioned") {
      m.mentioned++;
      mentioned++;
    }
    for (const d of competitorDomainsOf(r.responseMeta)) competitorCounts.set(d, (competitorCounts.get(d) ?? 0) + 1);
  }
  for (const m of Object.values(perModel)) {
    m.visibilityRate = pct(m.cited + m.mentioned, m.total);
    m.citationRate = pct(m.cited, m.total);
  }
  const total = records.length;
  const competitors = [...competitorCounts.entries()]
    .map(([domain, count]) => ({ domain, count, share: pct(count, total) }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 10);
  return {
    totalChecks: total,
    cited,
    mentioned,
    visibilityRate: total ? pct(cited + mentioned, total) : null,
    citationRate: total ? pct(cited, total) : null,
    perModel,
    competitors,
  };
}

export function snapshotMetrics(s: Pick<MetricSnapshot, "geoScore" | "seoScore" | "eeatScore" | "visibilityRate" | "citationRate" | "totalChecks" | "competitors">): SnapshotMetrics {
  return {
    geoScore: s.geoScore,
    seoScore: s.seoScore,
    eeatScore: s.eeatScore,
    visibilityRate: s.visibilityRate,
    citationRate: s.citationRate,
    totalChecks: s.totalChecks,
    competitors: Array.isArray(s.competitors) ? (s.competitors as unknown as CompetitorStat[]) : [],
  };
}

export const DEFAULT_WINDOW_DAYS: Record<SnapshotKind, number> = { daily: 1, weekly: 7, manual: 7 };

/**
 * Records a time-series point for a site and the anomalies it shows against the last snapshots of
 * the same kind (daily compares with daily, weekly with weekly — their windows differ).
 */
export async function captureSnapshot(
  siteId: string,
  opts: { kind?: SnapshotKind; now?: Date; windowDays?: number } = {},
) {
  await getSiteOrThrow(siteId);
  const kind = opts.kind ?? "manual";
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS[kind];
  const [audit, vis, openActions, criticalActions, history] = await Promise.all([
    prisma.geoAudit.findFirst({
      where: { siteId, status: "completed", createdAt: { lte: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, geoScore: true, seoScore: true, eeatScore: true },
    }),
    // +1ms: include records written in the same millisecond as `now`.
    aggregateVisibility(siteId, new Date(now.getTime() - windowDays * DAY), new Date(now.getTime() + 1)),
    prisma.actionItem.count({ where: { siteId, status: { in: ["open", "in_progress"] } } }),
    prisma.actionItem.count({ where: { siteId, status: { in: ["open", "in_progress"] }, impact: "high" } }),
    prisma.metricSnapshot.findMany({
      where: { siteId, kind, capturedAt: { lt: now } },
      orderBy: { capturedAt: "desc" },
      take: 8,
    }),
  ]);

  const metrics: SnapshotMetrics = {
    geoScore: audit?.geoScore ?? null,
    seoScore: audit?.seoScore ?? null,
    eeatScore: audit?.eeatScore ?? null,
    visibilityRate: vis.visibilityRate,
    citationRate: vis.citationRate,
    totalChecks: vis.totalChecks,
    competitors: vis.competitors,
  };
  const anomalies = detectAnomalies(metrics, history.map(snapshotMetrics));

  return prisma.metricSnapshot.create({
    data: {
      siteId,
      kind,
      windowDays,
      auditId: audit?.id ?? null,
      ...metrics,
      citedCount: vis.cited,
      mentionedCount: vis.mentioned,
      openActions,
      criticalActions,
      perModel: vis.perModel as unknown as Prisma.InputJsonValue,
      competitors: vis.competitors as unknown as Prisma.InputJsonValue,
      anomalies: anomalies as unknown as Prisma.InputJsonValue,
      capturedAt: now,
    },
  });
}

export function anomaliesOf(s: Pick<MetricSnapshot, "anomalies">): Anomaly[] {
  return Array.isArray(s.anomalies) ? (s.anomalies as unknown as Anomaly[]) : [];
}

/** Trend API: snapshot series (oldest first), change between first and last point, recent anomalies. */
export async function getTrends(siteId: string, opts: { days: number; kind?: SnapshotKind }) {
  const site = await getSiteOrThrow(siteId);
  const since = new Date(Date.now() - opts.days * DAY);
  const snapshots = await prisma.metricSnapshot.findMany({
    where: { siteId, capturedAt: { gte: since }, ...(opts.kind && { kind: opts.kind }) },
    orderBy: { capturedAt: "asc" },
    take: 1_000,
  });
  const first = snapshots[0];
  const last = snapshots.at(-1);
  const diff = (k: "geoScore" | "seoScore" | "eeatScore" | "visibilityRate" | "citationRate") =>
    first?.[k] != null && last?.[k] != null ? last[k]! - first[k]! : null;
  return {
    site: { id: site.id, url: site.url, title: site.title },
    days: opts.days,
    kind: opts.kind ?? null,
    points: snapshots.map((s) => ({
      id: s.id,
      kind: s.kind,
      capturedAt: s.capturedAt,
      geoScore: s.geoScore,
      seoScore: s.seoScore,
      eeatScore: s.eeatScore,
      visibilityRate: s.visibilityRate,
      citationRate: s.citationRate,
      citedCount: s.citedCount,
      totalChecks: s.totalChecks,
      openActions: s.openActions,
      criticalActions: s.criticalActions,
      anomalyCount: anomaliesOf(s).length,
    })),
    change: last
      ? {
          geoScore: diff("geoScore"),
          seoScore: diff("seoScore"),
          eeatScore: diff("eeatScore"),
          visibilityRate: diff("visibilityRate"),
          citationRate: diff("citationRate"),
        }
      : null,
    latest: last ? { ...last, anomalies: anomaliesOf(last) } : null,
    anomalies: snapshots
      .flatMap((s) => anomaliesOf(s).map((a) => ({ ...a, snapshotId: s.id, kind: s.kind, capturedAt: s.capturedAt })))
      .reverse()
      .slice(0, 100),
  };
}
