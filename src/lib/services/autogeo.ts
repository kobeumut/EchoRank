// AutoGEO integration: turns the crawler's page-level AutoGEO reports (services/crawler
// `geo_crawler.scoring.autogeo`, shipped under `autogeo` in the `geo-audit --db-records` payload) into
// "What to do?" ActionItems with copy-paste Markdown/HTML diffs, plus a compact summary for GeoAudit.metrics.
//
// The text this module writes itself (metric labels, item titles / descriptions, snippet instructions) comes from the
// `autogeo.*` message catalog in the requested `locale` (default English). The engine's own text (rationale, metric
// details, rewrites) arrives in the payload and is passed through untouched. Stored items keep the language they were
// generated in.
//
// Research basis: GEO (KDD 2024, arXiv:2311.09735) and AutoGEO (ICLR 2026, arXiv:2510.11438).
import { z } from "zod";
import { prisma } from "../db";
import type { ActionCategory, ActionEffort, ActionImpact } from "../constants";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { serverT } from "../i18n/request";
import type { Translator } from "../i18n/translate";
import { getSiteOrThrow } from "./sites";

export const AUTOGEO_METRICS = [
  "statistics",
  "quotations",
  "citations",
  "answer_capsules",
  "authority_fluency",
  "keyword_stuffing",
] as const;
export type AutoGeoMetricKey = (typeof AUTOGEO_METRICS)[number];
export const AUTOGEO_RULE_PREFIX = "autogeo.";

/** Per-metric defaults. `labelKey` / `instructionsKey` are `autogeo.metric.*` catalog keys (resolve with `t`). */
export const AUTOGEO_METRIC_INFO: Record<
  AutoGeoMetricKey,
  { labelKey: string; category: ActionCategory; effort: ActionEffort; instructionsKey: string }
> = {
  statistics: { labelKey: "autogeo.metric.statistics.label", category: "content", effort: "medium", instructionsKey: "autogeo.metric.statistics.instructions" },
  quotations: { labelKey: "autogeo.metric.quotations.label", category: "authority", effort: "medium", instructionsKey: "autogeo.metric.quotations.instructions" },
  citations: { labelKey: "autogeo.metric.citations.label", category: "authority", effort: "medium", instructionsKey: "autogeo.metric.citations.instructions" },
  answer_capsules: { labelKey: "autogeo.metric.answer_capsules.label", category: "content", effort: "low", instructionsKey: "autogeo.metric.answer_capsules.instructions" },
  authority_fluency: { labelKey: "autogeo.metric.authority_fluency.label", category: "content", effort: "low", instructionsKey: "autogeo.metric.authority_fluency.instructions" },
  keyword_stuffing: { labelKey: "autogeo.metric.keyword_stuffing.label", category: "content", effort: "low", instructionsKey: "autogeo.metric.keyword_stuffing.instructions" },
};

/** Human-readable metric name in the translator's language. */
export const autoGeoMetricLabel = (metric: AutoGeoMetricKey, t: Translator) => t(AUTOGEO_METRIC_INFO[metric].labelKey);

// ---------------------------------------------------------------- payload schema (snake_case from Python)

const num = z.number().finite();
export const autoGeoImprovementSchema = z
  .object({
    rule_id: z.string().max(100),
    metric: z.string().max(50),
    metrics: z.array(z.string().max(50)).max(10).optional(),
    kind: z.enum(["rewrite", "insert"]),
    title: z.string().max(500),
    rationale: z.string().max(5000).default(""),
    block_index: z.number().int().nullish(),
    before_markdown: z.string().max(50_000).default(""),
    after_markdown: z.string().max(50_000),
    after_html: z.string().max(50_000).default(""),
    diff_markdown: z.string().max(100_000).optional(),
    diff_html: z.string().max(100_000).optional(),
    expected_gain_pct: num.default(0),
  })
  .passthrough();

export const autoGeoMetricSchema = z
  .object({
    key: z.string(),
    label: z.string().optional(),
    score: num.min(0).max(100),
    weight: num.optional(),
    passed: z.boolean().optional(),
    detail: z.string().max(5000).default(""),
    facts: z.record(z.string(), z.unknown()).optional(),
    potential_gain_pct: num.default(0),
  })
  .passthrough();

export const autoGeoPageSchema = z
  .object({
    version: z.string().optional(),
    url: z.string().max(2000),
    page_type: z.string().max(50).default("other"),
    language: z.string().max(10).optional(),
    word_count: z.number().int().min(0).default(0),
    score: num.min(0).max(100),
    grade: z.string().max(2).optional(),
    caps: z.array(z.string()).default([]),
    metrics: z.record(z.string(), autoGeoMetricSchema),
    improvements: z.array(autoGeoImprovementSchema).max(200).default([]),
    answer_capsule: z.object({ text: z.string(), word_count: z.number(), markdown: z.string(), html: z.string() }).passthrough().nullish(),
    comparison_table: z.object({ markdown: z.string(), html: z.string() }).passthrough().nullish(),
  })
  .passthrough();

export const autoGeoReportSchema = z
  .object({
    version: z.string().max(20).default("1.0"),
    score: num.min(0).max(100),
    metrics: z.record(z.string(), num).default({}),
    page_count: z.number().int().min(0).optional(),
    pages: z.array(autoGeoPageSchema).max(200).default([]),
  })
  .passthrough();

export type AutoGeoImprovement = z.infer<typeof autoGeoImprovementSchema>;
export type AutoGeoPage = z.infer<typeof autoGeoPageSchema>;
export type AutoGeoReport = z.infer<typeof autoGeoReportSchema>;

/** Row shape accepted by `applyAuditResult` (mirrors `auditActionItemSchema`). */
export type AutoGeoActionItem = {
  title: string;
  description: string;
  category: ActionCategory;
  impact: ActionImpact;
  effort: ActionEffort;
  ruleId: string;
  priority: number;
  targetUrl: string;
  details: Record<string, unknown>;
};

// ---------------------------------------------------------------- unified diff

type Op = { t: " " | "-" | "+"; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  // LCS table; pages' blocks are small (a few dozen lines), so O(n*m) is fine.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ t: "-", line: a[i++] });
    else ops.push({ t: "+", line: b[j++] });
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").split("\n"));
const range = (start: number, len: number) => (len === 1 ? `${start}` : `${len === 0 ? start - 1 : start},${len}`);

/** GNU-style unified diff (`--- a/x` / `+++ b/x` / `@@ -l,s +l,s @@`); empty string when nothing changed. */
export function createUnifiedDiff(
  before: string,
  after: string,
  opts: { fromFile?: string; toFile?: string; context?: number } = {},
): string {
  const ctx = opts.context ?? 2;
  const ops = diffOps(splitLines(before), splitLines(after));
  if (!ops.some((o) => o.t !== " ")) return "";
  const out = [`--- ${opts.fromFile ?? "a/content.md"}`, `+++ ${opts.toFile ?? "b/content.md"}`];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].t === " ") k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - ctx);
    // extend the hunk while changes are within 2*ctx lines of each other
    let end = k;
    for (let p = k; p < ops.length; p++) {
      if (ops[p].t !== " ") end = p;
      else if (p - end > 2 * ctx) break;
    }
    const stop = Math.min(ops.length, end + ctx + 1);
    let oldStart = 1;
    let newStart = 1;
    for (let p = 0; p < start; p++) {
      if (ops[p].t !== "+") oldStart++;
      if (ops[p].t !== "-") newStart++;
    }
    const hunk = ops.slice(start, stop);
    const oldLen = hunk.filter((o) => o.t !== "+").length;
    const newLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${range(oldStart, oldLen)} +${range(newStart, newLen)} @@`);
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = stop;
  }
  return out.join("\n");
}

/** Applies a unified diff produced by `createUnifiedDiff` (or Python difflib); throws if it does not match. */
export function applyUnifiedDiff(before: string, diff: string): string {
  const src = splitLines(before);
  const out: string[] = [];
  let pos = 0;
  const lines = splitLines(diff);
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!h) continue;
    const oldLen = h[2] === undefined ? 1 : Number(h[2]);
    const start = oldLen === 0 ? Number(h[1]) : Number(h[1]) - 1;
    if (start < pos) throw new Error("Overlapping hunks");
    out.push(...src.slice(pos, start));
    pos = start;
    for (i++; i < lines.length && !lines[i].startsWith("@@"); i++) {
      const l = lines[i];
      const body = l.slice(1);
      if (l.startsWith("+")) out.push(body);
      else if (l.startsWith("-") || l.startsWith(" ")) {
        if (src[pos] !== body) throw new Error(`Diff does not apply at line ${pos + 1}`);
        if (l.startsWith(" ")) out.push(body);
        pos++;
      }
    }
    i--;
  }
  out.push(...src.slice(pos));
  return out.join("\n");
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, "") || "index";
  } catch {
    return "content";
  }
};

/** Markdown + HTML patches for one improvement. Reuses the crawler's diffs, regenerating any that are missing. */
export function improvementPatches(imp: AutoGeoImprovement, url: string): { markdown: string; html: string } {
  const p = pathOf(url);
  const join = (a: string, b: string) => (a ? `${a}\n\n${b}` : b);
  const afterMd = imp.kind === "insert" ? join(imp.before_markdown, imp.after_markdown) : imp.after_markdown;
  const markdown =
    imp.diff_markdown || createUnifiedDiff(imp.before_markdown, afterMd, { fromFile: `a/${p}.md`, toFile: `b/${p}.md` });
  const html =
    imp.diff_html ||
    (imp.after_html
      ? createUnifiedDiff("", imp.after_html, { fromFile: `a/${p}.html`, toFile: `b/${p}.html` })
      : "");
  return { markdown, html };
}

// ---------------------------------------------------------------- ActionItems

const IMPACT_W: Record<ActionImpact, number> = { high: 3, medium: 2, low: 1 };
const EFFORT_W: Record<ActionEffort, number> = { low: 1, medium: 2, high: 3 };
const isMetric = (k: string): k is AutoGeoMetricKey => (AUTOGEO_METRICS as readonly string[]).includes(k);
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function impactOf(gain: number, metric: AutoGeoMetricKey, page: AutoGeoPage): ActionImpact {
  const risk = page.metrics.keyword_stuffing?.facts?.risk;
  if (metric === "keyword_stuffing" && risk === "-25%") return "high";
  return gain >= 15 ? "high" : gain >= 6 ? "medium" : "low";
}

function priorityOf(impact: ActionImpact, effort: ActionEffort, gain: number): number {
  return Math.round(((IMPACT_W[impact] * 10 + 2 * Math.min(gain, 40)) / EFFORT_W[effort] ** 0.7) * 100) / 100;
}

function serializeImprovement(imp: AutoGeoImprovement, url: string) {
  const patches = improvementPatches(imp, url);
  return {
    title: imp.title,
    kind: imp.kind,
    metrics: imp.metrics ?? [imp.metric],
    rationale: imp.rationale,
    blockIndex: imp.block_index ?? null,
    expectedGainPct: imp.expected_gain_pct,
    afterMarkdown: imp.after_markdown,
    afterHtml: imp.after_html,
    diffMarkdown: patches.markdown,
    diffHtml: patches.html,
  };
}

function buildItem(
  t: Translator,
  page: AutoGeoPage,
  ruleId: string,
  metric: AutoGeoMetricKey,
  title: string,
  imps: AutoGeoImprovement[],
  gain: number,
  extra: Record<string, unknown> = {},
): AutoGeoActionItem {
  const info = AUTOGEO_METRIC_INFO[metric];
  const metricLabel = autoGeoMetricLabel(metric, t);
  const m = page.metrics[metric];
  const effort: ActionEffort = imps.length > 3 && info.effort === "low" ? "medium" : info.effort;
  const impact = impactOf(gain, metric, page);
  const serialized = imps.map((i) => serializeImprovement(i, page.url));
  const p = pathOf(page.url);
  const patch = serialized.map((s) => s.diffMarkdown).filter(Boolean).join("\n");
  const others = [...new Set(imps.flatMap((i) => i.metrics ?? []).filter((k) => k !== metric && isMetric(k)))];
  const description = [
    m ? t("autogeo.item.description.score", { label: metricLabel, score: Math.round(m.score), detail: m.detail }) : metricLabel,
    t("autogeo.item.description.gain", { gain: gain.toFixed(1) }),
    others.length ? t("autogeo.item.description.others", { labels: others.map((k) => autoGeoMetricLabel(k as AutoGeoMetricKey, t)).join(", ") }) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    title: truncate(title, 300),
    description: truncate(description, 5000),
    category: info.category,
    impact,
    effort,
    ruleId,
    priority: priorityOf(impact, effort, gain),
    targetUrl: page.url,
    details: {
      source: "autogeo",
      check_id: `autogeo_${metric}`,
      metric,
      score: m ? Math.round(m.score) : null,
      pageScore: Math.round(page.score),
      pageType: page.page_type,
      evidence: m?.detail ? [m.detail] : [],
      expected_gain: Math.round(gain * 10) / 10,
      affected_urls: [page.url],
      affected_count: 1,
      snippet: patch
        ? { language: "diff", code: patch, filename: `${p}.md`, instructions: t(info.instructionsKey) }
        : null,
      improvements: serialized,
      ...extra,
    },
  };
}

/**
 * One ActionItem per (page, metric) that needs work, carrying every block-level improvement for that metric.
 * ruleId `autogeo.<metric>` + targetUrl keeps the item stable across audits (see `applyAuditResult`), so a
 * fixed page auto-resolves its item on the next audit. `opts.locale` selects the language of the generated titles,
 * descriptions and snippet instructions (default English); engine text from the payload is passed through as is.
 */
export function autogeoToActionItems(
  report: AutoGeoReport,
  opts: { maxItems?: number; passScore?: number; locale?: Locale } = {},
): AutoGeoActionItem[] {
  const t = serverT(opts.locale ?? DEFAULT_LOCALE);
  const maxItems = opts.maxItems ?? 150;
  const passScore = opts.passScore ?? 70;
  const items: AutoGeoActionItem[] = [];
  for (const page of report.pages) {
    const byMetric = new Map<AutoGeoMetricKey, AutoGeoImprovement[]>();
    const tables: AutoGeoImprovement[] = [];
    for (const imp of page.improvements) {
      if (imp.rule_id === "autogeo.comparison_table") {
        tables.push(imp);
        continue;
      }
      for (const k of imp.metrics?.length ? imp.metrics : [imp.metric]) {
        if (!isMetric(k)) continue;
        byMetric.set(k, [...(byMetric.get(k) ?? []), imp]);
      }
    }
    for (const metric of AUTOGEO_METRICS) {
      const m = page.metrics[metric];
      const imps = byMetric.get(metric) ?? [];
      if (!m || (m.score >= passScore && imps.length === 0)) continue;
      const gain = m.potential_gain_pct || imps.reduce((s, i) => s + i.expected_gain_pct, 0);
      const label = autoGeoMetricLabel(metric, t);
      const path = pathOf(page.url).replace(/^index$/, "");
      const title = imps.length
        ? t("autogeo.item.title", { label, count: imps.length, path })
        : t("autogeo.item.titleWeak", { label, path });
      items.push(buildItem(t, page, `${AUTOGEO_RULE_PREFIX}${metric}`, metric, title, imps, gain));
    }
    if (tables.length) {
      const gain = tables.reduce((s, i) => s + i.expected_gain_pct, 0);
      items.push(
        buildItem(t, page, "autogeo.comparison_table", "statistics",
          t("autogeo.item.titleComparison", { path: pathOf(page.url).replace(/^index$/, "") }), tables, gain,
          { comparisonTable: page.comparison_table ?? null }),
      );
    }
    if (page.answer_capsule && (page.metrics.answer_capsules?.score ?? 100) < passScore) {
      const capsuleItem = items.find(
        (i) => i.ruleId === "autogeo.answer_capsules" && i.targetUrl === page.url,
      );
      if (capsuleItem) capsuleItem.details.answerCapsule = page.answer_capsule;
    }
  }
  return items.sort((a, b) => b.priority - a.priority).slice(0, Math.max(0, maxItems));
}

/** Compact summary stored in `GeoAudit.metrics.autogeo` (full diffs live on the ActionItems). */
export function summarizeAutoGeo(report: AutoGeoReport) {
  return {
    version: report.version,
    score: Math.round(report.score),
    metrics: Object.fromEntries(Object.entries(report.metrics).map(([k, v]) => [k, Math.round(v)])),
    pageCount: report.pages.length,
    pages: report.pages.map((p) => ({
      url: p.url,
      pageType: p.page_type,
      score: Math.round(p.score),
      grade: p.grade ?? null,
      wordCount: p.word_count,
      caps: p.caps,
      metrics: Object.fromEntries(Object.entries(p.metrics).map(([k, v]) => [k, Math.round(v.score)])),
      improvementCount: p.improvements.length,
      answerCapsule: p.answer_capsule?.text ?? null,
    })),
  };
}

export type AutoGeoSummary = ReturnType<typeof summarizeAutoGeo>;

// ---------------------------------------------------------------- read API

/** Latest completed audit's AutoGEO summary plus the open AutoGEO action items (highest priority first). */
export async function getSiteAutoGeo(siteId: string) {
  await getSiteOrThrow(siteId);
  const audits = await prisma.geoAudit.findMany({
    where: { siteId, status: "completed" },
    orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 10,
    select: { id: true, completedAt: true, metrics: true },
  });
  const audit = audits.find((a) => a.metrics && typeof a.metrics === "object" && "autogeo" in (a.metrics as object));
  const items = await prisma.actionItem.findMany({
    where: { siteId, ruleId: { startsWith: AUTOGEO_RULE_PREFIX }, status: { in: ["open", "in_progress"] } },
    orderBy: [{ priority: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 500,
  });
  return {
    auditId: audit?.id ?? null,
    completedAt: audit?.completedAt ?? null,
    summary: audit ? ((audit.metrics as Record<string, unknown>).autogeo as AutoGeoSummary) : null,
    items,
  };
}
