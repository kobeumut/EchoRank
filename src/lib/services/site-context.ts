// Compact, model-ready Markdown digest of everything the platform knows about a site: scores and failing checks,
// prioritized actions, crawled pages, knowledge graph, LLM visibility, competitors, AI bot access and AutoGEO
// suggestions. Shared by the site chatbot (services/site-chat.ts) and the MCP `get_site_context` tool.
//
// Every string that came from a crawled page or an AI answer is clipped and single-lined, and the whole digest is
// bounded, so a hostile page cannot flood the prompt. Callers must still frame it as data, never as instructions.
import { prisma } from "../db";
import { readPillars } from "../dashboard/pillars";
import { getMessages } from "../i18n/messages";
import { createTranslator } from "../i18n/translate";
import { getSiteOrThrow } from "./sites";
import { getSiteReport } from "./reports";
import { listBotSimulations } from "./bot-simulations";

export const SITE_CONTEXT_MAX_CHARS = 40_000;
const REPORT_DAYS = 90;
// The digest is written in Turkish, so the engine-independent pillar labels come from the Turkish catalog too.
const tTr = createTranslator(getMessages("tr"), "tr");

/** Single line, at most `max` characters. */
export function clipLine(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
const signed = (n: number | null | undefined) => (n == null ? "" : n > 0 ? ` (+${n})` : n < 0 ? ` (${n})` : " (±0)");
const keywords = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string").map((k) => clipLine(k, 80)) : []);

export async function buildSiteContext(siteId: string) {
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
  if (site.description) out.push(`Açıklama: ${clipLine(site.description, 400)}`);
  const kw = keywords(site.targetKeywords);
  if (kw.length) out.push(`Hedef anahtar kelimeler: ${kw.slice(0, 20).join(", ")}`);

  out.push("", "## Skorlar");
  if (report.scores) {
    const s = report.scores;
    out.push(`Son tamamlanan analiz: ${day(s.auditedAt)}. GEO ${s.geo ?? "—"}${signed(s.delta.geo)}, SEO ${s.seo ?? "—"}${signed(s.delta.seo)}, E-E-A-T ${s.eeat ?? "—"}${signed(s.delta.eeat)} (0-100, parantez içi önceki analize göre fark).`);
    for (const pillar of readPillars(s.metrics, tTr)) {
      out.push(`- ${pillar.label}: ${pillar.score}${pillar.weight ? ` (ağırlık %${Math.round(pillar.weight * 100)})` : ""}`);
      const failing = pillar.checks.filter((c) => c.applicable && !c.passed).sort((a, b) => a.score - b.score).slice(0, 6);
      for (const c of failing) {
        const urls = c.urls?.length ? ` — örnek URL: ${c.urls.slice(0, 2).join(", ")}${(c.url_count ?? c.urls.length) > 2 ? ` (+${(c.url_count ?? c.urls.length) - 2})` : ""}` : "";
        out.push(`  - BAŞARISIZ ${clipLine(c.label, 100)} (${c.score})${c.detail ? `: ${clipLine(c.detail, 200)}` : ""}${urls}`);
      }
    }
    if (report.history.length > 1) {
      out.push(`Skor geçmişi (son ${REPORT_DAYS} gün): ${report.history.slice(-6).map((h) => `${day(h.date)} GEO ${h.geo ?? "—"}`).join(" · ")}`);
    }
  } else {
    out.push("Henüz tamamlanmış analiz yok (kullanıcı \"Analizi Başlat\" ile bir analiz çalıştırmalı).");
  }

  out.push("", `## Açık aksiyonlar (${report.actions.open} açık; kritik ${report.actions.byImpact.high ?? 0}, önemli ${report.actions.byImpact.medium ?? 0}, iyileştirme ${report.actions.byImpact.low ?? 0})`);
  if (!actions.length) out.push("Açık aksiyon yok.");
  for (const a of actions) {
    const details = a.details && typeof a.details === "object" && !Array.isArray(a.details) ? (a.details as Record<string, unknown>) : {};
    const count = typeof details.affected_count === "number" ? `, ${details.affected_count} URL` : "";
    out.push(`- [${a.impact}/${a.category}${a.effort ? `/efor ${a.effort}` : ""}] ${clipLine(a.title, 160)}${a.targetUrl ? ` — ${clipLine(a.targetUrl, 160)}` : ""}${count} (id: ${a.id}${a.status === "in_progress" ? ", devam ediyor" : ""})`);
    if (a.description) out.push(`  ${clipLine(a.description, 260)}`);
  }

  out.push("", `## Taranan sayfalar (${pageCount} sayfa; meta açıklaması eksik ${noMeta}, H1 eksik ${noH1}, 300 kelimeden kısa ${thin}, HTTP 4xx/5xx ${broken})`);
  for (const p of pages) {
    out.push(`- ${clipLine(p.url, 160)} | ${p.pageType ?? "?"} | HTTP ${p.statusCode ?? "?"} | ${p.wordCount} kelime | başlık: ${clipLine(p.title, 90) || "—"}${p.metaDescription ? "" : " | meta yok"}${p.h1 ? "" : " | H1 yok"}`);
  }
  if (pageCount > pages.length) out.push(`(… ${pageCount - pages.length} sayfa daha)`);

  out.push("", "## Bilgi grafı");
  out.push(entityTypes.length
    ? `Varlıklar: ${entityTypes.sort((a, b) => b._count._all - a._count._all).map((t) => `${t.entityType} ${t._count._all}`).join(", ")}. Wikidata ile doğrulanmış: ${verifiedEntities}.`
    : "Graf boş (henüz tarama yok).");

  out.push("", `## LLM görünürlüğü (son ${REPORT_DAYS} gün)`);
  const v = report.visibility;
  if (!v.totalChecks) out.push("Kayıtlı görünürlük kontrolü yok (\"LLM Görünürlük\" ekranından çalıştırılabilir).");
  else {
    out.push(`${v.totalChecks} kontrol: atıf oranı %${v.citationRate}, görünürlük (atıf + bahsedilme) %${v.visibilityRate}.`);
    for (const [model, m] of Object.entries(v.perModel)) out.push(`- ${model}: ${m.total} kontrol, atıf %${m.citationRate}, görünürlük %${m.visibilityRate}`);
    out.push("Son kontroller:");
    for (const r of records) {
      out.push(`- ${day(r.checkedAt)} ${r.model} | "${clipLine(r.query, 120)}" → ${r.citationStatus}${r.position ? ` (sıra ${r.position})` : ""}${r.excerpt ? ` | ${clipLine(r.excerpt, 160)}` : ""}`);
    }
  }

  out.push("", "## Rakipler (Model Payı)");
  if (!competitors.length) out.push("Rakip analizi yok (ayarlarda rakip tanımlanıp görünürlük kontrolü yapılmalı).");
  for (const c of competitors) {
    out.push(`- ${clipLine(c.competitorName ?? c.competitorDomain, 80)} (${c.competitorDomain}): model payı %${Math.round(c.shareOfModel)}, atıf alan sorgu ${c.citedQueriesCount}, sitenin kaçırdığı sorgu ${c.gapQueriesCount}${c.sentimentScore != null ? `, duygu ${c.sentimentScore}` : ""}`);
  }

  out.push("", "## AI bot erişimi (son canlı test)");
  if (!bots.summary) out.push("Canlı bot testi yapılmamış (\"AI Bot Teşhis\" ekranı).");
  else {
    out.push(`Test tarihi: ${day(bots.checkedAt)}`);
    for (const b of bots.summary.perBot) {
      out.push(`- ${b.botName}: ${b.checked} URL, ${b.ok} sorunsuz, ${b.blocked} engelli${b.blockedBy.length ? ` (${b.blockedBy.join(", ")})` : ""}, ${b.csrShells} boş JS kabuğu, ort. ${b.avgTokens} token`);
    }
    if (bots.summary.botOnlyBlocks.length) out.push(`Yalnızca botlara uygulanan engeller: ${bots.summary.botOnlyBlocks.slice(0, 5).map((b) => `${b.botName} @ ${clipLine(b.url, 100)}`).join("; ")}`);
  }

  out.push("", `## AutoGEO içerik önerileri (${suggestionCount} bekleyen)`);
  for (const s of suggestions) {
    out.push(`- ${clipLine(s.pageUrl, 140)} | ${s.ruleType} | beklenen kazanç %${Math.round(s.expectedGain)}${s.title ? ` | ${clipLine(s.title, 100)}` : ""}`);
  }

  let markdown = out.join("\n");
  if (markdown.length > SITE_CONTEXT_MAX_CHARS) markdown = `${markdown.slice(0, SITE_CONTEXT_MAX_CHARS)}\n(… bağlam kısaltıldı)`;
  return { site: { id: site.id, url: site.url, title: site.title }, markdown };
}
