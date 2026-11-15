// Wikidata entity reconciliation — review queue, manual verification and re-query for GraphEntity rows.
// The crawler (services/crawler geo_crawler/wikidata.py) does the bulk matching; this module lets a user
// inspect the result, pin or reject a QID, or search again. Scoring constants mirror the Python module.
//
// GraphEntity.properties written here and by the crawler:
//   wikidataId, wikidataUrl, wikipediaUrl, sameAs[], confidence (0-1), alumniOf/knowsAbout/hasCredential (Person),
//   reconciliation { status, method, confidence, candidates[], lang, rejectedQids[], verifiedAt, ... }
// status: pending | matched | declared | review | unmatched | error | verified | rejected
// Manual decisions (verified / rejected) survive re-crawls: see preserveManualReconciliation().
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { HttpError, notFound } from "../http";
import { buildJsonLd, validateJsonLd } from "../jsonld";
import { getSiteOrThrow } from "./sites";

export const RECONCILABLE_TYPES = ["Organization", "Brand", "Person", "Product", "Concept"] as const;
export const RECONCILIATION_STATUSES = [
  "pending", "matched", "declared", "review", "unmatched", "error", "verified", "rejected",
] as const;
type ReconcilableType = (typeof RECONCILABLE_TYPES)[number];
type Json = Record<string, unknown>;

export const AUTO_ACCEPT = 0.8;
export const REVIEW = 0.55;
export const PERSON_UNCORROBORATED_CAP = 0.7;
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const USER_AGENT = "ai-visibility/0.1 (+https://github.com/kobeumut/ai-visibility)";
const MANUAL = new Set(["verified", "rejected"]);
/** Properties owned by reconciliation (carried over from a manual decision on re-crawl). */
const RECONCILIATION_KEYS = [
  "wikidataId", "wikidataUrl", "wikipediaUrl", "sameAs", "confidence", "reconciliation",
  "alumniOf", "knowsAbout", "hasCredential", "employerWikidataIds",
] as const;

const ORG = ["Q43229", "Q4830453", "Q783794", "Q891723", "Q6881511", "Q167037", "Q1589009", "Q2085381", "Q507619"];
const ACCEPTED: Partial<Record<ReconcilableType, Set<string>>> = {
  Organization: new Set(ORG),
  Brand: new Set(["Q431289", "Q167270", ...ORG]),
  Person: new Set(["Q5"]),
  Product: new Set(["Q2424752", "Q15401930", "Q2897903", "Q1183543", "Q7397", "Q11019", "Q10273457", "Q431289"]),
};
const REJECTED = new Set([
  "Q4167410", "Q22808320", "Q13406463", "Q4167836", "Q11266439", "Q101352", "Q202444", "Q12308941", "Q11879590",
]);
const SAME_AS_PROPS: [string, string][] = [
  ["P4264", "https://www.linkedin.com/company/{}"],
  ["P6634", "https://www.linkedin.com/in/{}"],
  ["P2088", "https://www.crunchbase.com/organization/{}"],
  ["P2087", "https://www.crunchbase.com/person/{}"],
  ["P2002", "https://x.com/{}"],
  ["P2013", "https://www.facebook.com/{}"],
  ["P2003", "https://www.instagram.com/{}/"],
  ["P2397", "https://www.youtube.com/channel/{}"],
  ["P2037", "https://github.com/{}"],
  ["P496", "https://orcid.org/{}"],
  ["P214", "https://viaf.org/viaf/{}"],
];
const CLAIM_PROPS = ["P31", "P856", "P69", "P101", "P106", "P108", "P512", ...SAME_AS_PROPS.map(([p]) => p)];

// ---------------------------------------------------------------- text helpers

// Turkish (and a few accented Latin) letters folded to ASCII so "Arçelik" matches "Arcelik" when reconciling entity names:
// language data for Turkish names, not UI text.
const TR_FOLD: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u", â: "a", î: "i", û: "u" };
const LEGAL_SUFFIX = /\b(a\.?\s?s|ltd|sti|san|tic|ve|inc|llc|gmbh|corp|corporation|co|company|plc|ag|sa|srl|bv|limited|holding)\b\.?/g;
// Name-matching stop words: English ("the", "and", "of" …) plus the Turkish conjunction/particles "ve" (and), "ile" (with),
// "bir" (a), "icin" (for), "de"/"da" (also).
const STOP = new Set(["the", "and", "of", "a", "an", "ve", "ile", "bir", "icin", "for", "in", "de", "da"]);

export function fold(text: string): string {
  return String(text)
    .replace(/[çğıöşüÇĞİÖŞÜâîû]/g, (c) => TR_FOLD[c])
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
export function normalizeName(name: string): string {
  const folded = fold(name);
  return folded.replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim() || folded;
}
const tokens = (text: string) => new Set(fold(text).split(" ").filter((t) => t.length > 2 && !STOP.has(t)));
const hostOf = (url: unknown) => {
  if (typeof url !== "string" || !url) return "";
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
export const wikidataUrl = (qid: string) => `https://www.wikidata.org/wiki/${qid}`;
const qidFromUrl = (v: unknown) => (typeof v === "string" ? /wikidata\.org\/(?:wiki|entity)\/(Q\d+)\b/.exec(v)?.[1] : undefined);

/** difflib.SequenceMatcher.ratio (Ratcliff/Obershelp) — same numbers as the Python matcher for short names. */
function ratio(a: string, b: string): number {
  const matches = (a1: number, a2: number, b1: number, b2: number): number => {
    let best = 0, bi = 0, bj = 0;
    for (let i = a1; i < a2; i++) {
      for (let j = b1; j < b2; j++) {
        let k = 0;
        while (i + k < a2 && j + k < b2 && a[i + k] === b[j + k]) k++;
        if (k > best) [best, bi, bj] = [k, i, j];
      }
    }
    return best ? best + matches(a1, bi, b1, bj) + matches(bi + best, a2, bj + best, b2) : 0;
  };
  return a.length + b.length ? (2 * matches(0, a.length, 0, b.length)) / (a.length + b.length) : 1;
}

export function nameSimilarity(query: string, names: string[]): number {
  const q = normalizeName(query);
  if (!q) return 0;
  const qt = new Set(q.split(" "));
  let best = 0;
  for (const n of names) {
    const c = normalizeName(n);
    if (!c) continue;
    if (c === q) return 1;
    let r = ratio(q, c) * 0.9;
    const ct = new Set(c.split(" "));
    const shared = [...qt].filter((t) => ct.has(t)).length;
    if (shared && (shared === qt.size || shared === ct.size)) r = Math.max(r, (0.85 * shared) / Math.max(qt.size, ct.size) + 0.15);
    best = Math.max(best, r);
  }
  return Math.round(Math.min(best, 1) * 1e4) / 1e4;
}

// ---------------------------------------------------------------- Wikidata access

/** GET with Wikimedia-compliant User-Agent, 15s timeout and a 2 MB body cap. */
async function getJson(url: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Json> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const signal = AbortSignal.timeout(15_000);
  try {
    const res = await fetch(u, { headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers }, signal, redirect: "error" });
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(502, `Wikidata request failed (${res.status})`);
    }
    const text = await res.text();
    if (text.length > 2_000_000) throw new HttpError(502, "Wikidata response too large");
    return JSON.parse(text) as Json;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, signal.aborted ? "Wikidata request timed out" : "Wikidata request failed");
  }
}

type Candidate = {
  qid: string; label: string; description: string; aliases: string[]; instanceOf: string[]; websites: string[];
  sitelinks: Record<string, string>; claims: Record<string, string[]>; rank: number;
  score: number; signals: Record<string, number>;
};

const langValue = (d: unknown, lang: string): string => {
  const o = (d ?? {}) as Record<string, { value?: string }>;
  for (const k of [lang, "en", ...Object.keys(o)]) if (o[k]?.value) return o[k].value!;
  return "";
};

function candidateFrom(ent: Json, lang: string, rank = 0): Candidate {
  const claimsRaw = (ent.claims ?? {}) as Record<string, { rank?: string; mainsnak?: { datavalue?: { value?: unknown } } }[]>;
  const claims: Record<string, string[]> = {};
  for (const p of CLAIM_PROPS) {
    const values = (claimsRaw[p] ?? []).filter((c) => c.rank !== "deprecated").map((c) => {
      const v = c.mainsnak?.datavalue?.value;
      return typeof v === "object" && v ? String((v as Json).id ?? (v as Json).text ?? "") : String(v ?? "");
    }).filter(Boolean);
    if (values.length) claims[p] = values;
  }
  const aliasesRaw = (ent.aliases ?? {}) as Record<string, { value: string }[]>;
  const sitelinks: Record<string, string> = {};
  for (const [k, v] of Object.entries((ent.sitelinks ?? {}) as Record<string, { title?: string; url?: string }>)) {
    if (!k.endsWith("wiki") || k === "commonswiki" || k === "specieswiki") continue;
    sitelinks[k] = v.url ?? `https://${k.slice(0, -4)}.wikipedia.org/wiki/${encodeURIComponent((v.title ?? "").replace(/ /g, "_"))}`;
  }
  return {
    qid: String(ent.id), label: langValue(ent.labels, lang), description: langValue(ent.descriptions, lang),
    aliases: [...(aliasesRaw[lang] ?? []), ...(aliasesRaw.en ?? [])].map((a) => a.value).filter(Boolean),
    instanceOf: claims.P31 ?? [], websites: claims.P856 ?? [], sitelinks, claims, rank, score: 0, signals: {},
  };
}

async function getEntities(qids: string[], langs: string[], props = "labels|aliases|descriptions|claims|sitelinks/urls") {
  const ids = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))];
  const out: Record<string, Json> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const data = await getJson(WIKIDATA_API, {
      action: "wbgetentities", ids: ids.slice(i, i + 50).join("|"), props, languages: [...new Set(langs)].join("|"), format: "json",
    });
    for (const [q, e] of Object.entries((data.entities ?? {}) as Record<string, Json>)) if (!("missing" in e)) out[String(e.id ?? q)] = e;
  }
  return out;
}

async function instancesWithin(qids: string[], classes: Set<string>): Promise<Set<string>> {
  if (!qids.length || !classes.size) return new Set();
  const query = `SELECT DISTINCT ?item WHERE { VALUES ?item { ${qids.map((q) => `wd:${q}`).join(" ")} } ` +
    `VALUES ?cls { ${[...classes].map((c) => `wd:${c}`).join(" ")} } ?item wdt:P31/wdt:P279* ?cls . }`;
  try {
    const data = await getJson(WIKIDATA_SPARQL, { query, format: "json" }, { accept: "application/sparql-results+json" });
    const rows = ((data.results as Json)?.bindings ?? []) as { item?: { value?: string } }[];
    return new Set(rows.map((r) => qidFromUrl(r.item?.value)).filter((q): q is string => !!q));
  } catch {
    return new Set(); // overloaded endpoint — fall back to direct P31
  }
}

type MatchContext = {
  name: string; type: ReconcilableType; lang: string; siteHost: string; url?: string;
  contextTerms: Set<string>; orgQids: Set<string>;
};

export function scoreCandidate(ctx: MatchContext, c: Candidate, sparql = new Set<string>()): number {
  const name = nameSimilarity(ctx.name, [c.label, ...c.aliases]);
  const p31 = new Set(c.instanceOf);
  const accepted = ACCEPTED[ctx.type];
  const has = (s: Set<string>) => [...p31].some((q) => s.has(q));
  let type: number;
  if (has(REJECTED) || (ctx.type === "Person" && p31.size && !p31.has("Q5"))) type = 0;
  else if (ctx.type !== "Person" && p31.has("Q5")) type = 0;
  else if (!accepted) type = 0.8;
  else if (has(accepted) || sparql.has(c.qid)) type = 1;
  else type = 0.4;
  const overlap = [...tokens(`${c.description} ${c.label}`)].filter((t) => ctx.contextTerms.has(t)).length;
  const employer = (c.claims.P108 ?? []).some((q) => ctx.orgQids.has(q));
  const context = employer ? 1 : Math.min(1, overlap / 2);
  let website = !!ctx.siteHost && c.websites.some((w) => hostOf(w) === ctx.siteHost || hostOf(w).endsWith(`.${ctx.siteHost}`));
  if (ctx.url && !website) website = c.websites.some((w) => hostOf(w) === hostOf(ctx.url));
  const rank = Math.max(0, 1 - 0.25 * c.rank);
  let conf = 0.5 * name + 0.25 * type + 0.15 * context + 0.1 * rank;
  if (type === 0) conf *= 0.3;
  else if (website && name >= 0.6) conf = Math.max(conf, 0.97);
  if (ctx.type === "Person" && !(website || employer || overlap)) conf = Math.min(conf, PERSON_UNCORROBORATED_CAP);
  c.signals = { name, type, context: Math.round(context * 1e4) / 1e4, website: website ? 1 : 0, rank };
  c.score = Math.round(Math.min(conf, 1) * 1e4) / 1e4;
  return c.score;
}

function sameAsUrls(c: Candidate, lang: string): { wikipediaUrl?: string; sameAs: string[] } {
  const wikipediaUrl = c.sitelinks[`${lang}wiki`] ?? c.sitelinks.enwiki ?? Object.values(c.sitelinks)[0];
  const urls = [wikidataUrl(c.qid), ...(wikipediaUrl ? [wikipediaUrl] : [])];
  for (const [p, tpl] of SAME_AS_PROPS) {
    const v = c.claims[p]?.[0];
    if (v) urls.push(tpl.replace("{}", encodeURIComponent(v).replace(/%40/g, "@")));
  }
  return { wikipediaUrl, sameAs: [...new Set(urls)] };
}

async function personFacts(c: Candidate, lang: string) {
  const groups: Record<string, string[]> = {
    alumniOf: (c.claims.P69 ?? []).slice(0, 8),
    hasCredential: (c.claims.P512 ?? []).slice(0, 8),
    knowsAbout: (c.claims.P101 ?? c.claims.P106 ?? []).slice(0, 8),
  };
  const ids = Object.values(groups).flat();
  const ents = ids.length ? await getEntities(ids, [lang, "en"], "labels") : {};
  const out: Json = {};
  for (const [k, qs] of Object.entries(groups)) {
    const items = qs.filter((q) => ents[q]).map((q) => ({ name: langValue(ents[q].labels, lang), wikidataId: q })).filter((x) => x.name);
    out[k] = items.length ? items : undefined;
  }
  return out;
}

const summary = (c: Candidate) => ({
  qid: c.qid, label: c.label, description: c.description || null, url: wikidataUrl(c.qid), score: c.score, signals: c.signals,
});

// ---------------------------------------------------------------- DB layer

const props = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Json) } : {});
const rec = (p: Json): Json => props(p.reconciliation);
const statusOf = (p: Json) => String(rec(p).status ?? "pending") as (typeof RECONCILIATION_STATUSES)[number];
const declaredSameAs = (p: Json) =>
  (Array.isArray(p.same_as) ? p.same_as : []).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));

export const reconciliationQuerySchema = z.object({
  status: z.string().optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(RECONCILIATION_STATUSES)).optional()),
  type: z.enum(RECONCILABLE_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const reconciliationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify"), qid: z.string().regex(/^Q[1-9]\d*$/, "Expected a Wikidata QID like Q42") }),
  z.object({ action: z.literal("reject") }),
  z.object({
    action: z.literal("requery"),
    query: z.string().trim().min(1).max(250).optional(),
    lang: z.string().regex(/^[a-z]{2,3}$/).optional(),
  }),
]);

type EntityRow = { id: string; key: string; entityType: string; name: string; url: string | null; properties: unknown };

function view(e: EntityRow) {
  const p = props(e.properties);
  const r = rec(p);
  return {
    id: e.id, key: e.key, type: e.entityType, name: e.name, url: e.url,
    status: statusOf(p), method: (r.method as string) ?? null,
    confidence: typeof p.confidence === "number" ? p.confidence : null,
    wikidataId: (p.wikidataId as string) ?? null, wikipediaUrl: (p.wikipediaUrl as string) ?? null,
    sameAs: Array.isArray(p.sameAs) ? p.sameAs : [],
    candidates: Array.isArray(r.candidates) ? r.candidates : [],
    suggested: r.suggested ?? null,
    reconciledAt: r.reconciledAt ?? null, verifiedAt: r.verifiedAt ?? null,
  };
}

/** Review queue: reconcilable entities with their match state, filtered by status/type. */
export async function listReconciliations(siteId: string, q: z.infer<typeof reconciliationQuerySchema>) {
  await getSiteOrThrow(siteId);
  // Json filters are not portable to SQLite, so status is filtered in memory (bounded by entity count per site).
  const rows = await prisma.graphEntity.findMany({
    where: { siteId, entityType: q.type ? q.type : { in: [...RECONCILABLE_TYPES] } },
    orderBy: [{ entityType: "asc" }, { name: "asc" }],
    select: { id: true, key: true, entityType: true, name: true, url: true, properties: true },
    take: 20_000,
  });
  const all = rows.map(view);
  const byStatus: Record<string, number> = {};
  for (const v of all) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  const filtered = q.status ? all.filter((v) => q.status!.includes(v.status)) : all;
  // review first: that is where a human is needed
  const order = (s: string) => (s === "review" ? 0 : s === "pending" || s === "unmatched" ? 1 : 2);
  filtered.sort((a, b) => order(a.status) - order(b.status) || (b.confidence ?? 0) - (a.confidence ?? 0));
  return { items: filtered.slice(q.offset, q.offset + q.limit), total: filtered.length, byStatus };
}

async function loadEntity(siteId: string, entityId: string) {
  const e = await prisma.graphEntity.findUnique({ where: { id: entityId } });
  if (!e || e.siteId !== siteId) throw notFound("Entity");
  if (!(RECONCILABLE_TYPES as readonly string[]).includes(e.entityType)) {
    throw new HttpError(400, `Entity type ${e.entityType} is not reconcilable`, { reconcilable: RECONCILABLE_TYPES });
  }
  return e;
}

async function siteContext(siteId: string, siteUrl: string, settings: unknown) {
  const rows = await prisma.graphEntity.findMany({
    where: { siteId, entityType: { in: ["Category", "Concept", "Organization", "Brand"] } },
    select: { entityType: true, name: true, properties: true }, take: 2_000,
  });
  const contextTerms = new Set<string>();
  const orgQids = new Set<string>();
  for (const r of rows) {
    const p = props(r.properties);
    if (r.entityType === "Category" || r.entityType === "Concept") for (const t of tokens(r.name)) contextTerms.add(t);
    else if (typeof p.wikidataId === "string") orgQids.add(p.wikidataId);
  }
  const stem = hostOf(siteUrl).split(".")[0];
  if (stem.length > 2) contextTerms.add(fold(stem));
  const locale = typeof props(settings).locale === "string" ? String(props(settings).locale).slice(0, 2).toLowerCase() : undefined;
  return { contextTerms, orgQids, siteHost: hostOf(siteUrl), locale };
}

/** Writes the accepted match onto the entity and points its same_as edge at the wikidata:Q… node. */
async function linkWikidata(tx: Prisma.TransactionClient, siteId: string, entityId: string, qid: string | null, label?: string) {
  const stale = await tx.graphRelation.findMany({
    where: { siteId, sourceId: entityId, relationType: "same_as", target: { entityType: "WikidataEntity" } },
    select: { id: true, targetId: true, target: { select: { key: true } } },
  });
  const keep = qid ? `wikidata:${qid}` : null;
  const drop = stale.filter((r) => r.target.key !== keep);
  if (drop.length) {
    await tx.graphRelation.deleteMany({ where: { id: { in: drop.map((r) => r.id) } } });
    // remove wikidata nodes nothing points at anymore
    await tx.graphEntity.deleteMany({
      where: { id: { in: drop.map((r) => r.targetId) }, incoming: { none: {} } },
    });
  }
  if (!qid || !keep) return;
  const node = await tx.graphEntity.upsert({
    where: { siteId_key: { siteId, key: keep } },
    create: { siteId, key: keep, entityType: "WikidataEntity", name: label || qid, url: wikidataUrl(qid), properties: { wikidataId: qid, url: wikidataUrl(qid) } },
    update: {},
    select: { id: true },
  });
  await tx.graphRelation.upsert({
    where: { sourceId_targetId_relationType: { sourceId: entityId, targetId: node.id, relationType: "same_as" } },
    create: { siteId, sourceId: entityId, targetId: node.id, relationType: "same_as", properties: { method: "manual", confidence: 1 } },
    update: {},
  });
}

function withoutMatch(p: Json): Json {
  const out = { ...p };
  for (const k of RECONCILIATION_KEYS) delete out[k];
  const declared = declaredSameAs(p);
  if (declared.length) out.sameAs = declared;
  return out;
}

async function matchedProps(p: Json, c: Candidate, lang: string, type: string): Promise<Json> {
  const { wikipediaUrl, sameAs } = sameAsUrls(c, lang);
  return {
    ...withoutMatch(p),
    wikidataId: c.qid, wikidataUrl: wikidataUrl(c.qid), wikipediaUrl,
    sameAs: [...new Set([...sameAs, ...declaredSameAs(p)])],
    ...(type === "Person" ? await personFacts(c, lang) : {}),
    ...(c.claims.P108?.length ? { employerWikidataIds: c.claims.P108 } : {}),
  };
}

/** Pins an entity to a QID chosen by a user (confidence 1, survives re-crawls). */
export async function verifyEntity(siteId: string, entityId: string, qid: string) {
  const e = await loadEntity(siteId, entityId);
  const p = props(e.properties);
  const r = rec(p);
  const lang = String(r.lang ?? "en");
  const ents = await getEntities([qid], [lang, "en"]);
  if (!ents[qid]) throw new HttpError(422, `Wikidata item ${qid} does not exist`);
  const c = candidateFrom(ents[qid], lang);
  const next = await matchedProps(p, c, lang, e.entityType);
  next.confidence = 1;
  next.reconciliation = {
    ...r, status: "verified", method: "manual", confidence: 1, lang,
    rejectedQids: (Array.isArray(r.rejectedQids) ? r.rejectedQids : []).filter((x) => x !== qid),
    verifiedAt: new Date().toISOString(),
  };
  return prisma.$transaction(async (tx) => {
    await linkWikidata(tx, siteId, e.id, qid, c.label);
    return view(await tx.graphEntity.update({ where: { id: e.id }, data: { properties: next as Prisma.InputJsonValue } }));
  });
}

/** Marks the current (or suggested) match as wrong: no sameAs is published and the QID is never auto-matched again. */
export async function rejectEntity(siteId: string, entityId: string) {
  const e = await loadEntity(siteId, entityId);
  const p = props(e.properties);
  const r = rec(p);
  const rejected = new Set((Array.isArray(r.rejectedQids) ? r.rejectedQids : []).map(String));
  const current = (p.wikidataId as string) ?? (r.candidates as { qid?: string }[] | undefined)?.[0]?.qid;
  if (current) rejected.add(current);
  const next = withoutMatch(p);
  next.confidence = 0;
  next.reconciliation = {
    ...r, status: "rejected", method: "manual", confidence: 0, rejectedQids: [...rejected], verifiedAt: new Date().toISOString(),
  };
  delete (next.reconciliation as Json).suggested;
  return prisma.$transaction(async (tx) => {
    await linkWikidata(tx, siteId, e.id, null);
    return view(await tx.graphEntity.update({ where: { id: e.id }, data: { properties: next as Prisma.InputJsonValue } }));
  });
}

/** Searches Wikidata again (optionally with a different name/language) and re-scores candidates. */
export async function requeryEntity(siteId: string, entityId: string, opts: { query?: string; lang?: string } = {}) {
  const site = await getSiteOrThrow(siteId);
  const e = await loadEntity(siteId, entityId);
  const p = props(e.properties);
  const r = rec(p);
  const ctxSite = await siteContext(siteId, site.url, site.settings);
  const lang = opts.lang ?? (typeof r.lang === "string" ? r.lang : undefined) ?? ctxSite.locale ?? "en";
  const type = e.entityType as ReconcilableType;
  const name = opts.query ?? e.name;
  for (const t of tokens(e.name)) ctxSite.contextTerms.delete(t);
  const ownQid = typeof p.wikidataId === "string" ? p.wikidataId : undefined;
  if (ownQid) ctxSite.orgQids.delete(ownQid);
  const ctx: MatchContext = {
    name, type, lang, url: typeof p.url === "string" ? p.url : e.url ?? undefined,
    siteHost: type === "Organization" || type === "Brand" ? ctxSite.siteHost : "",
    contextTerms: ctxSite.contextTerms, orgQids: ctxSite.orgQids,
  };

  let hits: { id?: string }[] = [];
  for (const l of [...new Set([lang, "en"])]) {
    const data = await getJson(WIKIDATA_API, {
      action: "wbsearchentities", search: name, language: l, uselang: l, type: "item", limit: "5", format: "json",
    });
    hits = (data.search ?? []) as { id?: string }[];
    if (hits.length) break;
  }
  const ranked = hits.map((h, i) => [h.id, i] as const).filter((x): x is [string, number] => !!x[0]);
  const ents = ranked.length ? await getEntities(ranked.map(([q]) => q), [lang, "en"]) : {};
  const candidates = ranked.filter(([q]) => ents[q]).map(([q, i]) => candidateFrom(ents[q], lang, i));
  const classes = ACCEPTED[type];
  const unresolved = classes ? candidates.filter((c) => !c.instanceOf.some((q) => classes.has(q) || REJECTED.has(q))).map((c) => c.qid) : [];
  const sparql = classes && unresolved.length ? await instancesWithin(unresolved, classes) : new Set<string>();
  for (const c of candidates) scoreCandidate(ctx, c, sparql);
  candidates.sort((a, b) => b.score - a.score || a.rank - b.rank);

  const rejected = new Set((Array.isArray(r.rejectedQids) ? r.rejectedQids : []).map(String));
  const best = candidates.find((c) => !rejected.has(c.qid));
  const base: Json = {
    ...r, lang, method: "wikidata_search", query: name, candidates: candidates.slice(0, 5).map(summary),
    reconciledAt: new Date().toISOString(),
  };
  delete base.verifiedAt;
  delete base.suggested;
  let next: Json;
  let qid: string | null = null;
  if (best && best.score >= AUTO_ACCEPT) {
    next = await matchedProps(p, best, lang, type);
    qid = best.qid;
    next.reconciliation = { ...base, status: "matched", confidence: best.score };
  } else {
    next = withoutMatch(p);
    next.reconciliation = { ...base, status: best && best.score >= REVIEW ? "review" : "unmatched", confidence: best?.score ?? 0 };
  }
  next.confidence = best?.score ?? 0;
  return prisma.$transaction(async (tx) => {
    await linkWikidata(tx, siteId, e.id, qid, best?.label);
    return view(await tx.graphEntity.update({ where: { id: e.id }, data: { properties: next as Prisma.InputJsonValue } }));
  });
}

export async function applyReconciliationAction(siteId: string, entityId: string, input: z.infer<typeof reconciliationActionSchema>) {
  if (input.action === "verify") return verifyEntity(siteId, entityId, input.qid);
  if (input.action === "reject") return rejectEntity(siteId, entityId);
  return requeryEntity(siteId, entityId, input);
}

/**
 * Re-crawl ingestion keeps human decisions: for an entity a user verified/rejected, the reconciliation
 * properties of the stored row replace whatever the crawler computed. Returns the merged properties plus the
 * QID whose same_as link must exist (null = drop every Wikidata link of this entity).
 */
export function preserveManualReconciliation(incoming: unknown, existing: unknown): { properties: Json; manualQid?: string | null } {
  const next = props(incoming);
  const prev = props(existing);
  if (!MANUAL.has(statusOf(prev))) return { properties: next };
  for (const k of RECONCILIATION_KEYS) delete next[k];
  for (const k of RECONCILIATION_KEYS) if (k in prev) next[k] = prev[k];
  return { properties: next, manualQid: statusOf(prev) === "verified" ? (prev.wikidataId as string) ?? null : null };
}

/** Re-applies manual links after a crawl replaced the graph's relations. */
export async function restoreManualLinks(tx: Prisma.TransactionClient, siteId: string, manual: Map<string, string | null>) {
  for (const [entityId, qid] of manual) await linkWikidata(tx, siteId, entityId, qid);
  if (manual.size) {
    // the crawler may have shipped wikidata:Q… nodes only a now-overridden match pointed at
    await tx.graphEntity.deleteMany({ where: { siteId, entityType: "WikidataEntity", incoming: { none: {} } } });
  }
}

/** Schema.org @graph for the site, built from the stored (reconciled) knowledge graph. */
export async function getSiteJsonLd(siteId: string) {
  const site = await getSiteOrThrow(siteId);
  const [entities, relations] = await Promise.all([
    prisma.graphEntity.findMany({
      where: { siteId, entityType: { not: "Question" } },
      select: { id: true, key: true, entityType: true, name: true, url: true, properties: true },
      take: 20_000,
    }),
    prisma.graphRelation.findMany({
      where: { siteId, relationType: { in: ["written_by", "published_by", "mentions_entity", "has_brand", "has_offer", "has_category"] } },
      select: { sourceId: true, targetId: true, relationType: true },
    }),
  ]);
  const keyOf = new Map(entities.map((e) => [e.id, e.key]));
  const nodes = entities.map((e) => {
    const p = props(e.properties);
    return { key: e.key, type: e.entityType, name: e.name, url: e.url, properties: p,
      sourceUrls: Array.isArray(p.source_urls) ? (p.source_urls as string[]) : [] };
  });
  const edges = relations
    .filter((r) => keyOf.has(r.sourceId) && keyOf.has(r.targetId))
    .map((r) => ({ source: keyOf.get(r.sourceId)!, target: keyOf.get(r.targetId)!, type: r.relationType }));
  const jsonld = buildJsonLd(site, nodes, edges);
  const errors = validateJsonLd(jsonld);
  const script = `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>`;
  return { jsonld, valid: errors.length === 0, errors, script, nodes: (jsonld["@graph"] as unknown[]).length };
}
