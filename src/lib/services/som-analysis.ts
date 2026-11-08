import { prisma } from "../db";
import {
  analyzeAnswer, analyzeBrandSentiment, auditBrandClaims, host, VISIBILITY_MODELS,
  visibilityAnalysisSettings, type VisibilityAnalysisSettings, type VisibilityModel,
} from "../visibility-analysis";
import { getSiteOrThrow } from "./sites";

type Brand = { title: string; url: string };
type Observation = {
  id: string; model: string; query: string; citationStatus: string; position: number | null;
  excerpt: string | null; responseMeta: unknown; checkedAt: Date;
};
export type CiteMagnetPage = {
  url: string; observedAt: string; wordCount?: number; schemaTypes?: string[];
  tableCount?: number; text?: string; textComplete?: boolean;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const matches = (url: string, brand: Brand) => {
  const source = host(url), target = host(brand.url);
  return !!source && !!target && (source === target || source.endsWith(`.${target}`));
};
const percent = (n: number, d: number) => d ? Math.round(n / d * 10000) / 100 : null;
const pageKey = (url: string) => { const parsed = new URL(url); parsed.hash = ""; return parsed.href; };

/** No page fetching: structured crawler snapshots and explicitly supplied reference evidence only. */
export function analyzeCiteMagnet(page: CiteMagnetPage) {
  const statistics = page.text?.match(/\b\d+(?:[.,]\d+)?\s*(?:%|percent\b|yüzde\b)/giu) ?? [];
  return {
    url: page.url, observedAt: page.observedAt,
    wordCount: page.wordCount ?? null,
    schemaTypes: page.schemaTypes ?? null,
    tableCount: page.tableCount ?? null,
    statisticCount: page.text === undefined ? null : statistics.length,
    statisticsPer100Words: page.textComplete && page.wordCount ? percent(statistics.length, page.wordCount) : null,
    statisticsCoverage: page.text === undefined ? "unknown" : page.textComplete ? "full" : "excerpt_lower_bound",
  };
}

function comparePages(reference: CiteMagnetPage | undefined, target: CiteMagnetPage | undefined) {
  if (!reference) return { status: "reference_snapshot_missing", reference: null, target: target ? analyzeCiteMagnet(target) : null, missingFactors: [] as string[] };
  const r = analyzeCiteMagnet(reference), t = target ? analyzeCiteMagnet(target) : null;
  const missingFactors: string[] = [];
  if (t) {
    if (r.wordCount !== null && t.wordCount !== null && r.wordCount > t.wordCount) missingFactors.push("less_word_coverage");
    if (r.schemaTypes?.length && t.schemaTypes && !t.schemaTypes.length) missingFactors.push("no_structured_schema");
    if (r.tableCount !== null && r.tableCount > 0 && t.tableCount === 0) missingFactors.push("no_data_tables");
    if (r.statisticsPer100Words !== null && t.statisticsPer100Words !== null && r.statisticsPer100Words > t.statisticsPer100Words) missingFactors.push("lower_statistics_density");
  }
  return { status: t ? "compared" : "target_snapshot_missing", reference: r, target: t, missingFactors };
}

/** Shares are among configured brands, once per answer/brand, not the global AI market. */
export function analyzeSom(
  site: Brand, records: Observation[], config: VisibilityAnalysisSettings = visibilityAnalysisSettings.parse({}),
  pages: CiteMagnetPage[] = [],
) {
  const warnings: string[] = [];
  const brands = [site];
  for (const rival of config.competitors) {
    if (brands.some((b) => matches(rival.url, b) || matches(b.url, rival) || b.title.toLowerCase() === rival.title.toLowerCase())) {
      warnings.push(`Overlapping competitor ignored: ${rival.url}`);
    } else brands.push(rival);
  }
  const seen = new Set<string>();
  const observations = records.filter((r) => {
    if (!VISIBILITY_MODELS.includes(r.model as VisibilityModel) || seen.has(r.id)) return false;
    seen.add(r.id); return true;
  }).map((record) => {
    const meta = object(record.responseMeta);
    const text = typeof meta.answerText === "string" ? meta.answerText : record.excerpt ?? "";
    const citations = Array.isArray(meta.citations) ? meta.citations.filter((c): c is string => typeof c === "string" && host(c) !== null) : [];
    const evidence = brands.map((brand, i) => {
      const result = analyzeAnswer({ text, citations }, brand);
      return {
        domain: host(brand.url)!, ...result,
        isCited: result.isCited || (i === 0 && record.citationStatus === "cited"),
        position: i === 0 ? record.position : result.position,
      };
    });
    return {
      record, evidence,
      textCoverage: typeof meta.answerText === "string" && meta.answerTruncated === false ? "full" : "truncated_or_legacy",
      sentiment: analyzeBrandSentiment(text, site, brands.slice(1).map((b) => b.title)),
      hallucinations: auditBrandClaims(text, config.facts, record.checkedAt, brands.slice(1).map((b) => b.title)),
    };
  });
  function distribution(rows: typeof observations) {
    const metrics = brands.map((b, i) => {
      const entries = rows.map((o) => o.evidence[i]);
      const citations = entries.filter((e) => e.isCited).length;
      // ponytail: reciprocal explicit rank; unranked mentions contribute no recommendation points.
      const recommendationPoints = entries.reduce((n, e) => n + (e.isMentioned && e.position && e.position > 0 ? 1 / e.position : 0), 0);
      return { title: b.title, domain: host(b.url)!, citations, citationRate: percent(citations, rows.length), mentions: entries.filter((e) => e.isMentioned).length, recommendationPoints };
    });
    const citationTotal = metrics.reduce((n, m) => n + m.citations, 0);
    const recommendationTotal = metrics.reduce((n, m) => n + m.recommendationPoints, 0);
    return { samples: rows.length, citationTotal, recommendationTotal, brands: metrics.map((m) => ({
      ...m, citationShare: percent(m.citations, citationTotal), recommendationShare: percent(m.recommendationPoints, recommendationTotal),
    })) };
  }
  const citationGaps = observations.filter((o) => !o.evidence[0].isCited && o.evidence.slice(1).some((e) => e.isCited)).map((o) => {
    const tokens = o.record.query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const targetPages = pages.filter((p) => matches(p.url, site) && Date.parse(p.observedAt) <= +o.record.checkedAt);
    // Topic matching is a heuristic, never evidence that a page caused a citation.
    const ranked = targetPages.map((p) => ({ page: p, score: tokens.filter((t) => (p.url + " " + (p.text ?? "")).toLowerCase().includes(t)).length }))
      .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url));
    const target = ranked[0]?.score > 0 ? ranked[0].page : undefined;
    return {
      recordId: o.record.id, query: o.record.query, model: o.record.model, checkedAt: o.record.checkedAt,
      reason: "target_uncited_configured_competitor_cited", targetMentioned: o.evidence[0].isMentioned,
      targetPageMethod: "query-token-overlap", targetPage: target?.url ?? null,
      competitors: o.evidence.slice(1).filter((e) => e.isCited).map((e) => ({ domain: e.domain, urls: e.citedUrls.map((url) => ({
        url, citeMagnet: comparePages(config.referencePages.find((p) => pageKey(p.url) === pageKey(url) && Date.parse(p.observedAt) <= +o.record.checkedAt), target),
      })) })),
    };
  });
  return {
    method: "configured-brand-answer-frequency-reciprocal-rank-v1", warnings,
    overall: distribution(observations),
    perModel: Object.fromEntries(VISIBILITY_MODELS.map((model) => [model, distribution(observations.filter((o) => o.record.model === model))])),
    citationGaps,
    brandSafety: observations.map((o) => ({ recordId: o.record.id, query: o.record.query, model: o.record.model, textCoverage: o.textCoverage, sentiment: o.sentiment, hallucinations: o.hallucinations })),
  };
}

function schemaTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaTypes);
  const obj = object(value);
  const types = typeof obj["@type"] === "string" ? [obj["@type"]] : Array.isArray(obj["@type"]) ? obj["@type"].filter((t): t is string => typeof t === "string") : [];
  return [...new Set([...types, ...Object.entries(obj).filter(([k]) => k !== "@type").flatMap(([, v]) => v && typeof v === "object" ? schemaTypes(v) : [])])];
}

/** Latest 1,000 successful observations in the window, independent of history pagination. */
export async function getSomAnalysis(siteId: string, days = 30) {
  const site = await getSiteOrThrow(siteId);
  const settings = object(site.settings).visibilityAnalysis;
  const parsed = visibilityAnalysisSettings.safeParse(settings ?? {});
  const config = parsed.success ? parsed.data : visibilityAnalysisSettings.parse({});
  const since = new Date(Date.now() - days * 86400_000);
  const [records, storedPages, total] = await Promise.all([
    prisma.llmVisibilityRecord.findMany({ where: { siteId, checkedAt: { gte: since } }, orderBy: [{ checkedAt: "desc" }, { id: "desc" }], take: 1000 }),
    prisma.crawledPage.findMany({ where: { siteId }, orderBy: [{ crawledAt: "desc" }, { url: "asc" }], take: 101 }),
    prisma.llmVisibilityRecord.count({ where: { siteId, checkedAt: { gte: since } } }),
  ]);
  const pages = storedPages.slice(0, 100).map((p): CiteMagnetPage => {
    const data = object(p.data), stats = object(data.content_stats);
    return {
      url: p.url, observedAt: p.crawledAt.toISOString(), wordCount: p.wordCount,
      schemaTypes: data.json_ld === undefined && data.microdata === undefined ? undefined : schemaTypes([data.json_ld, data.microdata]),
      tableCount: typeof stats.tables === "number" && stats.tables >= 0 ? stats.tables : undefined,
      text: typeof data.text === "string" ? data.text : typeof data.text_excerpt === "string" ? data.text_excerpt : undefined,
      textComplete: typeof data.text === "string",
    };
  });
  return {
    ...analyzeSom(site, records, config, pages),
    window: { days, since, total, limit: 1000, truncated: total > records.length, pageLimit: 100, pagesTruncated: storedPages.length > 100 },
    settingsValid: parsed.success,
  };
}
