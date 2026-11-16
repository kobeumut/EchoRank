// Compact, model-ready Markdown digest of everything the platform knows about a site: scores and failing checks,
// prioritized actions, crawled pages, knowledge graph, LLM visibility, competitors, AI bot access and AutoGEO
// suggestions. Shared by the site chatbot (services/site-chat.ts) and the MCP `get_site_context` tool.
//
// Every string that came from a crawled page or an AI answer is clipped and single-lined, and the whole digest is
// bounded, so a hostile page cannot flood the prompt. Callers must still frame it as data, never as instructions.
import { prisma } from "../db";
import { readPillars } from "../dashboard/pillars";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { serverT } from "../i18n/request";
import { getSiteOrThrow } from "./sites";
import { getSiteReport } from "./reports";
import { listBotSimulations } from "./bot-simulations";

export const SITE_CONTEXT_MAX_CHARS = 40_000;
const REPORT_DAYS = 90;

/** Single line, at most `max` characters. */
export function clipLine(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
const signed = (n: number | null | undefined) => (n == null ? "" : n > 0 ? ` (+${n})` : n < 0 ? ` (${n})` : " (±0)");
const keywords = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string").map((k) => clipLine(k, 80)) : []);

/**
 * Builds the digest in `locale` (English by default; `context.*` catalog keys). Text that was stored earlier
 * (check details, action titles, AutoGEO titles) keeps the language it was generated in.
 */
export async function buildSiteContext(siteId: string, locale: Locale = DEFAULT_LOCALE) {
  const t = serverT(locale);
  const site = await getSiteOrThrow(siteId);
  const since = new Date(Date.now() - REPORT_DAYS * 86_400_000);
  const [report, actions, pages, pageStats, entityTypes, verifiedEntities, records, competitors, bots, suggestions, suggestionCount] = await Promise.all([
    getSiteReport(siteId, REPORT_DAYS),
    prisma.actionItem.findMany({
      where: { siteId, status: { in: ["open", "in_progress"] } },
      orderBy: [{ priority: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 20,
      select: { id: true, title: true, description: true, category: true, impact: true, effort: true, status: true, targetUrl: true, details: true },
    }),
    prisma.crawledPage.findMany({
      where: { siteId },
      orderBy: [{ depth: "asc" }, { url: "asc" }],
      take: 30,
      select: { url: true, pageType: true, statusCode: true, wordCount: true, title: true, metaDescription: true, h1: true },
    }),
    Promise.all([
      prisma.crawledPage.count({ where: { siteId } }),
      prisma.crawledPage.count({ where: { siteId, OR: [{ metaDescription: null }, { metaDescription: "" }] } }),
      prisma.crawledPage.count({ where: { siteId, OR: [{ h1: null }, { h1: "" }] } }),
      prisma.crawledPage.count({ where: { siteId, wordCount: { lt: 300 } } }),
      prisma.crawledPage.count({ where: { siteId, statusCode: { gte: 400 } } }),
    ]),
    prisma.graphEntity.groupBy({ by: ["entityType"], where: { siteId }, _count: { _all: true } }),
    prisma.entityEnrichment.count({ where: { siteId, isVerified: true } }),
    prisma.llmVisibilityRecord.findMany({
      where: { siteId, checkedAt: { gte: since } },
      orderBy: { checkedAt: "desc" },
      take: 12,
      select: { model: true, query: true, citationStatus: true, position: true, excerpt: true, checkedAt: true },
    }),
    prisma.competitorAnalysis.findMany({ where: { siteId }, orderBy: { shareOfModel: "desc" }, take: 10 }),
    listBotSimulations(siteId, { limit: 1, offset: 0 }),
    prisma.autoGeoSuggestion.findMany({
      where: { siteId, status: "pending" },
      orderBy: [{ expectedGain: "desc" }, { createdAt: "desc" }],
      take: 6,
      select: { pageUrl: true, ruleType: true, title: true, expectedGain: true },
    }),
    prisma.autoGeoSuggestion.count({ where: { siteId, status: "pending" } }),
  ]);
  const [pageCount, noMeta, noH1, thin, broken] = pageStats;

  const out: string[] = [];
  out.push(`# ${clipLine(site.title, 120)} (${site.url})`);
  out.push(`Site ID: ${site.id}`);
  if (site.description) out.push(t("context.description", { value: clipLine(site.description, 400) }));
  const kw = keywords(site.targetKeywords);
  if (kw.length) out.push(t("context.keywords", { value: kw.slice(0, 20).join(", ") }));

  out.push("", t("context.scores.heading"));
  if (report.scores) {
    const s = report.scores;
    out.push(t("context.scores.summary", {
      date: day(s.auditedAt),
      geo: `${s.geo ?? "—"}${signed(s.delta.geo)}`,
      seo: `${s.seo ?? "—"}${signed(s.delta.seo)}`,
      eeat: `${s.eeat ?? "—"}${signed(s.delta.eeat)}`,
    }));
    for (const pillar of readPillars(s.metrics, t)) {
      out.push(`- ${pillar.label}: ${pillar.score}${pillar.weight ? t("context.scores.weight", { percent: Math.round(pillar.weight * 100) }) : ""}`);
      const failing = pillar.checks.filter((c) => c.applicable && !c.passed).sort((a, b) => a.score - b.score).slice(0, 6);
      for (const c of failing) {
        const more = (c.url_count ?? c.urls?.length ?? 0) > 2 ? ` (+${(c.url_count ?? c.urls!.length) - 2})` : "";
        const urls = c.urls?.length ? t("context.scores.exampleUrls", { urls: `${c.urls.slice(0, 2).join(", ")}${more}` }) : "";
        out.push(`  - ${t("context.scores.failed")} ${clipLine(c.label, 100)} (${c.score})${c.detail ? `: ${clipLine(c.detail, 200)}` : ""}${urls}`);
      }
    }
    if (report.history.length > 1) {
      out.push(t("context.scores.history", { days: REPORT_DAYS, items: report.history.slice(-6).map((h) => `${day(h.date)} GEO ${h.geo ?? "—"}`).join(" · ") }));
    }
  } else {
    out.push(t("context.scores.none"));
  }

  out.push("", t("context.actions.heading", {
    open: report.actions.open, high: report.actions.byImpact.high ?? 0, medium: report.actions.byImpact.medium ?? 0, low: report.actions.byImpact.low ?? 0,
  }));
  if (!actions.length) out.push(t("context.actions.none"));
  for (const a of actions) {
    const details = a.details && typeof a.details === "object" && !Array.isArray(a.details) ? (a.details as Record<string, unknown>) : {};
    const count = typeof details.affected_count === "number" ? t("context.actions.urlCount", { count: details.affected_count }) : "";
    const effort = a.effort ? t("context.actions.effort", { effort: a.effort }) : "";
    out.push(`- [${a.impact}/${a.category}${effort}] ${clipLine(a.title, 160)}${a.targetUrl ? ` — ${clipLine(a.targetUrl, 160)}` : ""}${count} (id: ${a.id}${a.status === "in_progress" ? t("context.actions.inProgress") : ""})`);
    if (a.description) out.push(`  ${clipLine(a.description, 260)}`);
  }

  out.push("", t("context.pages.heading", { count: pageCount, noMeta, noH1, thin, broken }));
  for (const p of pages) {
    out.push(`- ${clipLine(p.url, 160)} | ${p.pageType ?? "?"} | HTTP ${p.statusCode ?? "?"} | ${t("context.pages.row", { words: p.wordCount, title: clipLine(p.title, 90) || "—" })}${p.metaDescription ? "" : t("context.pages.noMeta")}${p.h1 ? "" : t("context.pages.noH1")}`);
  }
  if (pageCount > pages.length) out.push(t("context.pages.more", { count: pageCount - pages.length }));

  out.push("", t("context.graph.heading"));
  out.push(entityTypes.length
    ? t("context.graph.entities", { items: entityTypes.sort((a, b) => b._count._all - a._count._all).map((e) => `${e.entityType} ${e._count._all}`).join(", "), verified: verifiedEntities })
    : t("context.graph.empty"));

  out.push("", t("context.visibility.heading", { days: REPORT_DAYS }));
  const v = report.visibility;
  if (!v.totalChecks) out.push(t("context.visibility.none"));
  else {
    out.push(t("context.visibility.summary", { total: v.totalChecks, citation: v.citationRate, visibility: v.visibilityRate }));
    for (const [model, m] of Object.entries(v.perModel)) out.push(t("context.visibility.perModel", { model, total: m.total, citation: m.citationRate, visibility: m.visibilityRate }));
    out.push(t("context.visibility.latest"));
    for (const r of records) {
      out.push(`- ${day(r.checkedAt)} ${r.model} | "${clipLine(r.query, 120)}" → ${r.citationStatus}${r.position ? t("context.visibility.position", { position: r.position }) : ""}${r.excerpt ? ` | ${clipLine(r.excerpt, 160)}` : ""}`);
    }
  }

  out.push("", t("context.competitors.heading"));
  if (!competitors.length) out.push(t("context.competitors.none"));
  for (const c of competitors) {
    out.push(t("context.competitors.row", {
      name: clipLine(c.competitorName ?? c.competitorDomain, 80), domain: c.competitorDomain, share: Math.round(c.shareOfModel), cited: c.citedQueriesCount, gap: c.gapQueriesCount,
      sentiment: c.sentimentScore != null ? t("context.competitors.sentiment", { score: c.sentimentScore }) : "",
    }));
  }

  out.push("", t("context.bots.heading"));
  if (!bots.summary) out.push(t("context.bots.none"));
  else {
    out.push(t("context.bots.date", { date: day(bots.checkedAt) }));
    for (const b of bots.summary.perBot) {
      out.push(t("context.bots.row", {
        bot: b.botName, checked: b.checked, ok: b.ok, blocked: b.blocked, blockedBy: b.blockedBy.length ? ` (${b.blockedBy.join(", ")})` : "", shells: b.csrShells, tokens: b.avgTokens,
      }));
    }
    if (bots.summary.botOnlyBlocks.length) out.push(t("context.bots.onlyBots", { items: bots.summary.botOnlyBlocks.slice(0, 5).map((b) => `${b.botName} @ ${clipLine(b.url, 100)}`).join("; ") }));
  }

  out.push("", t("context.autogeo.heading", { count: suggestionCount }));
  for (const s of suggestions) {
    out.push(`- ${clipLine(s.pageUrl, 140)} | ${s.ruleType} | ${t("context.autogeo.row", { gain: Math.round(s.expectedGain) })}${s.title ? ` | ${clipLine(s.title, 100)}` : ""}`);
  }

  let markdown = out.join("\n");
  if (markdown.length > SITE_CONTEXT_MAX_CHARS) markdown = `${markdown.slice(0, SITE_CONTEXT_MAX_CHARS)}\n${t("context.truncated")}`;
  return { site: { id: site.id, url: site.url, title: site.title }, markdown };
}
