// GEO-bench style synthetic test prompts: conversational queries in four intents (informational, comparative,
// transactional, reputation), Turkish and English, built from the site's knowledge graph (products, categories,
// brands, concepts, FAQ questions), target keywords and configured competitors. Stored per site with a
// case/diacritics-insensitive fingerprint, and near-duplicates (token Jaccard >= 0.8) are dropped.
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { QUERY_INTENTS, QUERY_LANGUAGES, QUERY_SOURCES, QUERY_STATUSES, type QueryIntent, type QueryLanguage } from "../constants";
import { prisma } from "../db";
import { notFound } from "../http";
import { csvEnum } from "../validation";
import { host, visibilityAnalysisSettings } from "../visibility-analysis";
import { getSiteOrThrow } from "./sites";
import { fold } from "./wikidata";

type Slot = "product" | "category" | "brand" | "concept" | "competitor";
type Template = { text: string; slots: Slot[] };

const t = (text: string): Template => ({ text, slots: [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as Slot) });

/**
 * Prompt templates per language and intent. The `tr` block is deliberately Turkish: it is functional language data
 * (the prompts a Turkish-speaking user sends to an AI assistant, used for Turkish-language sites), not UI text.
 * `en` is its English counterpart; the language is chosen per request (`languages`).
 */
export const TEMPLATES: Record<QueryLanguage, Record<QueryIntent, Template[]>> = {
  tr: {
    informational: [
      t("{concept} nedir ve nasıl çalışır?"),
      t("{category} seçerken nelere dikkat etmeliyim?"),
      t("{product} nasıl kullanılır, temel özellikleri neler?"),
      t("{category} türleri arasındaki farklar nelerdir?"),
    ],
    comparative: [
      t("En iyi {category} markaları hangileri?"),
      t("{brand} ile {competitor} karşılaştırması: hangisi daha iyi?"),
      t("{product} alternatifleri nelerdir?"),
      t("Fiyat/performans açısından en iyi {category} modelleri hangileri?"),
    ],
    transactional: [
      t("{product} nereden satın alınır?"),
      t("{product} en uygun fiyat ve indirim kampanyaları"),
      t("{product} stokta var mı, kargo süresi ne kadar?"),
      t("{brand} yetkili satıcıları hangileri?"),
    ],
    reputation: [
      t("{brand} güvenilir mi?"),
      t("{product} kullanıcı yorumları ve kronik sorunları neler?"),
      t("{brand} hakkında şikayetler ve müşteri deneyimleri"),
      t("{brand} garanti ve iade süreci nasıl işliyor?"),
    ],
  },
  en: {
    informational: [
      t("What is {concept} and how does it work?"),
      t("What should I look for when choosing {category}?"),
      t("How do you use {product} and what are its key features?"),
      t("What are the different types of {category}?"),
    ],
    comparative: [
      t("What are the best {category} brands?"),
      t("{brand} vs {competitor}: which one is better?"),
      t("What are the best alternatives to {product}?"),
      t("Which {category} offers the best value for money?"),
    ],
    transactional: [
      t("Where can I buy {product}?"),
      t("{product} best price and discount deals"),
      t("Is {product} in stock and how long does shipping take?"),
      t("Who are the authorized {brand} resellers?"),
    ],
    reputation: [
      t("Is {brand} legit and trustworthy?"),
      t("{product} reviews and common problems"),
      t("{brand} customer complaints and experiences"),
      t("How do {brand} warranty and returns work?"),
    ],
  },
};

const BASE_DIFFICULTY: Record<QueryIntent, number> = { informational: 40, comparative: 70, transactional: 60, reputation: 45 };

export type SeedEntity = { key: string; name: string; type: string };
export type Seeds = {
  brand: string;
  products: SeedEntity[];
  categories: SeedEntity[];
  concepts: SeedEntity[];
  competitors: string[];
  questions: SeedEntity[];
};
export type GeneratedQuery = {
  query: string;
  intent: QueryIntent;
  language: QueryLanguage;
  entityKey: string | null;
  entityName: string | null;
  difficulty: number;
  fingerprint: string;
};

export const fingerprintQuery = (q: string) => fold(q);
const tokenSet = (q: string) => new Set(fold(q).split(" ").filter((w) => w.length > 1));

export function similarity(a: string | Set<string>, b: string | Set<string>): number {
  const x = typeof a === "string" ? tokenSet(a) : a;
  const y = typeof b === "string" ? tokenSet(b) : b;
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared);
}

/**
 * Heuristic competitiveness 0-100: comparative prompts are the most contested, generic (unbranded) prompts compete
 * with the whole category, prompts naming the site's own brand are the easiest to win.
 */
export function difficultyOf(query: string, intent: QueryIntent, brand: string): number {
  let d = BASE_DIFFICULTY[intent];
  const branded = !!brand && fold(query).includes(fold(brand));
  d += branded ? -20 : 10;
  const words = fold(query).split(" ").length;
  if (words >= 10) d -= 5; // long-tail
  if (words <= 4) d += 5;
  return Math.max(5, Math.min(95, d));
}

function fill(tpl: Template, values: Partial<Record<Slot, string>>, lang: QueryLanguage): string | null {
  if (tpl.slots.some((s) => !values[s])) return null;
  const text = tpl.text.replace(/\{(\w+)\}/g, (_, s: Slot) => values[s]!.trim()).replace(/\s+/g, " ").trim();
  // Capitalise a lower-case start with the language's rules (Turkish "ıslak" -> "Islak"; "i" -> "İ"), but never "iPhone" -> "IPhone".
  return /^\p{Ll}\p{Ll}/u.test(text) ? text.charAt(0).toLocaleUpperCase(lang) + text.slice(1) : text;
}

/** Template expansion over the seeds; deterministic order (seed order x template order), deduplicated. */
export function generateQueries(
  seeds: Seeds,
  opts: { languages: QueryLanguage[]; intents: QueryIntent[]; maxPerIntent: number; exclude?: string[] },
): GeneratedQuery[] {
  const out: GeneratedQuery[] = [];
  const seen = [...(opts.exclude ?? [])];
  const seenFp = new Set(seen.map(fingerprintQuery));
  const push = (query: string, intent: QueryIntent, lang: QueryLanguage, entity: SeedEntity | null) => {
    if (query.length > 500) return false;
    const fp = fingerprintQuery(query);
    if (!fp || seenFp.has(fp) || seen.some((s) => similarity(s, query) >= 0.8)) return false;
    seenFp.add(fp);
    seen.push(query);
    out.push({ query, intent, language: lang, entityKey: entity?.key ?? null, entityName: entity?.name ?? null, difficulty: difficultyOf(query, intent, seeds.brand), fingerprint: fp });
    return true;
  };
  const brandEntity: SeedEntity | null = seeds.brand ? { key: "site:brand", name: seeds.brand, type: "Brand" } : null;
  for (const lang of opts.languages) {
    for (const intent of opts.intents) {
      let count = 0;
      const room = () => count < opts.maxPerIntent;
      // FAQ questions already are real informational prompts.
      if (intent === "informational") {
        for (const q of seeds.questions) if (room() && /\?$/.test(q.name.trim()) && push(q.name.trim(), intent, lang, q)) count++;
      }
      const combos: [Partial<Record<Slot, string>>, SeedEntity | null][] = [];
      const max = Math.max(seeds.products.length, seeds.categories.length, seeds.concepts.length, seeds.competitors.length, 1);
      for (let i = 0; i < max; i++) {
        const product = seeds.products[i];
        const category = seeds.categories[i];
        const concept = seeds.concepts[i] ?? category;
        const competitor = seeds.competitors[i];
        if (product) combos.push([{ product: product.name, brand: seeds.brand, competitor }, product]);
        if (category) combos.push([{ category: category.name, concept: category.name, brand: seeds.brand, competitor }, category]);
        if (concept && concept !== category) combos.push([{ concept: concept.name, brand: seeds.brand }, concept]);
        if (competitor && !product && !category) combos.push([{ brand: seeds.brand, competitor }, brandEntity]);
        if (i === 0) combos.push([{ brand: seeds.brand, competitor }, brandEntity]);
      }
      for (const tpl of TEMPLATES[lang][intent]) {
        for (const [values, entity] of combos) {
          if (!room()) break;
          // the template decides which entity a prompt targets
          const target = tpl.slots.includes("product") || tpl.slots.includes("category") || tpl.slots.includes("concept") ? entity : brandEntity;
          const query = fill(tpl, values, lang);
          if (query && push(query, intent, lang, target)) count++;
        }
      }
    }
  }
  return out;
}

export async function loadSeeds(siteId: string): Promise<Seeds> {
  const site = await getSiteOrThrow(siteId);
  const entities = await prisma.graphEntity.findMany({
    where: { siteId, entityType: { in: ["Product", "Category", "Concept", "FAQ", "Question", "Brand", "Organization"] } },
    orderBy: [{ entityType: "asc" }, { name: "asc" }],
    select: { key: true, name: true, entityType: true },
    take: 2_000,
  });
  const pick = (...types: string[]) =>
    entities
      .filter((e) => types.includes(e.entityType) && e.name.trim().length > 1 && e.name.length <= 120)
      .map((e) => ({ key: e.key, name: e.name.trim(), type: e.entityType }));
  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const parsed = visibilityAnalysisSettings.safeParse(settings.visibilityAnalysis ?? {});
  const keywords = Array.isArray(site.targetKeywords)
    ? site.targetKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 1).map((k) => ({ key: `keyword:${fold(k)}`, name: k.trim(), type: "Concept" }))
    : [];
  const ownBrand = pick("Organization", "Brand")[0]?.name;
  return {
    brand: ownBrand ?? site.title ?? host(site.url) ?? "",
    products: pick("Product").slice(0, 50),
    categories: pick("Category").slice(0, 30),
    concepts: [...keywords, ...pick("Concept")].slice(0, 30),
    competitors: parsed.success ? parsed.data.competitors.map((c) => c.title) : [],
    questions: pick("FAQ", "Question").slice(0, 50),
  };
}

// ---------------------------------------------------------------- API

export const syntheticQueryListSchema = z.object({
  intent: csvEnum(QUERY_INTENTS),
  language: z.enum(QUERY_LANGUAGES).optional(),
  status: z.enum(QUERY_STATUSES).default("active"),
  source: z.enum(QUERY_SOURCES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const syntheticQueryInputSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("generate"),
      languages: z.array(z.enum(QUERY_LANGUAGES)).min(1).max(QUERY_LANGUAGES.length).default(["tr", "en"]),
      intents: z.array(z.enum(QUERY_INTENTS)).min(1).max(QUERY_INTENTS.length).default([...QUERY_INTENTS]),
      maxPerIntent: z.number().int().min(1).max(50).default(10),
      /** false = preview only, nothing is stored. */
      save: z.boolean().default(true),
    }).strict(),
    z.object({
      mode: z.literal("manual"),
      queries: z.array(z.object({
        query: z.string().trim().min(3).max(500),
        intent: z.enum(QUERY_INTENTS),
        language: z.enum(QUERY_LANGUAGES).default("tr"),
      }).strict()).min(1).max(200),
    }).strict(),
    z.object({
      mode: z.literal("archive"),
      ids: z.array(z.string().min(1).max(64)).min(1).max(500),
    }).strict(),
  ])
  .default({ mode: "generate", languages: ["tr", "en"], intents: [...QUERY_INTENTS], maxPerIntent: 10, save: true });

type Input = z.infer<typeof syntheticQueryInputSchema>;

async function save(siteId: string, rows: (Omit<GeneratedQuery, "fingerprint"> & { fingerprint: string; source: string })[]) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.syntheticQuery.findMany({ where: { siteId, fingerprint: { in: rows.map((r) => r.fingerprint) } }, select: { fingerprint: true } });
    const known = new Set(existing.map((e) => e.fingerprint));
    const fresh = rows.filter((r) => !known.has(r.fingerprint));
    if (fresh.length) await tx.syntheticQuery.createMany({ data: fresh.map((r) => ({ siteId, ...r })) });
    // re-proposing an archived prompt brings it back
    await tx.syntheticQuery.updateMany({ where: { siteId, status: "archived", fingerprint: { in: [...known] } }, data: { status: "active" } });
    return { created: fresh.length, existing: known.size };
  });
}

export async function createSyntheticQueries(siteId: string, input: Input) {
  await getSiteOrThrow(siteId);
  if (input.mode === "archive") {
    const { count } = await prisma.syntheticQuery.updateMany({ where: { siteId, id: { in: input.ids } }, data: { status: "archived" } });
    if (!count) throw notFound("Synthetic query");
    return { mode: input.mode, archived: count };
  }
  if (input.mode === "manual") {
    const unique = new Map(input.queries.map((q) => [fingerprintQuery(q.query), q]));
    const seeds = await loadSeeds(siteId);
    const rows = [...unique].map(([fingerprint, q]) => ({
      query: q.query, intent: q.intent, language: q.language, entityKey: null, entityName: null,
      difficulty: difficultyOf(q.query, q.intent, seeds.brand), fingerprint, source: "manual",
    }));
    return { mode: input.mode, ...(await save(siteId, rows)), items: await byFingerprint(siteId, rows.map((r) => r.fingerprint)) };
  }
  const seeds = await loadSeeds(siteId);
  const active = (await prisma.syntheticQuery.findMany({ where: { siteId, status: "active" }, select: { fingerprint: true, query: true }, take: 5_000 }))
    .map((a) => ({ fingerprint: a.fingerprint, tokens: tokenSet(a.query) }));
  // stored prompts only block near-duplicates; exact matches are reported as `existing`
  const generated = generateQueries(seeds, input).filter((g) => {
    const tokens = tokenSet(g.query);
    return !active.some((a) => a.fingerprint !== g.fingerprint && similarity(a.tokens, tokens) >= 0.8);
  });
  if (!input.save) return { mode: input.mode, saved: false, seeds: seedCounts(seeds), items: generated };
  const stats = await save(siteId, generated.map((g) => ({ ...g, source: "template" })));
  return { mode: input.mode, saved: true, seeds: seedCounts(seeds), ...stats, items: await byFingerprint(siteId, generated.map((g) => g.fingerprint)) };
}

const seedCounts = (s: Seeds) => ({
  brand: s.brand, products: s.products.length, categories: s.categories.length, concepts: s.concepts.length,
  competitors: s.competitors.length, questions: s.questions.length,
});

const byFingerprint = (siteId: string, fps: string[]) =>
  prisma.syntheticQuery.findMany({ where: { siteId, fingerprint: { in: fps } }, orderBy: [{ intent: "asc" }, { language: "asc" }, { createdAt: "asc" }] });

export async function listSyntheticQueries(siteId: string, q: z.infer<typeof syntheticQueryListSchema>) {
  await getSiteOrThrow(siteId);
  const where: Prisma.SyntheticQueryWhereInput = {
    siteId, status: q.status,
    ...(q.intent ? { intent: { in: q.intent } } : {}),
    ...(q.language ? { language: q.language } : {}),
    ...(q.source ? { source: q.source } : {}),
  };
  const [items, total, byIntent] = await Promise.all([
    prisma.syntheticQuery.findMany({ where, orderBy: [{ intent: "asc" }, { difficulty: "desc" }, { createdAt: "asc" }], take: q.limit, skip: q.offset }),
    prisma.syntheticQuery.count({ where }),
    prisma.syntheticQuery.groupBy({ by: ["intent"], where: { siteId, status: "active" }, _count: { _all: true } }),
  ]);
  return { items, total, byIntent: Object.fromEntries(byIntent.map((r) => [r.intent, r._count._all])) };
}
