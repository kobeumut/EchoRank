import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUERY_INTENTS } from "@/lib/constants";
import { difficultyOf, fingerprintQuery, generateQueries, similarity, type Seeds } from "@/lib/services/synthetic-queries";
import * as route from "@/app/api/sites/[id]/queries/synthetic/route";
import { ctx, req, resetDb } from "./helpers";

const BASE = "https://shop.example.com";
const e = (type: string, name: string) => ({ key: `${type.toLowerCase()}:${fingerprintQuery(name).replace(/ /g, "-")}`, name, type });
const SEEDS: Seeds = {
  brand: "Kahve Dükkanı",
  products: [e("Product", "Barista Pro X"), e("Product", "Moka Mini")],
  categories: [e("Category", "Espresso Makineleri")],
  concepts: [e("Concept", "soğuk demleme")],
  competitors: ["Rakip Kahve"],
  questions: [e("FAQ", "Espresso kaç bar basınçla hazırlanır?"), e("FAQ", "Kargo ücretli mi")],
};

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("generateQueries", () => {
  it("covers all four intents in Turkish and English with entity targets", () => {
    const out = generateQueries(SEEDS, { languages: ["tr", "en"], intents: [...QUERY_INTENTS], maxPerIntent: 10 });
    for (const lang of ["tr", "en"]) for (const intent of QUERY_INTENTS) {
      expect(out.filter((q) => q.language === lang && q.intent === intent).length, `${lang}/${intent}`).toBeGreaterThan(0);
    }
    const q = (text: string) => out.find((o) => o.query === text);
    expect(q("Barista Pro X nereden satın alınır?")).toMatchObject({ intent: "transactional", language: "tr", entityKey: "product:barista-pro-x" });
    expect(q("Kahve Dükkanı ile Rakip Kahve karşılaştırması: hangisi daha iyi?")).toMatchObject({ intent: "comparative", entityKey: "site:brand" });
    expect(q("Kahve Dükkanı güvenilir mi?")).toMatchObject({ intent: "reputation" });
    expect(q("Where can I buy Moka Mini?")).toMatchObject({ language: "en", intent: "transactional" });
    expect(q("What are the best Espresso Makineleri brands?")).toBeTruthy();
    // FAQ questions are reused verbatim; statements without "?" are not prompts
    expect(q("Espresso kaç bar basınçla hazırlanır?")).toMatchObject({ intent: "informational", entityKey: SEEDS.questions[0].key });
    expect(out.some((o) => o.query === "Kargo ücretli mi")).toBe(false);
    // no unfilled placeholders, no duplicates
    expect(out.every((o) => !/[{}]/.test(o.query))).toBe(true);
    expect(new Set(out.map((o) => o.fingerprint)).size).toBe(out.length);
  });

  it("respects maxPerIntent and skips templates whose slots have no seed", () => {
    const out = generateQueries({ ...SEEDS, competitors: [] }, { languages: ["tr"], intents: ["comparative"], maxPerIntent: 2 });
    expect(out).toHaveLength(2);
    const bare = generateQueries({ brand: "", products: [], categories: [], concepts: [], competitors: [], questions: [] }, { languages: ["en"], intents: [...QUERY_INTENTS], maxPerIntent: 5 });
    expect(bare).toEqual([]);
  });

  it("dedupes case/diacritics-insensitively and drops near duplicates", () => {
    expect(fingerprintQuery("Kahve Dükkanı GÜVENİLİR mi?")).toBe(fingerprintQuery("kahve dukkani guvenilir mi"));
    expect(similarity("Barista Pro X nereden satın alınır?", "Barista Pro X nereden satin alinir")).toBe(1);
    expect(similarity("Barista Pro X yorumları", "Moka Mini fiyatı")).toBe(0);
    const out = generateQueries(SEEDS, { languages: ["tr"], intents: ["reputation"], maxPerIntent: 10, exclude: ["kahve dukkani guvenilir mi"] });
    expect(out.some((o) => o.query === "Kahve Dükkanı güvenilir mi?")).toBe(false);
  });

  it("scores competitiveness by intent and branding", () => {
    expect(difficultyOf("En iyi espresso makineleri hangileri?", "comparative", "Kahve Dükkanı")).toBeGreaterThan(
      difficultyOf("Kahve Dükkanı güvenilir mi?", "reputation", "Kahve Dükkanı"),
    );
    for (const intent of QUERY_INTENTS) {
      const d = difficultyOf("x", intent, "");
      expect(d).toBeGreaterThanOrEqual(5);
      expect(d).toBeLessThanOrEqual(95);
    }
  });
});

describe("GET/POST /api/sites/[id]/queries/synthetic", () => {
  async function seedSite() {
    const site = await prisma.site.create({
      data: { url: BASE, title: "Kahve Dükkanı", targetKeywords: ["soğuk demleme"], settings: { visibilityAnalysis: { competitors: [{ title: "Rakip Kahve", url: "https://rakip.test" }] } } },
    });
    const mk = (key: string, entityType: string, name: string) => prisma.graphEntity.create({ data: { siteId: site.id, key, entityType, name } });
    await mk("product:bpx", "Product", "Barista Pro X");
    await mk("category:espresso", "Category", "Espresso Makineleri");
    await mk("faq:1", "FAQ", "Espresso kaç bar basınçla hazırlanır?");
    await mk("page:/", "Page", "Anasayfa");
    return site;
  }
  const post = async (siteId: string, body?: unknown) => {
    const res = await route.POST(req(`/api/sites/${siteId}/queries/synthetic`, { method: "POST", body }), ctx(siteId));
    return { status: res.status, body: await res.json() };
  };
  const get = async (siteId: string, qs = "") => {
    const res = await route.GET(req(`/api/sites/${siteId}/queries/synthetic${qs}`), ctx(siteId));
    return { status: res.status, body: await res.json() };
  };

  it("generates from the knowledge graph, stores idempotently and lists by intent", async () => {
    const site = await seedSite();
    const first = await post(site.id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mode: "generate", saved: true, existing: 0 });
    expect(first.body.seeds).toMatchObject({ brand: "Kahve Dükkanı", products: 1, categories: 1, concepts: 1, competitors: 1, questions: 1 });
    expect(first.body.created).toBe(first.body.items.length);
    const again = await post(site.id, { mode: "generate" });
    expect(again.body).toMatchObject({ created: 0, existing: first.body.created });

    const list = await get(site.id);
    expect(list.body.total).toBe(first.body.created);
    expect(Object.keys(list.body.byIntent).sort()).toEqual([...QUERY_INTENTS].sort());
    const tr = await get(site.id, "?language=tr&intent=transactional,reputation");
    expect(tr.body.items.every((q: { language: string; intent: string }) => q.language === "tr" && ["transactional", "reputation"].includes(q.intent))).toBe(true);
    expect(tr.body.items.some((q: { query: string }) => q.query === "Barista Pro X nereden satın alınır?")).toBe(true);
  });

  it("previews without saving, accepts manual prompts and archives", async () => {
    const site = await seedSite();
    const preview = await post(site.id, { mode: "generate", languages: ["en"], intents: ["comparative"], maxPerIntent: 3, save: false });
    expect(preview.body.saved).toBe(false);
    expect(preview.body.items).toHaveLength(3);
    expect(await prisma.syntheticQuery.count()).toBe(0);

    const manual = await post(site.id, { mode: "manual", queries: [
      { query: "Kahve Dükkanı kargo kaç günde gelir?", intent: "transactional" },
      { query: "kahve dukkani kargo kac gunde gelir", intent: "transactional" },
    ] });
    expect(manual.body).toMatchObject({ created: 1, existing: 0 });
    expect(manual.body.items[0]).toMatchObject({ source: "manual", language: "tr" });

    const archived = await post(site.id, { mode: "archive", ids: [manual.body.items[0].id] });
    expect(archived.body.archived).toBe(1);
    expect((await get(site.id, "?source=manual")).body.total).toBe(0);
    expect((await get(site.id, "?status=archived")).body.total).toBe(1);
    // re-adding revives it
    await post(site.id, { mode: "manual", queries: [{ query: "Kahve Dükkanı kargo kaç günde gelir?", intent: "transactional" }] });
    expect((await get(site.id, "?source=manual")).body.total).toBe(1);
  });

  it("validates input and scopes to the site", async () => {
    const site = await seedSite();
    const other = await prisma.site.create({ data: { url: "https://other.example.com", title: "Other" } });
    expect((await post(site.id, { mode: "generate", languages: ["de"] })).status).toBe(400);
    expect((await post(site.id, { mode: "generate", maxPerIntent: 0 })).status).toBe(400);
    expect((await post(site.id, { mode: "manual", queries: [{ query: "hi", intent: "informational" }] })).status).toBe(400);
    expect((await post(site.id, { mode: "manual", queries: [{ query: "a valid one", intent: "navigational" }] })).status).toBe(400);
    expect((await post(site.id, { mode: "nope" })).status).toBe(400);
    expect((await get(site.id, "?intent=bogus")).status).toBe(400);
    const saved = await post(site.id, { mode: "manual", queries: [{ query: "a valid prompt", intent: "informational", language: "en" }] });
    expect((await post(other.id, { mode: "archive", ids: [saved.body.items[0].id] })).status).toBe(404);
    expect((await get("missing")).status).toBe(404);
  });
});

describe("prompt casing", () => {
  it("capitalizes lowercase concepts with Turkish rules but keeps brand casing", () => {
    const base = { brand: "", products: [], categories: [], competitors: [], questions: [] };
    const tr = generateQueries({ ...base, concepts: [e("Concept", "ıslak öğütme")] }, { languages: ["tr"], intents: ["informational"], maxPerIntent: 1 });
    expect(tr[0].query).toBe("Islak öğütme nedir ve nasıl çalışır?");
    const en = generateQueries({ ...base, concepts: [e("Concept", "iPhone")] }, { languages: ["tr"], intents: ["informational"], maxPerIntent: 1 });
    expect(en[0].query).toBe("iPhone nedir ve nasıl çalışır?");
  });
});
