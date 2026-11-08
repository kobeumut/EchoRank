import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { detectLanguage, guessNameLanguage, inflect, questionParticle } from "@/lib/text/turkish";
import {
  asCommonNoun, classifyIntent, cleanEntityName, dedupeQueries, expandWithLlm, generateQueries, generateSiteQueries,
  QUERY_INTENTS, queryQuality, querySimilarity, scoreQuery, TEMPLATES, type QueryEntity, type QueryGeneratorInput,
} from "@/lib/services/query-generator";
import * as queriesRoute from "@/app/api/sites/[id]/queries/route";
import * as visibilityRoute from "@/app/api/sites/[id]/visibility/route";
import { ctx, req, resetDb } from "./helpers";

const NOW = new Date("2026-11-08T00:00:00Z");
const entities: QueryEntity[] = [
  { name: "Barista Pro X | Kahvecim", kind: "product", brand: "Breville", category: "Kahve Makineleri", price: 12499, currency: "TRY", weight: 9 },
  { name: "Mini Espresso 20", kind: "product", brand: "Delonghi", category: "Kahve Makineleri", price: 6999, currency: "TRY", weight: 5 },
  { name: "Kahve Makineleri", kind: "category" },
  { name: "Coffee Grinders", kind: "category" },
  { name: "Breville", kind: "brand" },
  { name: "Soğuk Demleme", kind: "concept" },
  { name: "Espresso makinesi nasıl temizlenir?", kind: "faq" },
  { name: "Home", kind: "category" },
  { name: "https://kahvecim.com/x", kind: "product" },
];
const base: QueryGeneratorInput = { site: { title: "Kahvecim", url: "https://kahvecim.com" }, entities, competitors: ["Kahve Dünyası"], now: NOW };

describe("Turkish morphology", () => {
  it("applies vowel harmony, consonant assimilation and apostrophes", () => {
    expect(inflect("Acme", "ablative")).toBe("Acme'den");
    expect(inflect("Kahvecim", "ablative")).toBe("Kahvecim'den");
    expect(inflect("Trendyol", "ablative")).toBe("Trendyol'dan");
    expect(inflect("Doğuş", "ablative")).toBe("Doğuş'tan");
    expect(inflect("Kahve Dünyası", "ablative")).toBe("Kahve Dünyası'ndan");
    expect(inflect("Türk Hava Yolları", "dative")).toBe("Türk Hava Yolları'na");
    expect(inflect("Kahve Dünyası", "locative")).toBe("Kahve Dünyası'nda");
    expect(inflect("Samsung", "genitive")).toBe("Samsung'un");
    expect(inflect("Arçelik", "genitive")).toBe("Arçelik'in");
    expect(inflect("Kahve Dünyası", "genitive")).toBe("Kahve Dünyası'nın");
    expect(inflect("Türk Telekom", "genitive")).toBe("Türk Telekom'un");
    expect(inflect("Ütü", "genitive")).toBe("Ütü'nün");
    expect(inflect("Acme", "locative")).toBe("Acme'de");
    expect(inflect("Hepsiburada", "dative")).toBe("Hepsiburada'ya");
    expect(inflect("kahve", "accusative", false)).toBe("kahveyi");
  });

  it("reads digits, acronyms and silent-e foreign names as they are pronounced", () => {
    expect(inflect("iPhone 15", "genitive")).toBe("iPhone 15'in");
    expect(inflect("Galaxy S3", "ablative")).toBe("Galaxy S3'ten");
    expect(inflect("Model 100", "ablative")).toBe("Model 100'den");
    expect(inflect("Seri 40", "genitive")).toBe("Seri 40'ın");
    expect(inflect("Seri 2000", "genitive")).toBe("Seri 2000'in");
    expect(inflect("BMW", "genitive")).toBe("BMW'nin");
    expect(inflect("THY", "ablative")).toBe("THY'den");
    expect(inflect("Barista Pro X", "genitive")).toBe("Barista Pro X'in");
    expect(inflect("Apple", "genitive")).toBe("Apple'ın");
    expect(inflect("Google", "ablative")).toBe("Google'dan");
    expect(inflect("Breville", "genitive")).toBe("Breville'in");
  });

  it("writes the question particle separately with four-way harmony", () => {
    expect(questionParticle("Acme")).toBe("mi");
    expect(questionParticle("Rival")).toBe("mı");
    expect(questionParticle("Bosch")).toBe("mu");
    expect(questionParticle("Ürün")).toBe("mü");
    expect(questionParticle("Kahve Dünyası")).toBe("mı");
  });

  it("guesses the language of sentences and bare names", () => {
    expect(detectLanguage("Espresso makinesi nasıl temizlenir?")).toBe("tr");
    expect(detectLanguage("How do I descale an espresso machine?")).toBe("en");
    expect(detectLanguage("Barista")).toBeNull();
    expect(guessNameLanguage("Kahve Makineleri")).toBe("tr");
    expect(guessNameLanguage("Soğuk Demleme")).toBe("tr");
    expect(guessNameLanguage("Coffee Grinders")).toBe("en");
    expect(guessNameLanguage("Espresso")).toBeNull();
    expect(guessNameLanguage("Natural oils")).toBe("en");
    expect(guessNameLanguage("Kitchen Tools")).toBe("en");
    expect(guessNameLanguage("Mutfak Gereçleri")).toBe("tr");
    expect(guessNameLanguage("Bahçe Mobilyası")).toBe("tr");
  });
});

describe("entity hygiene", () => {
  it("strips site suffixes and rejects URLs, generic navigation and sentences", () => {
    expect(cleanEntityName("Barista Pro X | Kahvecim", "Kahvecim")).toBe("Barista Pro X");
    expect(cleanEntityName("Kahve Makineleri - Kahvecim", "Kahvecim")).toBe("Kahve Makineleri");
    expect(cleanEntityName("  Mini   Espresso  ")).toBe("Mini Espresso");
    for (const bad of ["Home", "Anasayfa", "https://x.test", "a", "<b>", "123", "Bu çok uzun bir cümle olup bir varlık adı olamayacak kadar fazla kelime içerir"]) {
      expect(cleanEntityName(bad)).toBeNull();
    }
    expect(asCommonNoun("Kahve Makineleri")).toBe("kahve makineleri");
    expect(asCommonNoun("İçecekler")).toBe("içecekler");
    expect(asCommonNoun("iPhone Kılıfları")).toBe("iPhone Kılıfları");
    expect(asCommonNoun("Breville Aksesuarları", ["breville"])).toBe("Breville aksesuarları");
  });
});

describe("multi-intent generation", () => {
  it("covers all four intents in both languages, manual keywords first", () => {
    const out = generateQueries({ ...base, keywords: ["espresso makinesi önerisi"] });
    expect(out[0]).toMatchObject({ text: "espresso makinesi önerisi", source: "manual", intent: "comparative", language: "tr" });
    for (const lang of ["tr", "en"] as const) {
      for (const intent of QUERY_INTENTS) expect(out.filter((q) => q.language === lang && q.intent === intent).length, `${lang}/${intent}`).toBeGreaterThanOrEqual(3);
    }
    // The first round already has one query per intent per language.
    expect(new Set(out.slice(1, 9).map((q) => `${q.language}:${q.intent}`)).size).toBe(8);
    for (const q of out) {
      expect(q.text).not.toMatch(/[{}]|undefined|null|https?:|\| Kahvecim|Home/);
      expect(q.quality).toBeGreaterThanOrEqual(0.6);
      expect(q.difficulty.score).toBeGreaterThanOrEqual(0);
      expect(q.difficulty.score).toBeLessThanOrEqual(100);
      expect(["low", "medium", "high"]).toContain(q.volume.level);
    }
    expect(generateQueries({ ...base, keywords: ["espresso makinesi önerisi"] })).toEqual(out); // deterministic
  });

  it("injects entities with correct Turkish grammar", () => {
    const all = generateQueries({ ...base, perIntent: 50 }).map((q) => q.text);
    expect(all).toContain("Barista Pro X nereden satın alınır?");
    expect(all).toContain("Barista Pro X'in kronik sorunları nelerdir?");
    expect(all).toContain("Mini Espresso 20'nin kronik sorunları nelerdir?");
    expect(all).toContain("En iyi kahve makineleri markaları hangileri?");
    expect(all).toContain("Kahvecim'den alışveriş yapmak güvenli mi?");
    expect(all).toContain("Kahvecim güvenilir mi?");
    expect(all).toContain("Kahvecim mi Kahve Dünyası mı? Hangisi daha iyi?");
    expect(all).toContain("Barista Pro X mi Mini Espresso 20 mi? Hangisi daha iyi?");
    expect(all).toContain("15.000 TL altı en iyi kahve makineleri önerileri nelerdir?"); // median price → nice ceiling
    expect(all).toContain("Soğuk demleme nedir ve nasıl çalışır?");
    expect(all).toContain("Espresso makinesi nasıl temizlenir?"); // FAQ kept verbatim
    expect(all).toContain("Which brands make the best coffee grinders?");
    expect(all).toContain("Is it safe to buy from Kahvecim?");
    // Turkish category names never land in English templates and vice versa.
    expect(all.some((t) => /kahve makineleri/i.test(t) && /\b(what|which|where|how)\b/i.test(t))).toBe(false);
    expect(all.some((t) => /coffee grinders/i.test(t) && /(nedir|hangileri|nereden)/.test(t))).toBe(false);
  });

  it("labels targets, branded prompts and conversational expansions", () => {
    const out = generateQueries({ ...base, perIntent: 50 });
    const vs = out.find((q) => q.text.startsWith("Kahvecim vs Kahve Dünyası"))!;
    expect(vs.targets).toEqual([{ name: "Kahvecim", kind: "site" }, { name: "Kahve Dünyası", kind: "competitor" }]);
    expect(vs.branded).toBe(true);
    expect(out.find((q) => q.text === "Barista Pro X nereden satın alınır?")).toMatchObject({ branded: false, intent: "transactional", targets: [{ name: "Barista Pro X", kind: "product" }] });
    const expansions = out.filter((q) => q.source === "expansion");
    expect(expansions.length).toBeGreaterThan(4);
    expect(expansions.some((q) => q.text.startsWith("As of 2026, "))).toBe(true);
    expect(expansions.every((q) => q.text.split(" ").length >= 4)).toBe(true);
    expect(expansions.map((q) => q.text)).toContain("2026 itibarıyla Kahvecim'den alışveriş yapmak güvenli mi?"); // brand casing survives the prefix
    expect(expansions.map((q) => q.text)).toContain("Bu konuda yeniyim, sade bir dille anlatır mısın: kahve makineleri alırken nelere dikkat etmeliyim?");
    expect(generateQueries({ ...base, expand: false, perIntent: 50 }).some((q) => q.source === "expansion")).toBe(false);
  });

  it("restricts intents and languages and keeps per-bucket diversity", () => {
    const out = generateQueries({ ...base, intents: ["reputation"], languages: ["en"], perIntent: 3 });
    expect(out).toHaveLength(3);
    expect(out.every((q) => q.intent === "reputation" && q.language === "en")).toBe(true);
    const tr = generateQueries({ ...base, languages: ["tr"], intents: ["comparative"], perIntent: 4, expand: false });
    expect(new Set(tr.map((q) => q.targets[0].name)).size).toBe(4);
  });

  it("produces a usable set for a site with no graph at all", () => {
    const out = generateQueries({ site: { title: "Acme", url: "https://acme.test" }, entities: [], languages: ["tr"] });
    expect(out.map((q) => q.intent)).toEqual(expect.arrayContaining(["comparative", "transactional", "reputation"]));
    expect(out.every((q) => q.branded)).toBe(true);
  });

  it("every template renders a clean sentence for every kind it declares", () => {
    const e: QueryEntity = { name: "Acme Pro", kind: "product" };
    for (const t of TEMPLATES) for (const lang of ["tr", "en"] as const) {
      const text = t[lang]?.({ e: { ...e, kind: t.kinds[0] }, lang, year: 2026, site: "Acme", rival: "Rival", budget: { amount: 1000, currency: "TRY" } });
      expect(text, t.id).toBeTruthy();
      expect(queryQuality(text!), t.id).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe("classification, scoring and duplicate filtering", () => {
  it("classifies free text into the four intents in both languages", () => {
    expect(classifyIntent("Kahvecim güvenilir mi?")).toBe("reputation");
    expect(classifyIntent("Is Acme legit?")).toBe("reputation");
    expect(classifyIntent("X nereden satın alınır?")).toBe("transactional");
    expect(classifyIntent("Acme discount code")).toBe("transactional");
    expect(classifyIntent("En iyi kahve makinesi hangisi?")).toBe("comparative");
    expect(classifyIntent("Acme vs Rival")).toBe("comparative");
    expect(classifyIntent("Soğuk demleme nedir?")).toBe("informational");
    expect(classifyIntent("How does cold brew work?")).toBe("informational");
  });

  it("rates generic head terms harder and more frequent than branded long-tail prompts", () => {
    const head = scoreQuery("En iyi kahve makineleri markaları hangileri?", "comparative", ["category"]);
    const tail = scoreQuery("Kahvecim kargo, iade ve değişim koşulları nelerdir?", "transactional", ["site"], { branded: true });
    expect(head.difficulty.level).toBe("high");
    expect(tail.difficulty.level).toBe("low");
    expect(head.volume.score).toBeGreaterThan(tail.volume.score);
  });

  it("rejects malformed and penalises awkward prompts", () => {
    expect(queryQuality("Kısa?")).toBe(0);
    expect(queryQuality("{name} nedir ve nasıl çalışır?")).toBe(0);
    expect(queryQuality("undefined nereden satın alınır?")).toBe(0);
    expect(queryQuality("Makine makine nereden satın alınır?")).toBeLessThan(0.7);
    expect(queryQuality("Barista Pro X nereden satın alınır?")).toBe(1);
  });

  it("drops near-duplicates across phrasing, casing and Turkish characters but keeps distinct intents", () => {
    expect(querySimilarity("Barista Pro X nereden satın alınır?", "barista pro x nereden satin alinir")).toBe(1);
    expect(querySimilarity("Barista Pro X nereden satın alınır?", "Barista Pro X kronik sorunları nelerdir?")).toBeLessThan(0.5);
    const items = [
      { text: "Where can I buy Barista Pro X?", language: "en", score: 50 },
      { text: "Where can I buy the Barista Pro X?", language: "en", score: 60 },
      { text: "Is Barista Pro X worth buying?", language: "en", score: 40 },
      { text: "Barista Pro X nereden satın alınır?", language: "tr", score: 10 },
      { text: "barista pro x nereden satin alinir?", language: "tr", score: 5 },
    ];
    expect(dedupeQueries(items).map((i) => i.text)).toEqual(["Where can I buy the Barista Pro X?", "Is Barista Pro X worth buying?", "Barista Pro X nereden satın alınır?"]);
    const out = generateQueries({ ...base, perIntent: 50 });
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      if (out[i].language === out[j].language) expect(querySimilarity(out[i].text, out[j].text), `${out[i].text} ~ ${out[j].text}`).toBeLessThan(0.8);
    }
  });
});

describe("LLM query expansion", () => {
  it("parses, labels and filters model rephrasings without calling any provider itself", async () => {
    const seeds = generateQueries({ ...base, languages: ["en"], intents: ["transactional"], perIntent: 1, expand: false });
    const complete = vi.fn(async (prompt: string) => {
      expect(prompt).toContain(seeds[0].text);
      return [`1. ${seeds[0].text}`, "- Which shops stock coffee grinders with next-day delivery?", "Kahve öğütücü nereden alınır?", "x?"].join("\n");
    });
    const out = await expandWithLlm(seeds, complete, { siteTitle: "Kahvecim" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.map((q) => q.text)).toEqual(["Which shops stock coffee grinders with next-day delivery?"]);
    expect(out[0]).toMatchObject({ source: "llm", intent: "transactional", language: "en", targets: seeds[0].targets });
    expect(await expandWithLlm(seeds, async () => { throw new Error("down"); })).toEqual([]);
  });
});

describe("database + API integration", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("API_TOKEN", "test-token");
    for (const p of ["OPENAI", "GEMINI", "ANTHROPIC", "PERPLEXITY"]) { vi.stubEnv(`${p}_API_KEY`, "k"); vi.stubEnv(`${p}_MODEL`, "m"); }
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(() => prisma.$disconnect());

  async function seedSite(locale?: string) {
    const site = await prisma.site.create({ data: {
      url: "https://kahvecim.com", title: "Kahvecim", targetKeywords: ["kahvecim yorumları"],
      settings: { ...(locale ? { locale } : {}), visibilityAnalysis: { competitors: [{ title: "Kahve Dünyası", url: "https://kahvedunyasi.com" }] } },
    } });
    const mk = (key: string, name: string, entityType: string, properties?: object) =>
      prisma.graphEntity.create({ data: { siteId: site.id, key, name, entityType, properties } });
    const bpx = await mk("product:bpx", "Barista Pro X", "Product", { price: 12499, currency: "TRY", pagerank: 0.4 });
    const me = await mk("product:me", "Mini Espresso 20", "Product", { price: 6999, currency: "TRY" });
    const cat = await mk("category:km", "Kahve Makineleri", "Category");
    const brand = await mk("brand:breville", "Breville", "Brand");
    await mk("faq:clean", "Espresso makinesi nasıl temizlenir?", "FAQ", { answer: "Haftada bir kireç çözücü..." });
    await prisma.graphRelation.createMany({ data: [
      { siteId: site.id, sourceId: bpx.id, targetId: cat.id, relationType: "has_category" },
      { siteId: site.id, sourceId: me.id, targetId: cat.id, relationType: "has_category" },
      { siteId: site.id, sourceId: bpx.id, targetId: brand.id, relationType: "has_brand" },
    ] });
    await prisma.crawledPage.create({ data: { siteId: site.id, url: "https://kahvecim.com/blog/v60", pageType: "article", statusCode: 200, h1: "V60 ile filtre kahve nasıl demlenir?" } });
    return site;
  }

  it("builds queries from graph relations, prices, crawled headings, competitors and locale", async () => {
    const site = await seedSite("tr-TR");
    const out = await generateSiteQueries(site.id, { perIntent: 50, now: NOW });
    const texts = out.map((q) => q.text);
    expect(out.every((q) => q.language === "tr")).toBe(true);
    expect(texts[0]).toBe("kahvecim yorumları");
    expect(texts).toContain("15.000 TL altı en iyi kahve makineleri önerileri nelerdir?");
    expect(texts).toContain("Barista Pro X mi Mini Espresso 20 mi? Hangisi daha iyi?");
    expect(texts).toContain("Kahvecim mi Kahve Dünyası mı? Hangisi daha iyi?");
    expect(texts).toContain("V60 ile filtre kahve nasıl demlenir?");
    expect(texts).toContain("Espresso makinesi nasıl temizlenir?");
    expect((await generateSiteQueries(site.id, { languages: ["en"], now: NOW })).every((q) => q.language === "en" || q.source === "manual")).toBe(true);
  });

  it("exposes GET /api/sites/:id/queries with filters and validation", async () => {
    const site = await seedSite();
    const res = await queriesRoute.GET(req(`/api/sites/${site.id}/queries?intents=comparative,reputation&languages=tr&perIntent=2`), ctx(site.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byIntent).toMatchObject({ comparative: 2, reputation: 3, informational: 0, transactional: 0 }); // + manual "yorumları" (reputation)
    expect(body.items[0]).toMatchObject({ text: "kahvecim yorumları", intent: "reputation", source: "manual" });
    for (const bad of ["?intents=other", "?languages=de", "?perIntent=0", "?expand=yes"]) {
      expect((await queriesRoute.GET(req(`/q${bad}`), ctx(site.id))).status).toBe(400);
    }
    expect((await queriesRoute.GET(req("/q"), ctx("missing"))).status).toBe(404);
  });

  it("feeds the visibility engine: suggestions carry labels and auto runs record the intent", async () => {
    const site = await seedSite("tr");
    const listing = await (await visibilityRoute.GET(req("/"), ctx(site.id))).json();
    expect(listing.queries).toHaveLength(10);
    expect(listing.queries[0]).toBe("kahvecim yorumları");
    expect(new Set(listing.querySuggestions.slice(0, 10).map((q: { intent: string }) => q.intent))).toEqual(new Set(QUERY_INTENTS));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "1. Kahvecim" } }], citations: ["https://kahvecim.com"] })));
    const request = req(`/api/sites/${site.id}/visibility`, { method: "POST", body: { models: ["perplexity"], intents: ["transactional"] } });
    request.headers.set("authorization", "Bearer test-token");
    const run = await (await visibilityRoute.POST(request, ctx(site.id))).json();
    expect(run.attempted).toBeGreaterThan(1);
    expect(run.attempted).toBeLessThanOrEqual(10);
    const records = await prisma.llmVisibilityRecord.findMany();
    const metas = records.map((r) => r.responseMeta as Record<string, unknown>);
    // the manual keyword is always included; everything else is transactional
    expect(metas.filter((m) => m.querySource !== "manual").every((m) => m.queryIntent === "transactional" && m.queryLanguage === "tr")).toBe(true);
    expect(metas.some((m) => m.querySource === "template")).toBe(true);

    const explicit = req(`/api/sites/${site.id}/visibility`, { method: "POST", body: { models: ["perplexity"], queries: ["Kahvecim güvenilir mi?"] } });
    explicit.headers.set("authorization", "Bearer test-token");
    await visibilityRoute.POST(explicit, ctx(site.id));
    const rec = await prisma.llmVisibilityRecord.findFirst({ where: { query: "Kahvecim güvenilir mi?" }, orderBy: { checkedAt: "desc" } });
    expect(rec!.responseMeta).toMatchObject({ queryIntent: "reputation" });
    expect(rec!.responseMeta).not.toHaveProperty("querySource");
  });
});
