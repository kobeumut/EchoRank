// Persisted AutoGEO suggestions: one row per block-level rewrite/insertion the AutoGEO engine proposes for a page.
// Rows come from a crawler AutoGEO report (audit ingestion or POST /autogeo { report }) or, for audits ingested
// before this table existed, from the AutoGEO ActionItems' stored diffs. A fingerprint over page + rule + snippets
// keeps re-analysis idempotent, and a user's applied/dismissed decision survives every re-run.
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AUTOGEO_RULE_TYPES, SUGGESTION_STATUSES, type AutoGeoRuleType } from "../constants";
import { prisma } from "../db";
import { notFound } from "../http";
import { csvEnum } from "../validation";
import {
  AUTOGEO_RULE_PREFIX, autoGeoReportSchema, getSiteAutoGeo, improvementPatches, type AutoGeoImprovement, type AutoGeoReport,
} from "./autogeo";
import { getSiteOrThrow } from "./sites";

const METRIC_RULE_TYPE: Record<string, AutoGeoRuleType> = {
  statistics: "stats",
  quotations: "quotes",
  citations: "citations",
  answer_capsules: "answer_capsule",
  authority_fluency: "tone",
  keyword_stuffing: "keyword_stuffing",
};

export function ruleTypeOf(ruleId: string, metric?: string): AutoGeoRuleType | null {
  if (ruleId === "autogeo.comparison_table") return "comparison_table";
  return METRIC_RULE_TYPE[metric ?? ruleId.replace(AUTOGEO_RULE_PREFIX, "")] ?? null;
}

export type SuggestionDraft = {
  pageUrl: string;
  ruleType: AutoGeoRuleType;
  ruleId: string | null;
  title: string | null;
  originalSnippet: string;
  suggestedSnippet: string;
  diffMarkdown: string | null;
  expectedGain: number;
  actionItemId?: string | null;
};

export const fingerprintOf = (d: Pick<SuggestionDraft, "pageUrl" | "ruleType" | "originalSnippet" | "suggestedSnippet">) =>
  createHash("sha256").update([d.pageUrl, d.ruleType, d.originalSnippet.trim(), d.suggestedSnippet.trim()].join("\u0000")).digest("hex");

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Drafts from a crawler AutoGEO report. Insertions keep their anchor block, so applying = replace original with suggested. */
export function suggestionsFromReport(report: AutoGeoReport): SuggestionDraft[] {
  const out: SuggestionDraft[] = [];
  for (const page of report.pages) {
    for (const imp of page.improvements) {
      const ruleType = ruleTypeOf(imp.rule_id, imp.rule_id === "autogeo.comparison_table" ? undefined : imp.metric);
      if (!ruleType) continue;
      out.push({
        pageUrl: page.url,
        ruleType,
        ruleId: imp.rule_id,
        title: imp.title.slice(0, 500) || null,
        originalSnippet: imp.before_markdown,
        suggestedSnippet: suggestedOf(imp),
        diffMarkdown: improvementPatches(imp, page.url).markdown || null,
        expectedGain: round1(imp.expected_gain_pct),
      });
    }
  }
  return out;
}

function suggestedOf(imp: Pick<AutoGeoImprovement, "kind" | "before_markdown" | "after_markdown">) {
  return imp.kind === "insert" && imp.before_markdown ? `${imp.before_markdown}\n\n${imp.after_markdown}` : imp.after_markdown;
}

/** Both sides of a unified diff (hunk bodies only): the context the engine emitted around the change. */
export function diffSides(diff: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

type StoredImprovement = { title?: unknown; kind?: unknown; expectedGainPct?: unknown; afterMarkdown?: unknown; diffMarkdown?: unknown };

/** Fallback for audits ingested before suggestions were persisted: rebuild drafts from open AutoGEO ActionItems. */
export async function suggestionsFromActionItems(siteId: string): Promise<SuggestionDraft[]> {
  const items = await prisma.actionItem.findMany({
    where: { siteId, ruleId: { startsWith: AUTOGEO_RULE_PREFIX }, status: { in: ["open", "in_progress"] } },
    select: { id: true, ruleId: true, targetUrl: true, details: true },
  });
  const out: SuggestionDraft[] = [];
  for (const item of items) {
    const details = (item.details ?? {}) as { metric?: string; improvements?: StoredImprovement[] };
    const ruleType = ruleTypeOf(item.ruleId!, item.ruleId === "autogeo.comparison_table" ? undefined : details.metric);
    if (!ruleType || !item.targetUrl) continue;
    for (const imp of Array.isArray(details.improvements) ? details.improvements : []) {
      const diff = typeof imp.diffMarkdown === "string" ? imp.diffMarkdown : "";
      const sides = diffSides(diff);
      const suggested = sides.after || (typeof imp.afterMarkdown === "string" ? imp.afterMarkdown : "");
      if (!suggested) continue;
      out.push({
        pageUrl: item.targetUrl,
        ruleType,
        ruleId: item.ruleId,
        title: typeof imp.title === "string" ? imp.title.slice(0, 500) : null,
        originalSnippet: sides.before,
        suggestedSnippet: suggested,
        diffMarkdown: diff || null,
        expectedGain: typeof imp.expectedGainPct === "number" ? round1(imp.expectedGainPct) : 0,
        actionItemId: item.id,
      });
    }
  }
  return out;
}

/**
 * Upserts drafts by fingerprint (decisions are kept), links them to the matching AutoGEO ActionItem and marks pending
 * suggestions of re-analysed pages that the new run no longer proposes as `superseded`.
 */
export async function storeSuggestions(siteId: string, drafts: SuggestionDraft[], analysedPages: string[] = []) {
  // a page analysed with zero improvements still supersedes its old suggestions
  const pages = [...new Set([...analysedPages, ...drafts.map((d) => d.pageUrl)])];
  const actionItems = await prisma.actionItem.findMany({
    where: { siteId, ruleId: { startsWith: AUTOGEO_RULE_PREFIX }, targetUrl: { in: pages } },
    orderBy: { createdAt: "asc" },
    select: { id: true, ruleId: true, targetUrl: true },
  });
  const itemByKey = new Map(actionItems.map((i) => [`${i.ruleId}\u0000${i.targetUrl}`, i.id]));
  const unique = new Map(drafts.map((d) => [fingerprintOf(d), d]));

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.autoGeoSuggestion.findMany({
        where: { siteId, fingerprint: { in: [...unique.keys()] } },
        select: { fingerprint: true },
      });
      const known = new Set(existing.map((e) => e.fingerprint));
      const stats = { created: 0, updated: 0, superseded: 0 };
      for (const [fingerprint, d] of unique) {
        const data = {
          ruleId: d.ruleId,
          title: d.title,
          diffMarkdown: d.diffMarkdown,
          expectedGain: d.expectedGain,
          actionItemId: d.actionItemId ?? (d.ruleId ? itemByKey.get(`${d.ruleId}\u0000${d.pageUrl}`) : undefined) ?? null,
        };
        await tx.autoGeoSuggestion.upsert({
          where: { siteId_fingerprint: { siteId, fingerprint } },
          create: { siteId, fingerprint, pageUrl: d.pageUrl, ruleType: d.ruleType, originalSnippet: d.originalSnippet, suggestedSnippet: d.suggestedSnippet, ...data },
          update: data,
        });
        stats[known.has(fingerprint) ? "updated" : "created"]++;
      }
      // proposed again by this run: back in the queue
      await tx.autoGeoSuggestion.updateMany({
        where: { siteId, status: "superseded", fingerprint: { in: [...unique.keys()] } },
        data: { status: "pending" },
      });
      if (pages.length) {
        const { count } = await tx.autoGeoSuggestion.updateMany({
          where: { siteId, status: "pending", pageUrl: { in: pages }, fingerprint: { notIn: [...unique.keys()] } },
          data: { status: "superseded" },
        });
        stats.superseded = count;
      }
      return { ...stats, pages: pages.length, total: unique.size };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/** Ingestion hook: persists a crawler report's suggestions (called after an audit with AutoGEO data completes). */
export async function storeAutoGeoReport(siteId: string, report: AutoGeoReport) {
  return storeSuggestions(siteId, suggestionsFromReport(report), report.pages.map((p) => p.url));
}

// ---------------------------------------------------------------- API

export const autoGeoQuerySchema = z.object({
  status: csvEnum(SUGGESTION_STATUSES),
  ruleType: csvEnum(AUTOGEO_RULE_TYPES),
  pageUrl: z.string().max(2_000).optional(),
  minGain: z.coerce.number().min(0).max(1_000).optional(),
  sort: z.enum(["gain", "recent"]).default("gain"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const autoGeoRunSchema = z
  .object({
    /** A crawler AutoGEO report (`geo-audit` payload `autogeo`); omitted -> rebuild from the open AutoGEO action items. */
    report: autoGeoReportSchema.optional(),
  })
  .strict()
  .default({});

export const updateSuggestionSchema = z.object({ status: z.enum(["pending", "applied", "dismissed"]) }).strict();

const counts = (rows: { key: string; _count: { _all: number } }[]) => Object.fromEntries(rows.map((r) => [r.key, r._count._all]));

export async function listSuggestions(siteId: string, q: z.infer<typeof autoGeoQuerySchema>) {
  const where: Prisma.AutoGeoSuggestionWhereInput = {
    siteId,
    ...(q.status ? { status: { in: q.status } } : { status: { in: ["pending", "applied"] } }),
    ...(q.ruleType ? { ruleType: { in: q.ruleType } } : {}),
    ...(q.pageUrl ? { pageUrl: q.pageUrl } : {}),
    ...(q.minGain !== undefined ? { expectedGain: { gte: q.minGain } } : {}),
  };
  const orderBy: Prisma.AutoGeoSuggestionOrderByWithRelationInput[] =
    q.sort === "gain" ? [{ expectedGain: "desc" }, { createdAt: "desc" }] : [{ createdAt: "desc" }, { expectedGain: "desc" }];
  const [items, total, byStatus, byRuleType] = await Promise.all([
    prisma.autoGeoSuggestion.findMany({ where, orderBy, take: q.limit, skip: q.offset }),
    prisma.autoGeoSuggestion.count({ where }),
    prisma.autoGeoSuggestion.groupBy({ by: ["status"], where: { siteId }, _count: { _all: true } }),
    prisma.autoGeoSuggestion.groupBy({ by: ["ruleType"], where: { siteId, status: "pending" }, _count: { _all: true } }),
  ]);
  return {
    items,
    total,
    byStatus: counts(byStatus.map((r) => ({ key: r.status, _count: r._count }))),
    pendingByRuleType: counts(byRuleType.map((r) => ({ key: r.ruleType, _count: r._count }))),
  };
}

/** GET /autogeo: the latest audit's AutoGEO summary + open action items (unchanged contract) and the suggestion list. */
export async function getAutoGeoOverview(siteId: string, q: z.infer<typeof autoGeoQuerySchema>) {
  const base = await getSiteAutoGeo(siteId);
  return { ...base, suggestions: await listSuggestions(siteId, q) };
}

export async function runAutoGeo(siteId: string, input: z.infer<typeof autoGeoRunSchema>) {
  await getSiteOrThrow(siteId);
  const source = input.report ? "report" : "action_items";
  if (input.report) return { source, ...(await storeAutoGeoReport(siteId, input.report)) };
  return { source, ...(await storeSuggestions(siteId, await suggestionsFromActionItems(siteId))) };
}

export async function updateSuggestionStatus(siteId: string, suggestionId: string, status: z.infer<typeof updateSuggestionSchema>["status"]) {
  const row = await prisma.autoGeoSuggestion.findUnique({ where: { id: suggestionId }, select: { siteId: true } });
  if (!row || row.siteId !== siteId) throw notFound("Suggestion");
  return prisma.autoGeoSuggestion.update({ where: { id: suggestionId }, data: { status } });
}
