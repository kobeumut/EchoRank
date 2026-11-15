// Share of Model / competitor intelligence panel helpers over GET /api/sites/:id/competitors (pure, no React).

import type { CitationGap, CompetitorReport, QueryIntent, SentimentCounts, SentimentLabel } from "@/components/dashboard/types";
import type { Translator } from "@/lib/i18n/translate";
import { foldCase } from "./highlight";
import type { Tone } from "./format";

/** Display order of the query intents (labels: `competitors.intent.*`). */
export const INTENT_ORDER: QueryIntent[] = ["informational", "comparative", "transactional", "reputation"];
export const intentLabel = (t: Translator, intent: QueryIntent) => t(`competitors.intent.${intent}`);

export const sentimentLabel = (t: Translator, label: SentimentLabel) => t(`competitors.sentiment.${label}`);
export const SENTIMENT_TONE: Record<SentimentLabel, Tone> = { positive: "good", neutral: "neutral", negative: "critical", unknown: "neutral" };

/** "Cite-Magnet" hints for som-analysis missingFactors: why the rival page was picked over ours (keys: `competitors.citeMagnet.<factor>.*`). */
export const CITE_MAGNET_FACTORS = ["less_word_coverage", "no_structured_schema", "no_data_tables", "lower_statistics_density"] as const;
export function citeMagnetTip(factor: string, t: Translator) {
  return (CITE_MAGNET_FACTORS as readonly string[]).includes(factor)
    ? { label: t(`competitors.citeMagnet.${factor}.label`), tip: t(`competitors.citeMagnet.${factor}.tip`) }
    : { label: factor, tip: t("competitors.citeMagnet.unknown.tip") };
}

/** Site first (series-1), competitors in snapshot order; beyond the 8-color palette fall back to muted gray. */
export function brandColor(index: number) {
  return index < 8 ? `var(--series-${index + 1})` : "var(--chart-muted)";
}

export type BrandRow = {
  domain: string;
  name: string;
  isSite: boolean;
  share: number;
  mentionShare: number | null;
  citedQueries: number;
  gapQueries: number;
  sentimentScore: number | null;
  topCitedUrls: { url: string; count: number }[];
  color: string;
};

export function brandRows(report: Pick<CompetitorReport, "site" | "competitors">): BrandRow[] {
  return [report.site, ...report.competitors].map((s, i) => ({
    domain: s.competitorDomain,
    name: s.competitorName || s.competitorDomain,
    isSite: i === 0,
    share: s.shareOfModel,
    mentionShare: s.mentionShare,
    citedQueries: s.citedQueriesCount,
    gapQueries: s.gapQueriesCount,
    sentimentScore: s.sentimentScore,
    topCitedUrls: s.topCitedUrls ?? [],
    color: brandColor(i),
  }));
}

/** 1-based competition rank of the site by citation share (ties share a rank). */
export function siteRank(rows: BrandRow[]) {
  const site = rows.find((r) => r.isSite);
  return site ? 1 + rows.filter((r) => !r.isSite && r.share > site.share).length : null;
}

export type GapFilter = { intent?: QueryIntent | "all"; model?: string; competitor?: string; search?: string };

export function filterGaps(gaps: CitationGap[], f: GapFilter) {
  const needle = f.search?.trim() ? foldCase(f.search.trim()) : "";
  return gaps.filter(
    (g) =>
      (!f.intent || f.intent === "all" || g.intent === f.intent) &&
      (!f.model || f.model === "all" || g.model === f.model) &&
      (!f.competitor || f.competitor === "all" || g.competitors.some((c) => c.domain === f.competitor)) &&
      (!needle || foldCase(g.query).includes(needle)),
  );
}

/** Matrix columns: competitor domains ordered by how many gap answers they win. */
export function gapDomains(gaps: CitationGap[]) {
  const counts = new Map<string, number>();
  for (const g of gaps) for (const c of g.competitors) counts.set(c.domain, (counts.get(c.domain) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([domain, count]) => ({ domain, count }));
}

/** Distinct missing factors across a gap's competitor pages, for the Cite-Magnet hints. */
export function gapFactors(gap: CitationGap) {
  return [...new Set(gap.competitors.flatMap((c) => c.missingFactors))];
}

export type TrendSeries = { domain: string; color: string; isSite: boolean; values: (number | null)[] };
export function trendSeries(report: Pick<CompetitorReport, "trend">, rows: BrandRow[]): TrendSeries[] {
  return rows.map((r) => ({
    domain: r.domain,
    color: r.color,
    isSite: r.isSite,
    values: report.trend.points.map((p) => p.shares.find((s) => s.domain === r.domain)?.citationShare ?? null),
  }));
}

/** Change of the site's share between the first and the last trend bucket (percentage points). */
export function siteTrendDelta(series: TrendSeries[]) {
  const values = series.find((s) => s.isSite)?.values.filter((v): v is number => v !== null) ?? [];
  return values.length > 1 ? Math.round((values[values.length - 1] - values[0]) * 100) / 100 : null;
}

export function dominantSentiment(counts: SentimentCounts): SentimentLabel {
  const known = (["negative", "positive", "neutral"] as const).filter((l) => counts[l] > 0);
  if (!known.length) return "unknown";
  return known.reduce((best, l) => (counts[l] > counts[best] ? l : best));
}

const csvCell = (v: unknown) => {
  if (v == null) return "";
  let s = Array.isArray(v) ? v.join(" | ") : String(v);
  // Spreadsheet formula injection guard for text cells.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(header: string[], rows: unknown[][]) {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function somCsv(report: CompetitorReport, models: readonly string[]) {
  const rows = brandRows(report);
  const share = (model: string, domain: string) => report.perModel[model]?.shares.find((s) => s.domain === domain)?.citationShare ?? null;
  return toCsv(
    ["domain", "name", "is_site", "share_of_model", "mention_share", "cited_queries", "gap_queries", "sentiment_score", ...models.map((m) => `som_${m}`), "top_cited_urls"],
    rows.map((r) => [r.domain, r.name, r.isSite, r.share, r.mentionShare, r.citedQueries, r.gapQueries, r.sentimentScore, ...models.map((m) => share(m, r.domain)), r.topCitedUrls.map((u) => u.url)]),
  );
}

export function gapsCsv(gaps: CitationGap[]) {
  return toCsv(
    ["query", "intent", "model", "checked_at", "site_mentioned", "site_page", "competitors", "competitor_urls", "missing_factors"],
    gaps.map((g) => [
      g.query, g.intent, g.model, g.checkedAt, g.targetMentioned, g.targetPage,
      g.competitors.map((c) => c.domain), g.competitors.flatMap((c) => c.urls), gapFactors(g),
    ]),
  );
}
