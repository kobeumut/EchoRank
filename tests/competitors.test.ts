import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { brandEvidence } from "@/lib/services/competitors";
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
