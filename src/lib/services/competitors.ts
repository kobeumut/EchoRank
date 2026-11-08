// Competitor Share-of-Model snapshots: recomputes the SoM analysis (som-analysis.ts) over stored visibility checks and
// persists one CompetitorAnalysis row per configured competitor (settings.visibilityAnalysis.competitors).
// Shares are among the site + configured competitors only, never the whole AI answer market.
import { z } from "zod";
import { prisma } from "../db";
import { analyzeAnswer, analyzeBrandSentiment, host, visibilityAnalysisSettings, VISIBILITY_MODELS, type VisibilityModel } from "../visibility-analysis";
import { queryBool } from "../validation";
import { getSiteOrThrow } from "./sites";
import { getSomAnalysis } from "./som-analysis";

export const competitorQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  /** false -> return the stored snapshot without recomputing. */
  refresh: queryBool.default(true),
  gapLimit: z.coerce.number().int().min(0).max(200).default(50),
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
    select: { id: true, model: true, query: true, excerpt: true, responseMeta: true, citationStatus: true },
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
  return { som, own, settingsValid: parsed.success };
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
  return {
    refreshed: true,
    method: som.method,
    site: own,
    competitors,
    citationGaps: som.citationGaps.slice(0, q.gapLimit).map((g) => ({
      query: g.query, model: g.model, checkedAt: g.checkedAt, targetMentioned: g.targetMentioned, targetPage: g.targetPage,
      competitors: g.competitors.map((c) => ({ domain: c.domain, urls: c.urls.map((u) => u.url), missingFactors: [...new Set(c.urls.flatMap((u) => u.citeMagnet.missingFactors))] })),
    })),
    citationGapTotal: som.citationGaps.length,
    perModel: Object.fromEntries(
      Object.entries(som.perModel).map(([model, d]) => [model, { samples: d.samples, shares: d.brands.map((b) => ({ domain: b.domain, citationShare: b.citationShare })) }]),
    ),
    window: som.window,
    settingsValid: fresh.settingsValid,
    warnings: som.warnings,
  };
}
