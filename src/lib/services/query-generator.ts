// Synthetic query discovery (GEO-bench style multi-intent prompts).
//
// Turns a site's knowledge graph (products, categories, brands, concepts, FAQs) and crawled page
// headings into the long, conversational prompts people actually send to AI search engines, in
// four intents × two languages. Every query is labelled with intent, language, target entities,
// a competition (difficulty) estimate, a relative volume estimate and a quality score; near
// duplicates are removed with a token + character-trigram similarity filter.
//
// The pure core (`generateQueries`) is deterministic and does no I/O. `generateSiteQueries` loads
// the graph from the database; `expandWithLlm` optionally adds model-written variants through an
// injected completion function (no provider is called implicitly — paid calls stay opt-in).

import { z } from "zod";
import { prisma } from "../db";
import { visibilityAnalysisSettings } from "../visibility-analysis";
import { detectLanguage, foldTurkish, guessNameLanguage, inflect, questionParticle, trLower } from "../text/turkish";
import { getSiteOrThrow } from "./sites";

export const QUERY_INTENTS = ["informational", "comparative", "transactional", "reputation"] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];
export const QUERY_LANGUAGES = ["tr", "en"] as const;
export type QueryLanguage = (typeof QUERY_LANGUAGES)[number];
export type EntityKind = "product" | "category" | "brand" | "concept" | "faq" | "site" | "topic" | "competitor";
export type Level = "low" | "medium" | "high";

export type QueryEntity = {
  name: string;
  kind: EntityKind;
  /** Product only: brand and leaf category from the graph. */
  brand?: string;
  category?: string;
  price?: number;
  currency?: string;
  rating?: number;
  reviewCount?: number;
  /** FAQ: answer snippet; topic: page type. */
  answer?: string;
  language?: QueryLanguage | null;
  /** Ranking hint (PageRank, review count…); higher = more important. */
  weight?: number;
};

export type QueryGeneratorInput = {
  site: { title: string; url: string };
  entities: QueryEntity[];
  /** Manually curated prompts (Site.targetKeywords) — kept first, never filtered for quality. */
  keywords?: string[];
  competitors?: string[];
  languages?: readonly QueryLanguage[];
  intents?: readonly QueryIntent[];
  /** Queries per intent per language in the final selection. */
  perIntent?: number;
  /** Add template-based conversational variants (Query Expansion). */
  expand?: boolean;
  /** Minimum quality (0–1) a generated query needs. */
  minQuality?: number;
  /** Similarity (0–1) at or above which two queries count as duplicates. */
  similarityThreshold?: number;
  now?: Date;
};

export type GeneratedQuery = {
  text: string;
  intent: QueryIntent;
  language: QueryLanguage;
  targets: { name: string; kind: EntityKind }[];
  /** True when the query names the site itself (answers will mention it by construction). */
  branded: boolean;
  source: "manual" | "template" | "faq" | "expansion" | "llm";
  templateId: string;
  difficulty: { score: number; level: Level };
  volume: { score: number; level: Level };
  quality: number;
  /** Overall opportunity rank used for selection (0–100). */
  score: number;
};

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

type Ctx = {
  e: QueryEntity;
  lang: QueryLanguage;
  year: number;
  site: string;
  /** Another entity of the same kind/category, or a competitor, for "A vs B" prompts. */
  rival?: string;
  /** Rounded price ceiling for "best X under Y" prompts (category only). */
  budget?: { amount: number; currency: string };
};
/**
 * One prompt template per language. The `tr` variants are deliberately Turkish: they are functional language
 * data (the prompts a Turkish-speaking user sends to an AI assistant, with Turkish case suffixes via `gen`/`abl`
 * and question particles via `q`), not UI text. They are generated only when the site targets Turkish (`lang: "tr"`).
 */
type Template = { id: string; intent: QueryIntent; kinds: EntityKind[]; tr?: (c: Ctx) => string | null; en?: (c: Ctx) => string | null };

// Turkish morphology helpers used by the `tr` templates: ablative ("-den"), genitive ("-in") and the question particle ("mi").
const abl = (s: string) => inflect(s, "ablative");
const gen = (s: string) => inflect(s, "genitive");
const q = (s: string) => questionParticle(s);
const fmtMoney = (b: { amount: number; currency: string }, lang: QueryLanguage) => {
  // Part of the generated prompt text (Turkish prompts write "15.000 TL", English ones "$15,000"), not UI formatting.
  const n = b.amount.toLocaleString(lang === "tr" ? "tr-TR" : "en-US");
  if (lang === "tr") return b.currency === "TRY" ? `${n} TL` : `${n} ${b.currency}`;
  return ({ USD: `$${n}`, EUR: `€${n}`, GBP: `£${n}` } as Record<string, string>)[b.currency] ?? `${n} ${b.currency}`;
};

export const TEMPLATES: Template[] = [
  // --- Informational -----------------------------------------------------------------------
  { id: "info.concept.what", intent: "informational", kinds: ["concept", "topic"],
    tr: ({ e }) => `${e.name} nedir ve nasıl çalışır?`, en: ({ e }) => `What is ${e.name} and how does it work?` },
  { id: "info.concept.use", intent: "informational", kinds: ["concept"],
    tr: ({ e }) => `${e.name} ne işe yarar, günlük hayatta nasıl kullanılır?`, en: ({ e }) => `What is ${e.name} used for and how do I use it in practice?` },
  { id: "info.category.choose", intent: "informational", kinds: ["category"],
    tr: ({ e }) => `${e.name} alırken nelere dikkat etmeliyim?`, en: ({ e }) => `What should I look for when buying ${e.name}?` },
  { id: "info.category.types", intent: "informational", kinds: ["category"],
    tr: ({ e }) => `${e.name} çeşitleri nelerdir ve aralarındaki farklar neler?`, en: ({ e }) => `What are the different types of ${e.name} and how do they differ?` },
  { id: "info.product.features", intent: "informational", kinds: ["product"],
    tr: ({ e }) => `${gen(e.name)} özellikleri nelerdir, kimler için uygundur?`, en: ({ e }) => `What are the key features of ${e.name} and who is it for?` },
  { id: "info.product.howto", intent: "informational", kinds: ["product"],
    tr: ({ e }) => `${e.name} nasıl kullanılır? Adım adım anlatır mısın?`, en: ({ e }) => `How do I use ${e.name}? Can you explain step by step?` },
  { id: "info.brand.about", intent: "informational", kinds: ["brand"],
    tr: ({ e }) => `${e.name} hangi ülkenin markası ve hangi ürünleriyle bilinir?`, en: ({ e }) => `Where is ${e.name} from and what products is it known for?` },

  // --- Comparative / commercial investigation ------------------------------------------------
  { id: "cmp.category.best", intent: "comparative", kinds: ["category"],
    tr: ({ e }) => `En iyi ${e.name} markaları hangileri?`, en: ({ e }) => `Which brands make the best ${e.name}?` },
  { id: "cmp.category.year", intent: "comparative", kinds: ["category"],
    tr: ({ e, year }) => `${year} yılında alınabilecek en iyi ${e.name} modelleri hangileri?`, en: ({ e, year }) => `What are the best ${e.name} to buy in ${year}?` },
  { id: "cmp.category.value", intent: "comparative", kinds: ["category"],
    tr: ({ e }) => `Fiyat/performans açısından en iyi ${e.name} hangisi?`, en: ({ e }) => `Which ${e.name} offer the best value for money?` },
  { id: "cmp.category.budget", intent: "comparative", kinds: ["category"],
    tr: ({ e, budget }) => budget ? `${fmtMoney(budget, "tr")} altı en iyi ${e.name} önerileri nelerdir?` : null,
    en: ({ e, budget }) => budget ? `What are the best ${e.name} under ${fmtMoney(budget, "en")}?` : null },
  { id: "cmp.product.alternatives", intent: "comparative", kinds: ["product", "brand", "site"],
    tr: ({ e }) => `${e.name} alternatifleri nelerdir?`, en: ({ e }) => `What are the best alternatives to ${e.name}?` },
  { id: "cmp.product.vs", intent: "comparative", kinds: ["product", "brand", "site"],
    tr: ({ e, rival }) => rival ? `${e.name} ${q(e.name)} ${rival} ${q(rival)}? Hangisi daha iyi?` : null,
    en: ({ e, rival }) => rival ? `${e.name} vs ${rival}: which one is better?` : null },
  { id: "cmp.product.worth", intent: "comparative", kinds: ["product"],
    tr: ({ e }) => `${e.name} almaya değer ${q("değer")}? Artıları ve eksileri neler?`, en: ({ e }) => `Is ${e.name} worth buying? What are the pros and cons?` },

  // --- Transactional -------------------------------------------------------------------------
  { id: "txn.product.where", intent: "transactional", kinds: ["product", "category"],
    tr: ({ e }) => `${e.name} nereden satın alınır?`, en: ({ e }) => `Where can I buy ${e.name}?` },
  { id: "txn.product.price", intent: "transactional", kinds: ["product"],
    tr: ({ e }) => `${e.name} en uygun fiyata nereden alınır?`, en: ({ e }) => `Where can I find the best price for ${e.name}?` },
  { id: "txn.product.deal", intent: "transactional", kinds: ["product", "site"],
    tr: ({ e }) => `${e.name} için indirim kodu veya kampanya var ${q("var")}?`, en: ({ e }) => `Are there any discount codes or deals for ${e.name}?` },
  { id: "txn.product.stock", intent: "transactional", kinds: ["product"],
    tr: ({ e }) => `${e.name} stokta var ${q("var")}, kargo kaç günde gelir?`, en: ({ e }) => `Is ${e.name} in stock and how fast is shipping?` },
  { id: "txn.category.online", intent: "transactional", kinds: ["category"],
    tr: ({ e }) => `Uygun fiyatlı ${e.name} hangi sitelerden güvenle alınır?`, en: ({ e }) => `Which online stores sell affordable ${e.name} with fast shipping?` },
  { id: "txn.brand.dealer", intent: "transactional", kinds: ["brand"],
    tr: ({ e }) => `${e.name} yetkili satıcıları hangileri?`, en: ({ e }) => `Who are the authorized ${e.name} retailers?` },
  { id: "txn.site.shipping", intent: "transactional", kinds: ["site"],
    tr: ({ e }) => `${e.name} kargo, iade ve değişim koşulları nelerdir?`, en: ({ e }) => `What are ${e.name}'s shipping and return policies?` },

  // --- Brand & reputation --------------------------------------------------------------------
  { id: "rep.site.trust", intent: "reputation", kinds: ["site", "brand"],
    tr: ({ e }) => `${e.name} güvenilir ${q("güvenilir")}?`, en: ({ e }) => `Is ${e.name} legit and trustworthy?` },
  { id: "rep.site.safe", intent: "reputation", kinds: ["site"],
    tr: ({ e }) => `${abl(e.name)} alışveriş yapmak güvenli ${q("güvenli")}?`, en: ({ e }) => `Is it safe to buy from ${e.name}?` },
  { id: "rep.brand.complaints", intent: "reputation", kinds: ["site", "brand"],
    tr: ({ e }) => `${e.name} şikayetleri ve kullanıcı yorumları neler söylüyor?`, en: ({ e }) => `What do customer reviews and complaints say about ${e.name}?` },
  { id: "rep.brand.quality", intent: "reputation", kinds: ["brand"],
    tr: ({ e }) => `${gen(e.name)} ürünleri kaliteli ${q("kaliteli")}?`, en: ({ e }) => `Are ${e.name} products good quality?` },
  { id: "rep.product.reviews", intent: "reputation", kinds: ["product"],
    tr: ({ e }) => `${e.name} kullanıcı yorumları: memnun kalanlar ne diyor?`, en: ({ e }) => `${e.name} user reviews: what do owners say?` },
  { id: "rep.product.problems", intent: "reputation", kinds: ["product"],
    tr: ({ e }) => `${gen(e.name)} kronik sorunları nelerdir?`, en: ({ e }) => `What are the common problems with ${e.name}?` },
];

/**
 * Conversational wrappers applied to template seeds (Query Expansion). `{q}` keeps the casing, `{lq}` lower-cases the first letter.
 * The `tr` wrappers are Turkish language data (e.g. "Türkiye'de …" = "In Turkey, …", "Bütçem sınırlı." = "My budget is
 * limited."), applied only to Turkish seeds; the `en` list is their English counterpart.
 */
const EXPANSIONS: Record<QueryLanguage, { id: string; intents: QueryIntent[]; kinds?: EntityKind[]; pattern: (year: number) => string }[]> = {
  tr: [
    { id: "exp.tr.market", intents: ["comparative", "transactional"], pattern: () => "Türkiye'de {lq}" },
    { id: "exp.tr.year", intents: ["comparative", "reputation"], pattern: (y) => `${y} itibarıyla {lq}` },
    { id: "exp.tr.beginner", intents: ["informational", "comparative"], pattern: () => "Bu konuda yeniyim, sade bir dille anlatır mısın: {lq}" },
    { id: "exp.tr.sources", intents: ["reputation", "informational"], pattern: () => "{q} Güvenilir kaynaklara dayanarak yanıtla." },
    { id: "exp.tr.budget", intents: ["transactional"], kinds: ["product", "category"], pattern: () => "Bütçem sınırlı. {q}" },
  ],
  en: [
    { id: "exp.en.year", intents: ["comparative", "reputation"], pattern: (y) => `As of ${y}, {lq}` },
    { id: "exp.en.beginner", intents: ["informational", "comparative"], pattern: () => "I'm new to this, so please keep it simple: {lq}" },
    { id: "exp.en.sources", intents: ["reputation", "informational"], pattern: () => "{q} Please cite reliable sources." },
    { id: "exp.en.budget", intents: ["transactional"], kinds: ["product", "category"], pattern: () => "I'm on a tight budget. {q}" },
  ],
};

// ---------------------------------------------------------------------------------------------
// Entity hygiene
// ---------------------------------------------------------------------------------------------

/**
 * Page/navigation labels that are not real entities and must never become query targets. English labels plus their
 * Turkish equivalents (anasayfa, ürünler, kategori, mağaza, iletişim, hakkımızda, sepet, giriş, indirim, sss …):
 * this set recognises generic headings crawled from Turkish storefronts, so it stays Turkish data.
 */
const GENERIC_NAMES = new Set([
  "home", "homepage", "anasayfa", "ana sayfa", "products", "product", "ürünler", "ürün", "category", "categories", "kategori",
  "kategoriler", "shop", "mağaza", "store", "blog", "contact", "iletişim", "about", "hakkımızda", "search", "arama", "cart", "sepet",
  "login", "giriş", "sale", "indirim", "faq", "sss", "all", "tümü", "other", "diğer", "new", "yeni",
]);

/** Cleans a crawled name (strips "… | Site" suffixes, whitespace) or returns null when unusable. */
export function cleanEntityName(raw: string, siteTitle = ""): string | null {
  let name = raw.replace(/\s+/g, " ").trim();
  if (!name || /^(https?:|www\.)|@|\{|\}|<|>/i.test(name)) return null;
  // "Barista Pro X | Acme" / "Kahve Makineleri - Acme" → drop the trailing site segment.
  const parts = name.split(/\s+[|–—·-]\s+/);
  if (parts.length > 1) {
    const site = foldTurkish(siteTitle);
    const kept = parts.filter((p) => !site || foldTurkish(p) !== site);
    name = (kept.length ? kept : parts)[0].trim();
  }
  name = name.replace(/[.,;:]+$/, "").trim();
  if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) return null;
  if (GENERIC_NAMES.has(trLower(name))) return null;
  if (name.split(" ").length > 9) return null; // a sentence, not a name
  return name;
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
const level = (n: number): Level => (n < 35 ? "low" : n < 65 ? "medium" : "high");
const tokens = (s: string) => s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));

const INTENT_BASE: Record<QueryIntent, { difficulty: number; volume: number }> = {
  informational: { difficulty: 45, volume: 60 },
  comparative: { difficulty: 70, volume: 65 },
  transactional: { difficulty: 60, volume: 50 },
  reputation: { difficulty: 35, volume: 35 },
};
const SPECIFICITY: Record<EntityKind, number> = { category: 15, concept: 10, topic: 0, faq: -5, brand: -5, competitor: -5, product: -15, site: -25 };
// "head" (broad, high-competition) terms in English and Turkish ("en iyi" = "best", "alternatif" = "alternative").
const HEAD_TERMS = /(?<!\p{L})(en iyi|best|top|alternatif|alternatives?|vs)(?!\p{L})/iu;

/**
 * Competition and relative volume heuristics (0–100). No keyword-volume API is involved:
 * generic head terms ("best X brands") are hard and frequent; long, specific, branded prompts are
 * easier and rarer.
 */
export function scoreQuery(text: string, intent: QueryIntent, kinds: EntityKind[], opts: { expanded?: boolean; branded?: boolean } = {}) {
  const base = INTENT_BASE[intent];
  const spec = kinds.length ? Math.max(...kinds.map((k) => SPECIFICITY[k])) : 0;
  const n = tokens(text).length;
  const head = HEAD_TERMS.test(text);
  let difficulty = base.difficulty + spec + (head ? 10 : 0) - Math.min(20, Math.max(0, n - 5) * 2);
  let volume = base.volume + spec - Math.min(30, Math.max(0, n - 4) * 3) + (head ? 5 : 0);
  if (opts.expanded) { difficulty -= 5; volume -= 10; }
  if (opts.branded) { difficulty -= 10; volume -= 5; }
  difficulty = clamp(difficulty); volume = clamp(volume);
  return { difficulty: { score: difficulty, level: level(difficulty) }, volume: { score: volume, level: level(volume) } };
}

/**
 * Idiomatic Turkish doublings ("adım adım" = "step by step", "yavaş yavaş" = "slowly") are not stutters.
 * Folded (ASCII) forms, matched against `foldTurkish` output.
 */
const REDUPLICATION = new Set(["adim", "yavas", "teker", "tek", "gun", "sik", "ara", "kat", "parca", "yer", "cesit", "bol", "tane", "sira"]);

/** 0–1 heuristic quality: rejects malformed prompts, penalises awkward ones. */
export function queryQuality(text: string, targets: string[] = []): number {
  const t = text.trim();
  if (t.length < 12 || t.length > 260 || /[{}<>]|https?:\/\/|undefined|null|NaN/.test(t)) return 0;
  const words = tokens(t);
  if (words.length < 3) return 0;
  let score = 1;
  const lower = words.map((w) => foldTurkish(w).replace(/[^\p{L}\p{N}]/gu, ""));
  for (let i = 1; i < lower.length; i++) if (lower[i] && lower[i] === lower[i - 1] && !REDUPLICATION.has(lower[i])) score -= 0.35; // "makine makine"
  if (targets.some((n) => n.length > 50)) score -= 0.25;
  if (targets.some((n) => n.length > 8 && n === n.toLocaleUpperCase("tr-TR") && /\p{L}{4}/u.test(n))) score -= 0.1; // SHOUTED names
  if (words.length > 30) score -= 0.2;
  if (!/[?.!:]$/.test(t)) score -= 0.05;
  return Math.max(0, Math.round(score * 100) / 100);
}

// ---------------------------------------------------------------------------------------------
// Semantic duplicate filter
// ---------------------------------------------------------------------------------------------

const STOP = new Set([
  // tr — Turkish stop words (functional language data: the fingerprint must ignore them in Turkish prompts)
  "ve", "ile", "bir", "için", "icin", "mi", "mı", "mu", "mü", "ne", "neler", "nedir", "nelerdir", "hangi", "hangisi", "hangileri", "bu", "de", "da", "çok", "cok", "daha", "nasıl", "nasil",
  // en — English stop words
  "the", "a", "an", "of", "for", "to", "is", "are", "and", "what", "which", "how", "in", "on", "with", "do", "does", "can", "i", "my", "me", "it", "its",
]);

/** Folded, stop-word-free, crudely stemmed tokens (5-char prefixes suit Turkish agglutination). */
export function queryFingerprint(text: string): string[] {
  return foldTurkish(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => w.slice(0, 5));
}

function trigrams(s: string): Set<string> {
  const t = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}
function overlap(a: Set<string>, b: Set<string>, dice: boolean) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return dice ? (2 * inter) / (a.size + b.size) : inter / (a.size + b.size - inter);
}

type Fp = { stems: Set<string>; grams: Set<string> };
const fingerprint = (text: string): Fp => {
  const stems = queryFingerprint(text);
  return { stems: new Set(stems), grams: trigrams(stems.join(" ")) };
};
const similarityFp = (a: Fp, b: Fp) => 0.5 * overlap(a.stems, b.stems, false) + 0.5 * overlap(a.grams, b.grams, true);

/** Semantic-ish similarity of two queries in [0, 1] (token Jaccard + trigram Dice on folded stems). */
export function querySimilarity(a: string, b: string): number {
  return similarityFp(fingerprint(a), fingerprint(b));
}

/** Greedy filter: keeps the best-scored query of each near-duplicate cluster. */
export function dedupeQueries<T extends { text: string; language: string; score: number }>(items: T[], threshold = 0.8): T[] {
  const kept: { item: T; fp: Fp }[] = [];
  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const fp = fingerprint(item.text);
    if (kept.some((k) => k.item.language === item.language && similarityFp(k.fp, fp) >= threshold)) continue;
    kept.push({ item, fp });
  }
  return kept.map((k) => k.item);
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

function niceCeiling(n: number) {
  const mag = 10 ** Math.floor(Math.log10(n));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((s) => s * mag >= n) ?? 10;
  return step * mag;
}

function categoryBudgets(entities: QueryEntity[]) {
  const byCat = new Map<string, { prices: number[]; currency: string }>();
  for (const e of entities) {
    if (e.kind !== "product" || !e.category || !e.price || e.price <= 0 || !e.currency) continue;
    const row = byCat.get(e.category) ?? { prices: [], currency: e.currency };
    if (row.currency === e.currency) row.prices.push(e.price);
    byCat.set(e.category, row);
  }
  const out = new Map<string, { amount: number; currency: string }>();
  for (const [cat, { prices, currency }] of byCat) {
    if (prices.length < 2) continue;
    prices.sort((a, b) => a - b);
    out.set(cat, { amount: niceCeiling(prices[Math.floor(prices.length / 2)]), currency });
  }
  return out;
}

const COMMON_KINDS = new Set<EntityKind>(["category", "concept", "topic"]);

/** "Kahve Makineleri" → "kahve makineleri" for mid-sentence use; keeps acronyms, camelCase and brand words. */
export function asCommonNoun(name: string, properNames: string[] = []): string {
  const words = name.split(" ");
  if (!words.every((w) => /^\p{Lu}[\p{Ll}'’-]*$/u.test(w) || !/\p{Lu}/u.test(w))) return name; // "iPhone Kılıfları", "USB Kablolar"
  const proper = new Set(properNames.flatMap((n) => n.split(/\s+/)));
  const tr = /[çğışöüÇĞİŞÖÜ]/.test(name); // Turkish letters => lower-case with Turkish rules (İ→i, I→ı)
  return words.map((w) => (proper.has(foldTurkish(w)) ? w : tr ? trLower(w) : w.toLowerCase())).join(" ");
}

/** Capitalises a sentence that starts with a lower-cased common noun; leaves "iPhone", "eBay" alone. */
function upperFirst(text: string, lang: QueryLanguage) {
  const first = text.split(" ")[0] ?? "";
  if (/\p{Lu}/u.test(first)) return text;
  return text.charAt(0).toLocaleUpperCase(lang === "tr" ? "tr-TR" : "en-US") + text.slice(1);
}

function lowerFirst(text: string, keepNames: string[]) {
  const first = text.split(/\s+/)[0] ?? "";
  if (keepNames.some((n) => text.startsWith(n))) return text;
  if (/^\p{Lu}{2,}/u.test(first)) return text; // acronym
  // Turkish letters => Turkish case rules (İ→i, I→ı); `"tr-TR"` here is text processing, not UI formatting.
  return text.charAt(0).toLocaleLowerCase(/[çğıöşüİ]/.test(text) ? "tr-TR" : "en-US") + text.slice(1);
}

function finalize(
  text: string, intent: QueryIntent, language: QueryLanguage, targets: QueryEntity[], source: GeneratedQuery["source"],
  templateId: string, siteTitle: string,
): GeneratedQuery {
  const spaced = text.replace(/\s+/g, " ").replace(/\s+([?.!,:])/g, "$1").trim();
  const clean = source === "template" || source === "expansion" ? upperFirst(spaced, language) : spaced;
  const kinds = targets.map((t) => t.kind);
  const branded = kinds.includes("site") || (!!siteTitle && foldTurkish(clean).includes(foldTurkish(siteTitle)));
  const expanded = source === "expansion" || source === "llm";
  const { difficulty, volume } = scoreQuery(clean, intent, kinds, { expanded, branded });
  const quality = source === "manual" ? 1 : queryQuality(clean, targets.map((t) => t.name));
  const score = clamp(quality * 40 + volume.score * 0.35 + (100 - difficulty.score) * 0.25);
  return { text: clean, intent, language, targets: targets.map((t) => ({ name: t.name, kind: t.kind })), branded, source, templateId, difficulty, volume, quality, score };
}

const KIND_CAPS: Partial<Record<EntityKind, number>> = { product: 15, category: 10, brand: 8, concept: 8, faq: 20, topic: 8, competitor: 5 };

/**
 * Infers an intent for free text (FAQ questions, manual keywords, LLM output). The text is Turkish-folded to ASCII first,
 * so the patterns list the folded Turkish keywords next to their English equivalents (guvenilir = reliable, sikayet =
 * complaint, yorum = review, satin al = buy, fiyat = price, indirim = discount, kargo = shipping, iade = return,
 * en iyi = best, alternatif = alternative, karsilastir = compare, oneri/tavsiye = recommendation …).
 */
export function classifyIntent(text: string): QueryIntent {
  const t = foldTurkish(text);
  const has = (re: RegExp) => re.test(t);
  if (has(/(guvenilir|guvenli mi|sikayet|yorum|kronik|sorun|dolandir|legit|scam|trust|reliab|review|complain|problem|reputation)/)) return "reputation";
  if (has(/(satin al|nereden al|fiyat|indirim|kampanya|kupon|kargo|stok|siparis|iade|yetkili satici|buy|price|discount|coupon|deal|shipping|in stock|order|retailer|cheap)/)) return "transactional";
  if (has(/(en iyi|alternatif|karsilastir|hangisi|oneri|tavsiye|recommend|mi .* mi|\bvs\b|versus|kiyas|best|top \d|alternative|compare|comparison|better|worth)/)) return "comparative";
  return "informational";
}

/**
 * Deterministic multi-intent query generation. Returns a selection balanced across the requested
 * intents and languages (`perIntent` each), manual keywords first.
 */
export function generateQueries(input: QueryGeneratorInput): GeneratedQuery[] {
  const languages = input.languages?.length ? [...new Set(input.languages)] : [...QUERY_LANGUAGES];
  const intents = input.intents?.length ? [...new Set(input.intents)] : [...QUERY_INTENTS];
  const perIntent = input.perIntent ?? 5;
  const minQuality = input.minQuality ?? 0.6;
  const threshold = input.similarityThreshold ?? 0.8;
  const year = (input.now ?? new Date()).getFullYear();
  const siteTitle = cleanEntityName(input.site.title) ?? input.site.title.trim();

  // Entities: clean, de-duplicate by folded name, cap per kind by weight.
  const seen = new Set<string>();
  const counts = new Map<EntityKind, number>();
  const entities: QueryEntity[] = [];
  const pool = [...input.entities].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.name.localeCompare(b.name));
  for (const raw of pool) {
    const name = raw.kind === "faq" ? raw.name.replace(/\s+/g, " ").trim() : cleanEntityName(raw.name, siteTitle);
    if (!name || name.length > 240) continue;
    const key = `${raw.kind}:${foldTurkish(name)}`;
    if (seen.has(key) || (raw.kind !== "site" && foldTurkish(name) === foldTurkish(siteTitle))) continue;
    const n = counts.get(raw.kind) ?? 0;
    if (n >= (KIND_CAPS[raw.kind] ?? 20)) continue;
    seen.add(key); counts.set(raw.kind, n + 1);
    entities.push({ ...raw, name });
  }
  if (siteTitle) entities.push({ name: siteTitle, kind: "site" });
  const competitors = [...new Set((input.competitors ?? []).map((c) => cleanEntityName(c)).filter((c): c is string => !!c))].slice(0, 5);
  const budgets = categoryBudgets(entities);

  const rivalFor = (e: QueryEntity, i: number): string | undefined => {
    if (e.kind === "product") {
      const peers = entities.filter((p) => p.kind === "product" && p.name !== e.name && (!e.category || p.category === e.category));
      return peers.length ? peers[i % peers.length].name : undefined;
    }
    if (e.kind === "brand") {
      const peers = entities.filter((p) => p.kind === "brand" && p.name !== e.name).map((p) => p.name);
      const list = peers.length ? peers : competitors;
      return list.length ? list[i % list.length] : undefined;
    }
    if (e.kind === "site") return competitors.length ? competitors[i % competitors.length] : undefined;
    return undefined;
  };

  const candidates: GeneratedQuery[] = [];
  const add = (g: GeneratedQuery) => {
    if (g.source !== "manual" && g.quality < minQuality) return;
    if (!languages.includes(g.language) || !intents.includes(g.intent)) return;
    candidates.push(g);
  };

  // FAQ questions and question-like headings are real user phrasings — keep them verbatim.
  for (const e of entities) {
    if (e.kind !== "faq" && !(e.kind === "topic" && /\?$/.test(e.name))) continue;
    const lang = e.language ?? detectLanguage(e.name);
    if (!lang) continue;
    add(finalize(e.name.endsWith("?") ? e.name : `${e.name}?`, classifyIntent(e.name), lang, [e], "faq", "faq.verbatim", siteTitle));
  }

  const properNames = entities.filter((e) => e.kind === "brand" || e.kind === "site").map((e) => foldTurkish(e.name));
  entities.forEach((e, i) => {
    if (e.kind === "faq") return;
    if (e.kind === "topic" && /\?$/.test(e.name)) return;
    const common = COMMON_KINDS.has(e.kind);
    const nameLang = common ? guessNameLanguage(e.name) : null;
    const display = common ? { ...e, name: asCommonNoun(e.name, properNames) } : e;
    for (const tpl of TEMPLATES) {
      if (!tpl.kinds.includes(e.kind)) continue;
      for (const lang of languages) {
        const build = tpl[lang];
        if (!build) continue;
        if (nameLang && nameLang !== lang) continue; // "best Kahve Makineleri brands" helps nobody
        const rival = tpl.id.endsWith(".vs") ? rivalFor(e, i) : undefined;
        const budget = e.kind === "category" ? budgets.get(e.name) : undefined;
        const text = build({ e: display, lang, year, site: siteTitle, rival, budget });
        if (!text) continue;
        const targets = rival ? [e, { name: rival, kind: (competitors.includes(rival) ? "competitor" : e.kind) as EntityKind }] : [e];
        add(finalize(text, tpl.intent, lang, targets, "template", tpl.id, siteTitle));
      }
    }
  });

  // Query expansion: conversational variants of the strongest seeds of each intent/language.
  if (input.expand !== false) {
    const seeds = [...candidates].filter((c) => c.source === "template").sort((a, b) => b.score - a.score);
    const used = new Map<string, number>();
    for (const seed of seeds) {
      const slot = `${seed.intent}:${seed.language}`;
      const n = used.get(slot) ?? 0;
      if (n >= perIntent) continue;
      used.set(slot, n + 1);
      const kind = seed.targets[0]?.kind;
      const exp = EXPANSIONS[seed.language].filter((x) => x.intents.includes(seed.intent) && (!x.kinds || (kind && x.kinds.includes(kind))));
      if (!exp.length) continue;
      const x = exp[n % exp.length];
      const names = seed.targets.filter((t) => !COMMON_KINDS.has(t.kind)).map((t) => t.name);
      const text = x.pattern(year).replace("{q}", () => seed.text).replace("{lq}", () => lowerFirst(seed.text, names));
      add(finalize(text, seed.intent, seed.language, seed.targets.map((t) => ({ name: t.name, kind: t.kind })), "expansion", x.id, siteTitle));
    }
  }

  return selectBalanced(manualQueries(input.keywords ?? [], languages, siteTitle), dedupeQueries(candidates, threshold), { intents, languages, perIntent });
}

function manualQueries(keywords: string[], languages: QueryLanguage[], siteTitle: string) {
  const out: GeneratedQuery[] = [];
  const seen = new Set<string>();
  for (const k of keywords) {
    const text = k.replace(/\s+/g, " ").trim();
    if (!text || text.length > 500 || seen.has(text)) continue;
    seen.add(text);
    out.push(finalize(text, classifyIntent(text), detectLanguage(text) ?? languages[0], [], "manual", "manual", siteTitle));
  }
  return out;
}

/** Round-robin by intent × language; avoids repeating a target entity inside an intent while alternatives exist. */
function selectBalanced(manual: GeneratedQuery[], pool: GeneratedQuery[], o: { intents: QueryIntent[]; languages: QueryLanguage[]; perIntent: number }) {
  const manualKeys = new Set(manual.map((m) => m.text));
  const buckets = new Map<string, GeneratedQuery[]>();
  for (const g of pool) {
    if (manualKeys.has(g.text)) continue;
    const key = `${g.intent}:${g.language}`;
    buckets.set(key, [...(buckets.get(key) ?? []), g]);
  }
  const picked = new Map<string, GeneratedQuery[]>();
  for (const [key, list] of buckets) {
    list.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
    const chosen: GeneratedQuery[] = [];
    const usedTargets = new Set<string>();
    const target = (g: GeneratedQuery) => g.targets[0]?.name ?? g.text;
    for (const g of list) if (chosen.length < o.perIntent && !usedTargets.has(target(g))) { chosen.push(g); usedTargets.add(target(g)); }
    for (const g of list) if (chosen.length < o.perIntent && !chosen.includes(g)) chosen.push(g);
    // Keep at least one long conversational prompt per bucket — that is how people talk to AI search.
    const conversational = list.find((g) => g.source === "expansion" || g.source === "llm");
    if (o.perIntent >= 3 && conversational && !chosen.some((g) => g.source === "expansion" || g.source === "llm")) chosen[chosen.length - 1] = conversational;
    picked.set(key, chosen);
  }
  const out = [...manual];
  for (let i = 0; i < o.perIntent; i++) {
    for (const lang of o.languages) for (const intent of o.intents) {
      const g = picked.get(`${intent}:${lang}`)?.[i];
      if (g) out.push(g);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Optional LLM expansion
// ---------------------------------------------------------------------------------------------

/** Any text-completion function (OpenAI, Anthropic, local model…). Must not use web search. */
export type CompletionFn = (prompt: string) => Promise<string>;

/**
 * Asks a model for natural rephrasings of the given seeds and returns them labelled, scored and
 * de-duplicated against the seeds. Failures of the completion function are swallowed per seed.
 */
export async function expandWithLlm(seeds: GeneratedQuery[], complete: CompletionFn, opts: { variants?: number; siteTitle?: string; threshold?: number } = {}) {
  const variants = Math.min(5, Math.max(1, opts.variants ?? 3));
  const out: GeneratedQuery[] = [];
  for (const seed of seeds) {
    // The seed's language selects the instruction, so the model rewrites in that same language: the Turkish
    // prompt asks for natural Turkish questions, the English one for natural English questions. Replies in
    // another language are discarded below (`detectLanguage`).
    const prompt = seed.language === "tr"
      ? `Aşağıdaki arama sorusunu, bir kullanıcının yapay zeka asistanına yazacağı gibi ${variants} farklı doğal Türkçe soruya dönüştür. Anlamı ve niyeti koru, yeni marka ekleme. Her satıra bir soru yaz, numara kullanma.\n\nSoru: ${seed.text}`
      : `Rewrite the search question below as ${variants} different natural questions a user would type into an AI assistant. Keep the meaning and intent, do not add new brands. One question per line, no numbering.\n\nQuestion: ${seed.text}`;
    let reply: string;
    try { reply = await complete(prompt); } catch { continue; }
    const lines = reply.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“]|["”]$/g, "").trim()).filter(Boolean).slice(0, variants);
    for (const line of lines) {
      if (detectLanguage(line) && detectLanguage(line) !== seed.language) continue;
      const g = finalize(line, seed.intent, seed.language, seed.targets, "llm", "llm.rephrase", opts.siteTitle ?? "");
      if (g.quality >= 0.6) out.push(g);
    }
  }
  const all = dedupeQueries([...seeds.map((s) => ({ ...s, score: s.score + 1000 })), ...out], opts.threshold ?? 0.8);
  return all.filter((g) => g.source === "llm");
}

// ---------------------------------------------------------------------------------------------
// Database loader
// ---------------------------------------------------------------------------------------------

export const queryGeneratorOptions = z.object({
  languages: z.array(z.enum(QUERY_LANGUAGES)).min(1).max(2).optional(),
  intents: z.array(z.enum(QUERY_INTENTS)).min(1).max(4).optional(),
  perIntent: z.coerce.number().int().min(1).max(20).optional(),
  expand: z.boolean().optional(),
});
export type QueryGeneratorOptions = z.infer<typeof queryGeneratorOptions> & { now?: Date };

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Site locale → default languages: "tr*" → tr, "en*" → en, otherwise both. */
export function languagesForLocale(locale: unknown): QueryLanguage[] {
  const l = typeof locale === "string" ? locale.slice(0, 2).toLowerCase() : "";
  return l === "tr" ? ["tr"] : l === "en" ? ["en"] : ["tr", "en"];
}

const KIND_BY_TYPE: Record<string, EntityKind> = { Product: "product", Category: "category", Brand: "brand", Concept: "concept", FAQ: "faq" };

/** Loads the site's graph, crawled headings, keywords and competitors and generates queries. */
export async function generateSiteQueries(siteId: string, options: QueryGeneratorOptions = {}) {
  const site = await getSiteOrThrow(siteId);
  const settings = asObj(site.settings);
  const [rows, relations, pages] = await Promise.all([
    prisma.graphEntity.findMany({
      where: { siteId, entityType: { in: Object.keys(KIND_BY_TYPE) } },
      orderBy: { key: "asc" }, take: 400, select: { id: true, name: true, entityType: true, properties: true },
    }),
    prisma.graphRelation.findMany({
      where: { siteId, relationType: { in: ["has_brand", "has_category"] }, source: { entityType: "Product" } },
      select: { sourceId: true, relationType: true, target: { select: { name: true } } }, take: 2000,
    }),
    prisma.crawledPage.findMany({
      where: { siteId, pageType: { in: ["article", "faq", "category"] }, statusCode: { lt: 400 } },
      orderBy: { depth: "asc" }, take: 40, select: { h1: true, title: true, pageType: true },
    }),
  ]);
  const brandOf = new Map<string, string>(); const categoryOf = new Map<string, string>();
  for (const r of relations) (r.relationType === "has_brand" ? brandOf : categoryOf).set(r.sourceId, r.target.name);

  const entities: QueryEntity[] = rows.map((row) => {
    const p = asObj(row.properties);
    return {
      name: row.name, kind: KIND_BY_TYPE[row.entityType],
      brand: brandOf.get(row.id), category: categoryOf.get(row.id),
      price: num(p.price), currency: str(p.currency), rating: num(p.rating), reviewCount: num(p.review_count),
      answer: str(p.answer),
      weight: (num(p.pagerank) ?? 0) * 1000 + (num(p.review_count) ?? 0) + (num(p.rating) ?? 0),
    };
  });
  for (const page of pages) {
    const heading = page.h1 ?? page.title;
    if (!heading) continue;
    // Category pages already exist as Category entities; their headings only help when no graph data exists.
    if (page.pageType === "category" && rows.some((r) => r.entityType === "Category")) continue;
    entities.push({ name: heading, kind: page.pageType === "category" ? "category" : "topic" });
  }

  const parsed = visibilityAnalysisSettings.safeParse(settings.visibilityAnalysis ?? {});
  const competitors = parsed.success ? parsed.data.competitors.map((c) => c.title) : [];
  const keywords = Array.isArray(site.targetKeywords) ? site.targetKeywords.filter((k): k is string => typeof k === "string") : [];
  return generateQueries({
    site: { title: site.title, url: site.url }, entities, keywords, competitors,
    languages: options.languages ?? languagesForLocale(settings.locale),
    intents: options.intents, perIntent: options.perIntent, expand: options.expand, now: options.now,
  });
}
