import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { brandEvidence, summarizeBrandSafety } from "@/lib/services/competitors";
import { fingerprintQuery } from "@/lib/services/synthetic-queries";
import { somTrend, trendBucket } from "@/lib/services/som-analysis";
import * as route from "@/app/api/sites/[id]/competitors/route";
import { ctx, req, resetDb } from "./helpers";

const SITE = { url: "https://shop.example.com", title: "Shop" };
const RIVAL = { url: "https://rival.test", title: "Rival" };
const OTHER = { url: "https://other.test", title: "Other" };

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const answer = (text: string, citations: string[]) => ({ answerText: text, citations, answerTruncated: false });
async function seed(competitors = [RIVAL, OTHER]) {
  const site = await prisma.site.create({
    data: { ...SITE, settings: { visibilityAnalysis: { competitors } } },
  });
  const now = new Date();
  const rows = [
    // site + rival cited
    { query: "best espresso machine", model: "chatgpt", citationStatus: "cited",
      responseMeta: answer("Shop is great. Rival is reliable.", ["https://shop.example.com/a", "https://rival.test/x"]) },
    // gap: only the rival is cited
    { query: "espresso grinder", model: "perplexity", citationStatus: "none",
      responseMeta: answer("Rival is excellent for grinders.", ["https://rival.test/x", "https://rival.test/y"]) },
    // gap: rival + other cited; rival is bad here
    { query: "Espresso Grinder ", model: "gemini", citationStatus: "none",
      responseMeta: answer("Rival is bad. Other is good.", ["https://rival.test/x", "https://other.test/z"]) },
    // site only
    { query: "shop coupons", model: "claude", citationStatus: "cited",
      responseMeta: answer("Shop offers coupons.", ["https://shop.example.com/c"]) },
  ];
  await prisma.llmVisibilityRecord.createMany({ data: rows.map((r) => ({ siteId: site.id, checkedAt: now, ...r })) });
  return site;
}
const get = async (siteId: string, qs = "") => {
  const res = await route.GET(req(`/api/sites/${siteId}/competitors${qs}`), ctx(siteId));
  return { status: res.status, body: await res.json() };
};

describe("brandEvidence", () => {
  it("counts distinct cited queries, top URLs and clause sentiment per brand", () => {
    const brands = [{ ...SITE, domain: "shop.example.com" }, { ...RIVAL, domain: "rival.test" }];
    const records = [
      { id: "1", model: "chatgpt", query: "A", excerpt: null, citationStatus: "none", responseMeta: answer("Rival is great.", ["https://rival.test/x"]) },
      { id: "2", model: "gemini", query: "a ", excerpt: null, citationStatus: "none", responseMeta: answer("Rival is bad.", ["https://rival.test/x", "https://rival.test/y"]) },
      { id: "3", model: "other", query: "b", excerpt: null, citationStatus: "cited", responseMeta: answer("Shop.", ["https://shop.example.com"]) },
    ];
    const [own, rival] = brandEvidence(brands, records);
    expect(own).toEqual({ citedQueriesCount: 0, topCitedUrls: [], sentimentScore: null }); // unsupported model ignored
    expect(rival.citedQueriesCount).toBe(1);
    expect(rival.topCitedUrls).toEqual([{ url: "https://rival.test/x", count: 2 }, { url: "https://rival.test/y", count: 1 }]);
    expect(rival.sentimentScore).toBe(0);
  });
});

describe("GET /api/sites/[id]/competitors", () => {
  it("computes and persists Share of Model per configured competitor", async () => {
    const site = await seed();
    const { status, body } = await get(site.id);
    expect(status).toBe(200);
    expect(body.refreshed).toBe(true);
    expect(body.site).toMatchObject({ competitorDomain: "shop.example.com", citedQueriesCount: 2, samples: 4 });
    expect(body.competitors.map((c: { competitorDomain: string }) => c.competitorDomain)).toEqual(["rival.test", "other.test"]);
    const [rival, other] = body.competitors;
    // citations: shop 2, rival 3, other 1 -> 33.33 / 50 / 16.67
    expect(body.site.shareOfModel).toBe(33.33);
    expect(rival).toMatchObject({ shareOfModel: 50, citedQueriesCount: 2, gapQueriesCount: 2, windowDays: 30 });
    expect(rival.topCitedUrls[0]).toEqual({ url: "https://rival.test/x", count: 3 });
    expect(other).toMatchObject({ shareOfModel: 16.67, citedQueriesCount: 1, gapQueriesCount: 1, sentimentScore: 1 });
    expect(body.citationGapTotal).toBe(2);
    expect(body.citationGaps[0].competitors[0].urls.length).toBeGreaterThan(0);
    expect(body.perModel.chatgpt.samples).toBe(1);
    expect(await prisma.competitorAnalysis.count({ where: { siteId: site.id } })).toBe(2);
  });

  it("serves the stored snapshot without refresh and drops removed competitors", async () => {
    const site = await seed();
    await get(site.id);
    const cached = await get(site.id, "?refresh=false");
    expect(cached.body).toMatchObject({ refreshed: false, site: null });
    expect(cached.body.competitors).toHaveLength(2);

    await prisma.site.update({ where: { id: site.id }, data: { settings: { visibilityAnalysis: { competitors: [RIVAL] } } } });
    const { body } = await get(site.id, "?days=7&gapLimit=1");
    expect(body.competitors).toHaveLength(1);
    expect(body.competitors[0].windowDays).toBe(7);
    expect(body.citationGaps).toHaveLength(1);
  });

  it("works without competitors or data and validates the query", async () => {
    const site = await prisma.site.create({ data: SITE });
    const { status, body } = await get(site.id);
    expect(status).toBe(200);
    expect(body.competitors).toEqual([]);
    expect(body.site).toMatchObject({ shareOfModel: 0, samples: 0 });
    expect((await get(site.id, "?days=0")).status).toBe(400);
    expect((await get(site.id, "?refresh=maybe")).status).toBe(400);
    expect((await get("missing")).status).toBe(404);
  });
});

describe("competitor intelligence extensions", () => {
  it("buckets trend points per UTC day and ISO week", () => {
    const at = new Date("2026-11-05T23:30:00Z"); // Thursday
    expect(trendBucket(at, "day")).toBe("2026-11-05");
    expect(trendBucket(at, "week")).toBe("2026-11-02");
    expect(trendBucket(new Date("2026-11-08T10:00:00Z"), "week")).toBe("2026-11-02"); // Sunday -> previous Monday
    const rows = [
      { id: "1", model: "chatgpt", query: "q", citationStatus: "cited", position: null, excerpt: null, checkedAt: new Date("2026-11-02T10:00:00Z"), responseMeta: answer("Shop.", ["https://shop.example.com/a"]) },
      { id: "2", model: "chatgpt", query: "q", citationStatus: "none", position: null, excerpt: null, checkedAt: new Date("2026-11-03T10:00:00Z"), responseMeta: answer("Rival.", ["https://rival.test/a"]) },
    ];
    const config = { competitors: [RIVAL], facts: [], referencePages: [] };
    const daily = somTrend(SITE, rows, config, "day");
    expect(daily.map((p) => p.start)).toEqual(["2026-11-02", "2026-11-03"]);
    expect(daily[0].shares).toEqual([{ domain: "shop.example.com", citationShare: 100 }, { domain: "rival.test", citationShare: 0 }]);
    const weekly = somTrend(SITE, rows, config, "week");
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatchObject({ start: "2026-11-02", samples: 2 });
    expect(weekly[0].shares.map((s) => s.citationShare)).toEqual([50, 50]);
  });

  it("summarizes tone counts, negative evidence first, and fact conflicts", () => {
    const base = { textCoverage: "full", hallucinations: { status: "unknown", checkedFacts: 1, findings: [], findingCount: 0, method: "h" } };
    const sentiment = (label: string, score: number | null) => ({ label, score, evidence: score === null ? [] : [{ text: `Shop ${label}`, score, terms: [] }], evidenceCount: 1, method: "s" });
    const rows = [
      { ...base, recordId: "a", query: "q1", model: "chatgpt", checkedAt: new Date("2026-11-01"), sentiment: sentiment("positive", 1) },
      { ...base, recordId: "b", query: "q2", model: "gemini", checkedAt: new Date("2026-11-02"), sentiment: sentiment("negative", -1) },
      { ...base, recordId: "c", query: "q3", model: "gemini", checkedAt: new Date("2026-11-03"), sentiment: sentiment("unknown", null), textCoverage: "truncated_or_legacy",
        hallucinations: { status: "needs_review", checkedFacts: 1, findingCount: 1, method: "h", findings: [{ rule: "r", severity: "potential_hallucination", subject: "Shop", text: "Shop was founded in 1990", conflictingClaim: "1990", expected: "2010", sourceUrl: "https://shop.example.com/about", verifiedAt: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" }] } },
    ];
    const s = summarizeBrandSafety(rows, 10);
    expect(s.sentiment).toEqual({ positive: 1, neutral: 0, negative: 1, unknown: 1, averageScore: 0 });
    expect(s.perModel.gemini).toEqual({ positive: 0, neutral: 0, negative: 1, unknown: 1 });
    expect(s.evidence.map((e) => e.recordId)).toEqual(["b", "a"]);
    expect(s.hallucinations).toMatchObject({ checkedFacts: 1, findingCount: 1, affectedAnswers: 1 });
    expect(s.hallucinations.items[0]).toMatchObject({ recordId: "c", conflictingClaim: "1990", expected: "2010" });
    expect(s.textCoverage).toEqual({ full: 2, truncated: 1 });
    expect(summarizeBrandSafety([], 10).sentiment.averageScore).toBeNull();
  });

  it("returns trend, intent-tagged gaps and brand safety from the endpoint", async () => {
    const site = await seed();
    await prisma.syntheticQuery.create({
      data: { siteId: site.id, query: "espresso grinder", intent: "transactional", fingerprint: fingerprintQuery("espresso grinder") },
    });
    const { body } = await get(site.id, "?granularity=week&evidenceLimit=5");
    expect(body.trend.granularity).toBe("week");
    expect(body.trend.points).toHaveLength(1);
    expect(body.trend.points[0].samples).toBe(4);
    // stored synthetic prompt wins over the keyword classifier ("Espresso Grinder " folds to the same fingerprint)
    expect(body.citationGaps.map((g: { intent: string; intentSource: string }) => [g.intent, g.intentSource])).toEqual([
      ["transactional", "synthetic_query"], ["transactional", "synthetic_query"],
    ]);
    expect(body.gapIntents).toEqual({ informational: 0, comparative: 0, transactional: 2, reputation: 0 });
    expect(body.perModel.chatgpt.shares[0]).toMatchObject({ domain: "shop.example.com", citations: 1 });
    expect(body.brandSafety.samples).toBe(4);
    expect(body.brandSafety.sentiment.positive).toBe(1); // "Shop is great."
    expect(body.brandSafety.hallucinations.checkedFacts).toBe(0);
    expect((await get(site.id, "?granularity=month")).status).toBe(400);
  });
});
