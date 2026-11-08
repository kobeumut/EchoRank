import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { analyzeAnswer, analyzeBrandSentiment, auditBrandClaims, visibilityAnalysisSettings } from "@/lib/visibility-analysis";
import { analyzeCiteMagnet, analyzeSom, getSomAnalysis } from "@/lib/services/som-analysis";
import { updateSiteSchema } from "@/lib/validation";
import * as route from "@/app/api/sites/[id]/visibility/route";
import { ctx, req, resetDb } from "./helpers";

const site = { url: "https://example.com", title: "Acme" };
const rival = { url: "https://rival.test", title: "Rival" };
const at = new Date("2026-11-08T12:00:00Z");
const config = visibilityAnalysisSettings.parse({ competitors: [rival] });
const fact = {
  subject: "Acme", expected: "Two-year warranty; price is 100 TRY; no wireless charging",
  conflictingClaims: ["lifetime warranty", "costs 500 TRY", "supports wireless charging", "stolen design"],
  sourceUrl: "https://example.com/policy", verifiedAt: "2026-11-01T00:00:00Z", validUntil: "2026-12-01T00:00:00Z",
};
function observation(id: string, model: string, text: string, citations: string[] = [], query = "oil") {
  const evidence = analyzeAnswer({ text, citations }, site);
  return { id, model, query, citationStatus: evidence.citationStatus, position: evidence.position, excerpt: evidence.excerpt,
    checkedAt: at, responseMeta: { citations, answerText: text, answerTruncated: false } };
}

beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => prisma.$disconnect());

describe("Share of Model mathematics", () => {
  it("reports brand-answer citation shares per model and cumulatively, not model averages", () => {
    const result = analyzeSom(site, [
      observation("1", "chatgpt", "1. Acme\n4. Rival", [site.url, site.url + "/oil", rival.url]),
      observation("2", "chatgpt", "1. Acme", [site.url]),
      observation("3", "gemini", "1. Rival", [rival.url]),
    ], config);
    expect(result.overall.samples).toBe(3);
    expect(result.overall.citationTotal).toBe(4);
    expect(result.overall.brands.map((b) => [b.citations, b.citationRate, b.citationShare])).toEqual([[2, 66.67, 50], [2, 66.67, 50]]);
    expect(result.perModel.chatgpt.brands.map((b) => b.citationShare)).toEqual([66.67, 33.33]);
    expect(result.perModel.gemini.brands.map((b) => b.citationShare)).toEqual([0, 100]);
    expect(result.perModel.claude.samples).toBe(0);
    expect(result.perModel.perplexity.brands[0].citationShare).toBeNull();
    expect(result.overall.brands[0].recommendationPoints).toBe(2);
    expect(result.overall.brands[1].recommendationPoints).toBe(1.25);
  });

  it("weights first vs fourth recommendation 4:1 independently of source order", () => {
    const result = analyzeSom(site, [observation("1", "claude", "1. Acme\n4. Rival", [rival.url, site.url])], config);
    expect(result.overall.brands.map((b) => b.recommendationShare)).toEqual([80, 20]);
    expect(result.overall.brands.map((b) => b.citationShare)).toEqual([50, 50]);
  });

  it("keeps mention-only, source-only, unranked and empty denominators distinct", () => {
    const result = analyzeSom(site, [observation("1", "claude", "Acme is reliable", [rival.url])], config);
    expect(result.overall.brands[0]).toMatchObject({ citations: 0, mentions: 1, citationShare: 0, recommendationShare: null });
    expect(result.overall.brands[1]).toMatchObject({ citations: 1, mentions: 0, citationShare: 100, recommendationShare: null });
    const absent = analyzeSom(site, [observation("2", "chatgpt", "No brands", [])], config);
    expect(absent.overall.brands[0]).toMatchObject({ citationRate: 0, citationShare: null });
    expect(analyzeSom(site, [], config).overall.brands[0].citationRate).toBeNull();
    expect(result.citationGaps[0].targetMentioned).toBe(true);
  });

  it("does not invent competitors from publishers, lookalike domains or bibliography numbers", () => {
    const text = "**Sources:**\n1. Rival\n2. Acme";
    const result = analyzeSom(site, [observation("1", "gemini", text, ["https://rival.test.evil/x", "https://news.test", "https://rival.test@evil.test"])], config);
    expect(result.citationGaps).toEqual([]);
    expect(result.overall.citationTotal).toBe(0);
    expect(result.overall.recommendationTotal).toBe(0);
    expect(result.overall.brands).toHaveLength(2);
  });

  it("deduplicates observation IDs and overlapping brands, retains repeated measurements", () => {
    const row = observation("1", "perplexity", "1. Acme", ["https://shop.example.com/oil"]);
    const result = analyzeSom(site, [row, row, { ...row, id: "2" }, { ...row, id: "3", model: "other" }], visibilityAnalysisSettings.parse({ competitors: [rival, { ...rival, url: "https://www.rival.test/" }, { title: "Self", url: "https://shop.example.com" }] }));
    expect(result.overall.samples).toBe(2);
    expect(result.overall.brands).toHaveLength(2);
    expect(result.overall.brands[0].citations).toBe(2);
    expect(result.warnings).toHaveLength(2);
  });
});

describe("citation gaps and cite magnets", () => {
  const targetPage = { url: "https://example.com/oil", observedAt: "2026-11-01T00:00:00Z", wordCount: 10, schemaTypes: [], tableCount: 0, text: "oil plain description", textComplete: true };
  const ref = { url: "https://rival.test/oil", observedAt: "2026-11-01T00:00:00Z", wordCount: 20, schemaTypes: ["Product"], tableCount: 1, text: "oil 20% 10 percent", textComplete: true };
  it("lists missed queries with multiple configured competitors, URLs and observed differences", () => {
    const settings = visibilityAnalysisSettings.parse({ competitors: [rival, { title: "Other", url: "https://other.test" }], referencePages: [ref] });
    const result = analyzeSom(site, [observation("1", "perplexity", "Rival oil", [ref.url, "https://other.test/x"]), observation("2", "chatgpt", "Acme", [site.url, ref.url])], settings, [targetPage]);
    expect(result.citationGaps).toHaveLength(1);
    const gap = result.citationGaps[0];
    expect(gap).toMatchObject({ query: "oil", reason: "target_uncited_configured_competitor_cited", targetPage: targetPage.url });
    expect(gap.competitors).toHaveLength(2);
    expect(gap.competitors[0].urls[0].citeMagnet).toMatchObject({ status: "compared", missingFactors: ["less_word_coverage", "no_structured_schema", "no_data_tables", "lower_statistics_density"], reference: { statisticCount: 2, statisticsPer100Words: 10 } });
    expect(gap.competitors[1].urls[0].citeMagnet.status).toBe("reference_snapshot_missing");
  });

  it("treats missing features and excerpt statistics as unknown, not absence", () => {
    expect(analyzeCiteMagnet({ url: ref.url, observedAt: ref.observedAt })).toMatchObject({ wordCount: null, schemaTypes: null, tableCount: null, statisticCount: null, statisticsPer100Words: null });
    expect(analyzeCiteMagnet({ ...ref, textComplete: false })).toMatchObject({ statisticCount: 2, statisticsPer100Words: null, statisticsCoverage: "excerpt_lower_bound" });
    const settings = visibilityAnalysisSettings.parse({ competitors: [rival], referencePages: [ref] });
    const result = analyzeSom(site, [observation("1", "claude", "Rival", [ref.url])], settings, [{ ...targetPage, schemaTypes: undefined, tableCount: undefined, textComplete: false }]);
    expect(result.citationGaps[0].competitors[0].urls[0].citeMagnet.missingFactors).toEqual(["less_word_coverage"]);
  });

  it("does not compare unrelated or future snapshots", () => {
    const settings = visibilityAnalysisSettings.parse({ competitors: [rival], referencePages: [{ ...ref, observedAt: "2027-01-01T00:00:00Z" }] });
    const gap = analyzeSom(site, [observation("1", "chatgpt", "Rival", [ref.url], "cosmetics")], settings, [targetPage]).citationGaps[0];
    expect(gap.targetPage).toBeNull();
    expect(gap.competitors[0].urls[0].citeMagnet.status).toBe("reference_snapshot_missing");
  });
});

describe("brand-scoped sentiment and fact evidence", () => {
  it("scores positive, neutral, negative, absent, negated and Unicode clauses", () => {
    expect(analyzeBrandSentiment("Acme is excellent. Rival is terrible.", site, ["Rival"])).toMatchObject({ label: "positive", score: 1 });
    expect(analyzeBrandSentiment("Acme sells oil.", site)).toMatchObject({ label: "neutral", score: 0 });
    expect(analyzeBrandSentiment("Acme is not reliable.", site)).toMatchObject({ label: "negative", score: -1 });
    expect(analyzeBrandSentiment("Acme is unsafe.", site).label).toBe("negative");
    expect(analyzeBrandSentiment("Rival is great. AcmeTools is bad.", site)).toMatchObject({ label: "unknown", score: null });
    expect(analyzeBrandSentiment("Yağ Dünyası kaliteli değil.", { ...site, title: "Yağ Dünyası" }).label).toBe("negative");
    expect(analyzeBrandSentiment("Rival is great but Acme is expensive.", site, ["Rival"]).label).toBe("negative");
    expect(analyzeBrandSentiment("Rival is excellent compared with Acme.", site, ["Rival"]).label).toBe("unknown");
    expect(analyzeBrandSentiment("**Sources:**\nAcme is great", site).label).toBe("unknown");
  });

  it("flags only literal contradictions backed by active, attributed facts", () => {
    for (const claim of fact.conflictingClaims) {
      const audit = auditBrandClaims(`Acme ${claim}.`, [fact], at);
      expect(audit).toMatchObject({ status: "needs_review", checkedFacts: 1, findingCount: 1 });
      expect(audit.findings[0]).toMatchObject({ expected: fact.expected, sourceUrl: fact.sourceUrl, conflictingClaim: claim, severity: "potential_hallucination" });
    }
  });

  it("never treats missing, expired, negated, speculative or competitor claims as verified falsehoods", () => {
    for (const text of ["Rival has lifetime warranty", "Acme has no lifetime warranty", "Acme may offer lifetime warranty", "Does Acme have lifetime warranty?", "Acme sells oil"]) {
      expect(auditBrandClaims(text, [fact], at)).toMatchObject({ status: "unknown", findingCount: 0 });
    }
    expect(auditBrandClaims("Rival unlike Acme has lifetime warranty", [fact], at, ["Rival"]).findings).toEqual([]);
    expect(auditBrandClaims("Acme has lifetime warranty", [], at).status).toBe("unknown");
    expect(auditBrandClaims("Acme has lifetime warranty", [fact], new Date("2027-01-01"))).toMatchObject({ checkedFacts: 0, findings: [] });
    expect(auditBrandClaims("Acme has lifetime warranty", [fact], new Date("2026-01-01"))).toMatchObject({ checkedFacts: 0, findings: [] });
  });

  it("validates bounded settings and refuses regex-like untrusted configuration", () => {
    expect(updateSiteSchema.safeParse({ settings: { visibilityAnalysis: { competitors: [rival], facts: [fact] } } }).success).toBe(true);
    for (const input of [{ competitors: [{ ...rival, url: "http://user:pass@rival.test" }] }, { facts: [{ ...fact, validUntil: fact.verifiedAt }] }, { referencePages: [{ url: rival.url, observedAt: fact.verifiedAt, text: "x".repeat(20_001) }] }, { competitors: Array(21).fill(rival) }, { regex: "(a+)+$" }]) {
      expect(updateSiteSchema.safeParse({ settings: { visibilityAnalysis: input } }).success).toBe(false);
    }
  });
});

describe("SQLite and visibility API integration", () => {
  it("adds independent windowed analysis to paginated history with site isolation and crawl evidence", async () => {
    const owner = await prisma.site.create({ data: { ...site, settings: { visibilityAnalysis: { competitors: [rival], facts: [fact], referencePages: [{ url: rival.url + "/oil", observedAt: "2026-11-01T00:00:00Z", wordCount: 100, schemaTypes: ["Product"], tableCount: 1 }] } } } });
    const other = await prisma.site.create({ data: { url: "https://else.test", title: "Else" } });
    await prisma.crawledPage.create({ data: { siteId: owner.id, url: site.url + "/oil", wordCount: 10, crawledAt: new Date("2026-11-01"), data: { json_ld: [], microdata: [], text_excerpt: "oil", content_stats: { tables: 0 } } } });
    const rows = [observation("1", "chatgpt", "Acme has lifetime warranty. Acme is great.", [rival.url + "/oil"]), observation("2", "gemini", "Acme", [site.url])];
    for (const { id: _id, ...row } of rows) await prisma.llmVisibilityRecord.create({ data: { ...row, siteId: owner.id } });
    const { id: _id, ...otherRow } = observation("3", "claude", "Rival", [rival.url]);
    await prisma.llmVisibilityRecord.create({ data: { ...otherRow, siteId: other.id } });
    await prisma.llmVisibilityRecord.create({ data: { ...otherRow, siteId: owner.id, checkedAt: new Date("2020-01-01") } });
    const response = await route.GET(req(`/api/sites/${owner.id}/visibility?limit=1&days=365`), ctx(owner.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.analysis.overall.samples).toBe(2);
    expect(body.analysis.citationGaps).toHaveLength(1);
    expect(body.analysis.citationGaps[0].competitors[0].urls[0].citeMagnet).toMatchObject({ status: "compared", missingFactors: ["less_word_coverage", "no_structured_schema", "no_data_tables"] });
    expect(body.analysis.brandSafety.find((r: { model: string }) => r.model === "chatgpt").hallucinations.status).toBe("needs_review");
    expect(body.analysis.settingsValid).toBe(true);
    expect((await route.GET(req(`/api/sites/${owner.id}/visibility?days=366`), ctx(owner.id))).status).toBe(400);
  });

  it("handles legacy and malformed metadata safely and keeps legacy target citations", async () => {
    const owner = await prisma.site.create({ data: { ...site, settings: { visibilityAnalysis: { competitors: "bad" } } } });
    await prisma.llmVisibilityRecord.create({ data: { siteId: owner.id, query: "oil", model: "claude", citationStatus: "cited", excerpt: null, responseMeta: { citations: [null, 3, "javascript:x"] } } });
    const result = await getSomAnalysis(owner.id);
    expect(result.settingsValid).toBe(false);
    expect(result.overall.brands[0].citations).toBe(1);
    expect(result.brandSafety[0]).toMatchObject({ textCoverage: "truncated_or_legacy", sentiment: { label: "unknown" }, hallucinations: { status: "unknown" } });
    await expect(getSomAnalysis("missing")).rejects.toThrow();
  });

  it("analyzes full fresh answers before excerpt truncation, stores bounded evidence and invalidates configuration cache", async () => {
    vi.stubEnv("API_TOKEN", "test-token"); vi.stubEnv("PERPLEXITY_API_KEY", "key"); vi.stubEnv("PERPLEXITY_MODEL", "test-model");
    const now = new Date();
    const currentFact = { ...fact, verifiedAt: new Date(+now - 1000).toISOString(), validUntil: new Date(+now + 3600_000).toISOString() };
    const owner = await prisma.site.create({ data: { ...site, settings: { visibilityAnalysis: { competitors: [rival], facts: [currentFact] } } } });
    const text = "Plain text. ".repeat(1500) + "\nAcme is excellent and has lifetime warranty.";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: text } }], citations: [rival.url] })));
    async function run() {
      const request = req(`/api/sites/${owner.id}/visibility`, { method: "POST", body: { queries: ["oil"], models: ["perplexity"] } });
      request.headers.set("authorization", "Bearer test-token");
      return (await route.POST(request, ctx(owner.id))).json();
    }
    const body = await run();
    expect(body.successful).toBe(1);
    const record = body.items[0].record;
    expect(record.excerpt).toHaveLength(2000);
    expect(record.responseMeta).toMatchObject({ version: 2, answerTruncated: true, sentiment: { label: "positive" }, hallucinations: { status: "needs_review" } });
    expect(record.responseMeta.answerText).toHaveLength(16_000);
    expect((await run()).items[0].cached).toBe(true);
    await prisma.site.update({ where: { id: owner.id }, data: { settings: { visibilityAnalysis: { competitors: [rival] } } } });
    expect((await run()).items[0].cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
