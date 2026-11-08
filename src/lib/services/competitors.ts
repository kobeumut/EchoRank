// Competitor Share-of-Model snapshots: recomputes the SoM analysis (som-analysis.ts) over stored visibility checks and
// persists one CompetitorAnalysis row per configured competitor (settings.visibilityAnalysis.competitors).
// Shares are among the site + configured competitors only, never the whole AI answer market.
import { z } from "zod";
import { QUERY_INTENTS, type QueryIntent } from "../constants";
import { prisma } from "../db";
import { analyzeAnswer, analyzeBrandSentiment, host, visibilityAnalysisSettings, VISIBILITY_MODELS, type VisibilityModel } from "../visibility-analysis";
import { queryBool } from "../validation";
import { classifyIntent } from "./query-generator";
import { getSiteOrThrow } from "./sites";
import { analyzeSom, getSomAnalysis, somTrend } from "./som-analysis";
import { fingerprintQuery } from "./synthetic-queries";

export const competitorQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  /** false -> return the stored snapshot without recomputing. */
  refresh: queryBool.default(true),
  gapLimit: z.coerce.number().int().min(0).max(200).default(50),
  /** SoM trend bucket size. */
  granularity: z.enum(["day", "week"]).default("day"),
  /** Max sentiment evidence rows and hallucination findings returned. */
  evidenceLimit: z.coerce.number().int().min(0).max(200).default(30),
});

type Brand = { title: string; url: string; domain: string };
type Record_ = { id: string; model: string; query: string; excerpt: string | null; responseMeta: unknown; citationStatus: string };

const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-brand evidence the SoM summary does not keep: distinct cited queries, most cited URLs and the mean
 * clause sentiment. `brands[0]` is the site itself.
 */
export function brandEvidence(brands: Brand[], records: Record_[], topUrls = 10) {
  const acc = brands.map(() => ({ queries: new Set<string>(), urls: new Map<string, number>(), sentiment: [] as number[] }));
  for (const r of records) {
    if (!VISIBILITY_MODELS.includes(r.model as VisibilityModel)) continue;
    const meta = object(r.responseMeta);
    const text = typeof meta.answerText === "string" ? meta.answerText : r.excerpt ?? "";
    const citations = Array.isArray(meta.citations) ? meta.citations.filter((c): c is string => typeof c === "string" && host(c) !== null) : [];
    brands.forEach((brand, i) => {
      const answer = analyzeAnswer({ text, citations }, brand);
      const cited = answer.isCited || (i === 0 && r.citationStatus === "cited");
      if (cited) acc[i].queries.add(r.query.trim().toLowerCase());
      for (const url of answer.citedUrls) acc[i].urls.set(url, (acc[i].urls.get(url) ?? 0) + 1);
      const others = brands.filter((_, j) => j !== i).map((b) => b.title);
      const s = analyzeBrandSentiment(text, brand, others);
      if (s.score !== null) acc[i].sentiment.push(s.score);
    });
  }
  return acc.map((a) => ({
    citedQueriesCount: a.queries.size,
    topCitedUrls: [...a.urls].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, topUrls).map(([url, count]) => ({ url, count })),
    sentimentScore: a.sentiment.length ? round2(a.sentiment.reduce((n, s) => n + s, 0) / a.sentiment.length) : null,
  }));
}

type BrandSafetyRow = ReturnType<typeof analyzeSom>["brandSafety"][number];
const SENTIMENT_LABELS = ["positive", "neutral", "negative", "unknown"] as const;
type SentimentLabel = (typeof SENTIMENT_LABELS)[number];
const sentimentCounts = () => Object.fromEntries(SENTIMENT_LABELS.map((l) => [l, 0])) as Record<SentimentLabel, number>;
const asLabel = (l: string): SentimentLabel => (SENTIMENT_LABELS as readonly string[]).includes(l) ? l as SentimentLabel : "unknown";

/**
 * Site tone and fact-conflict alerts across answers: label counts (overall / per model), the strongest evidence
 * (negative first) and potential hallucinations with the quoted clause and the verified fact it contradicts.
 */
export function summarizeBrandSafety(rows: BrandSafetyRow[], limit = 30) {
  const overall = sentimentCounts();
  const perModel: Record<string, Record<SentimentLabel, number>> = {};
  const scores: number[] = [];
  for (const r of rows) {
    const label = asLabel(r.sentiment.label);
    overall[label]++;
    (perModel[r.model] ??= sentimentCounts())[label]++;
    if (r.sentiment.score !== null) scores.push(r.sentiment.score);
  }
  const rank: Record<SentimentLabel, number> = { negative: 0, positive: 1, neutral: 2, unknown: 3 };
  const evidence = rows.filter((r) => r.sentiment.label !== "unknown")
    .sort((a, b) => rank[asLabel(a.sentiment.label)] - rank[asLabel(b.sentiment.label)] || +b.checkedAt - +a.checkedAt)
    .slice(0, limit)
    .map((r) => ({
      recordId: r.recordId, query: r.query, model: r.model, checkedAt: r.checkedAt, label: r.sentiment.label,
      score: r.sentiment.score === null ? null : round2(r.sentiment.score),
      quotes: r.sentiment.evidence.slice(0, 3).map((e) => ({ text: e.text, score: round2(e.score), terms: e.terms })),
    }));
  const findings = rows.flatMap((r) => r.hallucinations.findings.map((f) => ({ recordId: r.recordId, query: r.query, model: r.model, checkedAt: r.checkedAt, ...f })))
    .sort((a, b) => +b.checkedAt - +a.checkedAt);
  return {
    method: { sentiment: rows[0]?.sentiment.method ?? null, hallucinations: rows[0]?.hallucinations.method ?? null },
    samples: rows.length,
    sentiment: { ...overall, averageScore: scores.length ? round2(scores.reduce((n, x) => n + x, 0) / scores.length) : null },
    perModel,
    evidence,
    hallucinations: {
      checkedFacts: Math.max(0, ...rows.map((r) => r.hallucinations.checkedFacts)),
      findingCount: rows.reduce((n, r) => n + r.hallucinations.findingCount, 0),
      affectedAnswers: rows.filter((r) => r.hallucinations.status === "needs_review").length,
      items: findings.slice(0, limit),
    },
    textCoverage: { full: rows.filter((r) => r.textCoverage === "full").length, truncated: rows.filter((r) => r.textCoverage !== "full").length },
  };
}

/** Stored synthetic-query intent when the gap query is a saved test prompt, otherwise the keyword classifier. */
async function gapIntents(siteId: string, queries: string[]) {
  const fingerprints = [...new Set(queries.map(fingerprintQuery))];
  const stored = fingerprints.length
    ? await prisma.syntheticQuery.findMany({ where: { siteId, fingerprint: { in: fingerprints } }, select: { fingerprint: true, intent: true } })
    : [];
  const known = new Map(stored.filter((q) => (QUERY_INTENTS as readonly string[]).includes(q.intent)).map((q) => [q.fingerprint, q.intent as QueryIntent]));
  return (query: string) => {
    const intent = known.get(fingerprintQuery(query));
    return intent ? { intent, intentSource: "synthetic_query" as const } : { intent: classifyIntent(query), intentSource: "classifier" as const };
  };
}

async function recompute(siteId: string, days: number) {
  const site = await getSiteOrThrow(siteId);
  const parsed = visibilityAnalysisSettings.safeParse(object(site.settings).visibilityAnalysis ?? {});
  const configured = parsed.success ? parsed.data.competitors : [];
  const som = await getSomAnalysis(siteId, days);
  const since = new Date(Date.now() - days * 86_400_000);
  // Same window and cap as getSomAnalysis.
  const records = await prisma.llmVisibilityRecord.findMany({
    where: { siteId, checkedAt: { gte: since } },
    orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
    take: 1000,
  });
  // analyzeSom drops overlapping competitors; its brand list is the source of truth for who is compared.
  const metrics = som.overall.brands;
  const brands: Brand[] = metrics.map((m, i) => ({
    title: m.title,
    domain: m.domain,
    url: i === 0 ? site.url : configured.find((c) => host(c.url) === m.domain)?.url ?? `https://${m.domain}`,
  }));
  const evidence = brandEvidence(brands, records);
  const mentionTotal = metrics.reduce((n, m) => n + m.mentions, 0);
  const gapCount = (domain: string) => som.citationGaps.filter((g) => g.competitors.some((c) => c.domain === domain)).length;
  const now = new Date();
  const rows = brands.map((b, i) => ({
    competitorDomain: b.domain,
    competitorName: b.title,
    shareOfModel: metrics[i].citationShare ?? 0,
    mentionShare: mentionTotal ? round2((metrics[i].mentions / mentionTotal) * 100) : null,
    citedQueriesCount: evidence[i].citedQueriesCount,
    gapQueriesCount: i === 0 ? 0 : gapCount(b.domain),
    topCitedUrls: evidence[i].topCitedUrls,
    sentimentScore: evidence[i].sentimentScore,
    samples: som.overall.samples,
    windowDays: days,
    lastCheckedAt: now,
  }));
  const [own, ...competitors] = rows;
  await prisma.$transaction([
    prisma.competitorAnalysis.deleteMany({ where: { siteId, competitorDomain: { notIn: competitors.map((c) => c.competitorDomain) } } }),
    ...competitors.map((c) =>
      prisma.competitorAnalysis.upsert({
        where: { siteId_competitorDomain: { siteId, competitorDomain: c.competitorDomain } },
        create: { siteId, ...c },
        update: c,
      }),
    ),
  ]);
  return { som, own, records, site, config: parsed.success ? parsed.data : visibilityAnalysisSettings.parse({}), settingsValid: parsed.success };
}

/** Site vs competitors: SoM, citation gaps (queries a rival wins) and per-model citation shares. */
export async function getCompetitorReport(siteId: string, q: z.infer<typeof competitorQuerySchema>) {
  const fresh = q.refresh ? await recompute(siteId, q.days) : (await getSiteOrThrow(siteId), null);
  const competitors = await prisma.competitorAnalysis.findMany({
    where: { siteId },
    orderBy: [{ shareOfModel: "desc" }, { competitorDomain: "asc" }],
  });
  if (!fresh) return { refreshed: false, site: null, competitors, citationGaps: [], perModel: null, window: null, warnings: [] };
  const { som, own } = fresh;
  const intentOf = await gapIntents(siteId, som.citationGaps.map((g) => g.query));
  const gapIntentCounts = Object.fromEntries(QUERY_INTENTS.map((i) => [i, 0])) as Record<QueryIntent, number>;
  for (const g of som.citationGaps) gapIntentCounts[intentOf(g.query).intent]++;
  return {
    refreshed: true,
    method: som.method,
    site: own,
    competitors,
    citationGaps: som.citationGaps.slice(0, q.gapLimit).map((g) => ({
      query: g.query, model: g.model, checkedAt: g.checkedAt, targetMentioned: g.targetMentioned, targetPage: g.targetPage, ...intentOf(g.query),
      competitors: g.competitors.map((c) => ({ domain: c.domain, urls: c.urls.map((u) => u.url), missingFactors: [...new Set(c.urls.flatMap((u) => u.citeMagnet.missingFactors))] })),
    })),
    citationGapTotal: som.citationGaps.length,
    gapIntents: gapIntentCounts,
    perModel: Object.fromEntries(
      Object.entries(som.perModel).map(([model, d]) => [model, {
        samples: d.samples,
        shares: d.brands.map((b) => ({ domain: b.domain, citationShare: b.citationShare, recommendationShare: b.recommendationShare, citations: b.citations })),
      }]),
    ),
    trend: {
      granularity: q.granularity,
      points: somTrend({ title: fresh.site.title, url: fresh.site.url }, fresh.records, fresh.config, q.granularity),
    },
    brandSafety: summarizeBrandSafety(som.brandSafety, q.evidenceLimit),
    window: som.window,
    settingsValid: fresh.settingsValid,
    warnings: som.warnings,
  };
}
