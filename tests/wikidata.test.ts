import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { buildJsonLd, validateJsonLd } from "@/lib/jsonld";
import { applyCrawlRecords } from "@/lib/services/audit-results";
import { nameSimilarity } from "@/lib/services/wikidata";
import * as jsonldRoute from "@/app/api/sites/[id]/jsonld/route";
import * as listRoute from "@/app/api/sites/[id]/reconciliation/route";
import * as actionRoute from "@/app/api/sites/[id]/reconciliation/[entityId]/route";
import { ctx, req, resetDb } from "./helpers";

const BASE = "https://shop.example.com";

// ---- deterministic fake Wikidata (same items as services/crawler/tests/wikidata_fixtures.py) ----
const claim = (v: string) => ({ rank: "normal", mainsnak: { datavalue: { value: /^Q\d+$/.test(v) ? { id: v } : v } } });
const item = (id: string, label: string, description = "", claims: Record<string, string[]> = {}, sitelinks: Record<string, string> = {}) => ({
  id,
  labels: { tr: { value: label } },
  descriptions: description ? { tr: { value: description } } : {},
  aliases: {},
  claims: Object.fromEntries(Object.entries(claims).map(([p, vs]) => [p, vs.map(claim)])),
  sitelinks: Object.fromEntries(Object.entries(sitelinks).map(([k, t]) => [k, { title: t, url: `https://${k.slice(0, -4)}.wikipedia.org/wiki/${t}` }])),
});
const ENTITIES: Record<string, ReturnType<typeof item>> = Object.fromEntries([
  item("Q1001", "Kahve Dükkanı", "Türk kahve perakende şirketi",
    { P31: ["Q4830453"], P856: ["https://shop.example.com"], P4264: ["kahve-dukkani"], P2088: ["kahve-dukkani"] },
    { trwiki: "Kahve_Dükkanı" }),
  item("Q2001", "Brevio", "kahve makinesi markası", { P31: ["Q431289"] }),
  item("Q3002", "Ayşe Yılmaz", "Türk oyuncu", { P31: ["Q5"] }),
  item("Q3001", "Ayşe Yılmaz", "Türk barista ve kahve yazarı",
    { P31: ["Q5"], P108: ["Q1001"], P69: ["Q4001"], P101: ["Q4002"], P6634: ["ayse-yilmaz"] }),
  item("Q4001", "Boğaziçi Üniversitesi"),
  item("Q4002", "kahve"),
  item("Q6001", "Barista Pro X", "espresso makinesi modeli", { P31: ["Q99999"] }),
].map((e) => [e.id, e]));
const SEARCH: Record<string, string[]> = { "ayşe yılmaz": ["Q3002", "Q3001"], brevio: ["Q2001"], "barista pro x": ["Q6001"] };

let sparqlDown = false;
const calls: string[] = [];
function mockWikidata() {
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const q = Object.fromEntries(url.searchParams);
    expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(/ai-visibility/);
    if (url.hostname === "query.wikidata.org") {
      calls.push("sparql");
      if (sparqlDown) return new Response("busy", { status: 503 });
      const asked = [...q.query.split("VALUES ?cls")[0].matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
      return Response.json({ results: { bindings: asked.filter((x) => x === "Q6001").map((x) => ({ item: { value: `http://www.wikidata.org/entity/${x}` } })) } });
    }
    calls.push(`${q.action}:${q.search ?? q.ids}`);
    if (q.action === "wbsearchentities") {
      const ids = q.language === "tr" ? SEARCH[q.search.toLocaleLowerCase("tr")] ?? [] : [];
      return Response.json({ search: ids.map((id) => ({ id })) });
    }
    if (q.action === "wbgetentities") {
      return Response.json({ entities: Object.fromEntries(q.ids.split("|").map((id) => [id, ENTITIES[id] ?? { id, missing: "" }])) });
    }
    return new Response("unexpected", { status: 404 });
  }));
}

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
  sparqlDown = false;
  mockWikidata();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => prisma.$disconnect());

/** A crawled + reconciled graph as geo-audit --reconcile --crawl-records would deliver it. */
const crawlRecords = (overrides: { orgProps?: Record<string, unknown> } = {}) => ({
  crawledPages: [],
  graphEntities: [
    { key: `page:${BASE}/`, entityType: "Page", name: "Anasayfa", url: `${BASE}/`, properties: { page_type: "home", lang: "tr", title: "Kahve Dükkanı", url: `${BASE}/` } },
    { key: `page:${BASE}/blog/espresso`, entityType: "Page", name: "Espresso Rehberi", url: `${BASE}/blog/espresso`,
      properties: { page_type: "article", headline: "Espresso Rehberi", date_published: "2026-10-01", lang: "tr", url: `${BASE}/blog/espresso` } },
    { key: "organization:kahve-dukkani-a-s", entityType: "Organization", name: "Kahve Dükkanı A.Ş.", url: BASE,
      properties: { url: BASE, logo: "/logo.png", same_as: ["https://instagram.com/kahve"], ...overrides.orgProps } },
    { key: "person:ayse-yilmaz", entityType: "Person", name: "Ayşe Yılmaz", properties: { job_title: "Barista",
      reconciliation: { status: "review", method: "wikidata_search", lang: "tr", candidates: [{ qid: "Q3002", score: 0.7 }] }, confidence: 0.7 } },
    { key: "brand:brevio", entityType: "Brand", name: "Brevio", properties: {} },
    { key: "product:bpx-100", entityType: "Product", name: "Barista Pro X", url: `${BASE}/urun/bpx`,
      properties: { url: `${BASE}/urun/bpx`, sku: "BPX-100", image: "/img/bpx.jpg", rating: 4.7, review_count: 23 } },
    { key: "offer:bpx", entityType: "Offer", name: "offer", properties: { price: 12499.9, currency: "TRY", availability: "in_stock" } },
    { key: "concept:espresso", entityType: "Concept", name: "espresso", properties: { wikidataId: "Q180289", sameAs: ["https://www.wikidata.org/wiki/Q180289"] } },
    { key: "category:kahve-makineleri", entityType: "Category", name: "Kahve Makineleri", properties: {} },
    { key: "wikidata:Q1001", entityType: "WikidataEntity", name: "Kahve Dükkanı", properties: { wikidataId: "Q1001" } },
  ],
  graphRelations: [
    { sourceKey: `page:${BASE}/blog/espresso`, targetKey: "person:ayse-yilmaz", relationType: "written_by", weight: 1 },
    { sourceKey: `page:${BASE}/blog/espresso`, targetKey: "organization:kahve-dukkani-a-s", relationType: "published_by", weight: 1 },
    { sourceKey: `page:${BASE}/blog/espresso`, targetKey: "concept:espresso", relationType: "mentions_entity", weight: 1 },
    { sourceKey: "product:bpx-100", targetKey: "brand:brevio", relationType: "has_brand", weight: 1 },
    { sourceKey: "product:bpx-100", targetKey: "offer:bpx", relationType: "has_offer", weight: 1 },
    { sourceKey: "product:bpx-100", targetKey: "category:kahve-makineleri", relationType: "has_category", weight: 1 },
    { sourceKey: "organization:kahve-dukkani-a-s", targetKey: "wikidata:Q1001", relationType: "same_as", weight: 1 },
  ],
});

async function seed(records = crawlRecords()) {
  const site = await prisma.site.create({ data: { url: BASE, title: "Kahve Dükkanı", settings: { locale: "tr" } } });
  await applyCrawlRecords(site.id, null, records);
  const byKey = async (key: string) => prisma.graphEntity.findUniqueOrThrow({ where: { siteId_key: { siteId: site.id, key } } });
  return { site, byKey };
}
const act = (siteId: string, entityId: string, body: unknown) =>
  actionRoute.POST(req(`/api/sites/${siteId}/reconciliation/${entityId}`, { method: "POST", body }), { params: Promise.resolve({ id: siteId, entityId }) });
const sameAsTargets = (siteId: string, sourceId: string) =>
  prisma.graphRelation.findMany({ where: { siteId, sourceId, relationType: "same_as" }, include: { target: true } }).then((rs) => rs.map((r) => r.target.key));

describe("name matching parity with the Python reconciler", () => {
  it("returns the same similarity scores", () => {
    expect(nameSimilarity("Brevio", ["Brevio Kahve"])).toBe(0.6);
    expect(nameSimilarity("Kahve Dukkani", ["Kahve Dünyası"])).toBe(0.6923);
    expect(nameSimilarity("Arcelik", ["Arçelik A.Ş."])).toBe(1);
    expect(nameSimilarity("Barista Pro X", ["Barista Pro"])).toBe(0.825);
    expect(nameSimilarity("Ayşe Yılmaz", ["Ayse Yildiz"])).toBe(0.7364);
  });
});

describe("reconciliation review API", () => {
  it("lists reconcilable entities with status counts, review first", async () => {
    const { site } = await seed();
    const body = await (await listRoute.GET(req(`/api/sites/${site.id}/reconciliation`), ctx(site.id))).json();
    expect(body.total).toBe(5);
    expect(body.byStatus).toMatchObject({ review: 1, pending: 4 });
    expect(body.items[0]).toMatchObject({ name: "Ayşe Yılmaz", status: "review", confidence: 0.7 });
    const persons = await (await listRoute.GET(req(`/api/sites/${site.id}/reconciliation?status=review&type=Person`), ctx(site.id))).json();
    expect(persons.items).toHaveLength(1);
    expect((await listRoute.GET(req(`/api/sites/${site.id}/reconciliation?status=bogus`), ctx(site.id))).status).toBe(400);
  });

  it("verifies a QID manually: sameAs, wikidata node and same_as edge", async () => {
    const { site, byKey } = await seed();
    const org = await byKey("organization:kahve-dukkani-a-s");
    const res = await act(site.id, org.id, { action: "verify", qid: "Q1001" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "verified", method: "manual", confidence: 1, wikidataId: "Q1001" });
    expect(body.sameAs).toEqual([
      "https://www.wikidata.org/wiki/Q1001", "https://tr.wikipedia.org/wiki/Kahve_Dükkanı",
      "https://www.linkedin.com/company/kahve-dukkani", "https://www.crunchbase.com/organization/kahve-dukkani",
      "https://instagram.com/kahve",
    ]);
    expect(await sameAsTargets(site.id, org.id)).toEqual(["wikidata:Q1001"]);
  });

  it("rejects a match, unlinks it and never auto-matches that QID again", async () => {
    const { site, byKey } = await seed();
    const person = await byKey("person:ayse-yilmaz");
    await act(site.id, person.id, { action: "verify", qid: "Q3002" });
    expect(await sameAsTargets(site.id, person.id)).toEqual(["wikidata:Q3002"]);
    const rejected = await (await act(site.id, person.id, { action: "reject" })).json();
    expect(rejected).toMatchObject({ status: "rejected", wikidataId: null, sameAs: [] });
    expect(await sameAsTargets(site.id, person.id)).toEqual([]);
    // orphaned wikidata node is cleaned up
    expect(await prisma.graphEntity.count({ where: { siteId: site.id, key: "wikidata:Q3002" } })).toBe(0);
    const stored = (await byKey("person:ayse-yilmaz")).properties as { reconciliation: { rejectedQids: string[] } };
    expect(stored.reconciliation.rejectedQids).toEqual(["Q3002"]);
  });

  it("re-queries: employer corroboration picks the right person, rejected QIDs are skipped", async () => {
    const { site, byKey } = await seed();
    await act(site.id, (await byKey("organization:kahve-dukkani-a-s")).id, { action: "verify", qid: "Q1001" });
    const person = await byKey("person:ayse-yilmaz");
    const body = await (await act(site.id, person.id, { action: "requery" })).json();
    expect(body).toMatchObject({ status: "matched", wikidataId: "Q3001" });
    expect(body.candidates.map((c: { qid: string }) => c.qid)).toEqual(["Q3001", "Q3002"]);
    expect(body.candidates[1].score).toBeLessThanOrEqual(0.7); // namesake actress, no corroboration
    const stored = (await byKey("person:ayse-yilmaz")).properties as Record<string, unknown>;
    expect(stored.alumniOf).toEqual([{ name: "Boğaziçi Üniversitesi", wikidataId: "Q4001" }]);
    expect(stored.employerWikidataIds).toEqual(["Q1001"]);

    await act(site.id, person.id, { action: "reject" });
    const again = await (await act(site.id, person.id, { action: "requery" })).json();
    expect(again.status).not.toBe("matched"); // Q3001 rejected, Q3002 uncorroborated
    expect(again.wikidataId).toBeNull();
  });

  it("uses the SPARQL class closure and degrades when SPARQL is down", async () => {
    const { site, byKey } = await seed();
    const product = await byKey("product:bpx-100");
    const ok = await (await act(site.id, product.id, { action: "requery" })).json();
    expect(ok.candidates[0].signals.type).toBe(1);
    sparqlDown = true;
    const degraded = await (await act(site.id, product.id, { action: "requery", query: "Barista Pro X" })).json();
    expect(degraded.candidates[0].signals.type).toBe(0.4);
    expect(calls.filter((c) => c === "sparql")).toHaveLength(2);
  });

  it("validates input and ownership", async () => {
    const { site, byKey } = await seed();
    const org = await byKey("organization:kahve-dukkani-a-s");
    const page = await byKey(`page:${BASE}/`);
    expect((await act(site.id, org.id, { action: "verify", qid: "42" })).status).toBe(400);
    expect((await act(site.id, org.id, { action: "verify", qid: "Q999999" })).status).toBe(422);
    expect((await act(site.id, page.id, { action: "reject" })).status).toBe(400);
    expect((await act("other-site", org.id, { action: "reject" })).status).toBe(404);
    expect((await act(site.id, org.id, { action: "nope" })).status).toBe(400);
  });

  it("re-crawls keep manual decisions over the crawler's automatic match", async () => {
    const { site, byKey } = await seed();
    const org = await byKey("organization:kahve-dukkani-a-s");
    const person = await byKey("person:ayse-yilmaz");
    await act(site.id, org.id, { action: "verify", qid: "Q1001" });
    await act(site.id, person.id, { action: "reject" });

    // crawler auto-matches the org to another item and the person to the actress
    const next = crawlRecords({ orgProps: { wikidataId: "Q2001", sameAs: ["https://www.wikidata.org/wiki/Q2001"], reconciliation: { status: "matched" } } });
    next.graphEntities.push({ key: "wikidata:Q2001", entityType: "WikidataEntity", name: "x", properties: { wikidataId: "Q2001" } });
    next.graphEntities.push({ key: "wikidata:Q3002", entityType: "WikidataEntity", name: "x", properties: { wikidataId: "Q3002" } });
    next.graphEntities[3].properties = { job_title: "Head Barista", wikidataId: "Q3002", reconciliation: { status: "matched" }, confidence: 0.9 } as never;
    next.graphRelations = next.graphRelations.filter((r) => r.relationType !== "same_as");
    next.graphRelations.push({ sourceKey: "organization:kahve-dukkani-a-s", targetKey: "wikidata:Q2001", relationType: "same_as", weight: 1 });
    next.graphRelations.push({ sourceKey: "person:ayse-yilmaz", targetKey: "wikidata:Q3002", relationType: "same_as", weight: 1 });
    await applyCrawlRecords(site.id, null, next);

    const o = (await byKey("organization:kahve-dukkani-a-s")).properties as Record<string, unknown>;
    expect(o).toMatchObject({ wikidataId: "Q1001", confidence: 1, reconciliation: { status: "verified" } });
    expect(await sameAsTargets(site.id, org.id)).toEqual(["wikidata:Q1001"]);
    const p = (await byKey("person:ayse-yilmaz")).properties as Record<string, unknown>;
    expect(p.wikidataId).toBeUndefined();
    expect(p).toMatchObject({ job_title: "Head Barista", reconciliation: { status: "rejected" } }); // crawl data still refreshed
    expect(await sameAsTargets(site.id, person.id)).toEqual([]);
    expect(await prisma.graphEntity.count({ where: { siteId: site.id, key: { in: ["wikidata:Q2001", "wikidata:Q3002"] } } })).toBe(0);
  });
});

describe("JSON-LD @graph", () => {
  it("serves a connected, Rich Results-valid graph from the stored entities", async () => {
    const { site, byKey } = await seed();
    await act(site.id, (await byKey("organization:kahve-dukkani-a-s")).id, { action: "verify", qid: "Q1001" });
    await act(site.id, (await byKey("person:ayse-yilmaz")).id, { action: "verify", qid: "Q3001" });
    const body = await (await jsonldRoute.GET(req(`/api/sites/${site.id}/jsonld`), ctx(site.id))).json();
    expect(body.errors).toEqual([]);
    expect(body.valid).toBe(true);
    expect(body.script).toMatch(/^<script type="application\/ld\+json">\{"@context":"https:\/\/schema.org"/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON-LD nodes
    const graph: Record<string, any>[] = body.jsonld["@graph"];
    const byId = Object.fromEntries(graph.map((n) => [n["@id"], n]));
    const org = byId[`${BASE}/#organization`];
    expect(org).toMatchObject({ "@type": "Organization", url: `${BASE}/`, logo: { "@type": "ImageObject", url: `${BASE}/logo.png` } });
    expect(org.sameAs[0]).toBe("https://www.wikidata.org/wiki/Q1001");
    expect(byId[`${BASE}/#website`].publisher).toEqual({ "@id": org["@id"] });
    const person = graph.find((n) => n["@type"] === "Person")!;
    expect(person).toMatchObject({ jobTitle: "Barista", worksFor: { "@id": org["@id"] } });
    expect(person.alumniOf).toEqual([{ "@type": "EducationalOrganization", name: "Boğaziçi Üniversitesi", sameAs: "https://www.wikidata.org/wiki/Q4001" }]);
    expect(person.knowsAbout).toContainEqual({ "@id": `${BASE}/#/schema/concept/espresso` });
    const article = byId[`${BASE}/blog/espresso#article`];
    expect(article).toMatchObject({ author: [{ "@id": person["@id"] }], publisher: { "@id": org["@id"] }, datePublished: "2026-10-01" });
    const product = graph.find((n) => n["@type"] === "Product")!;
    expect(product.offers).toMatchObject({ "@type": "Offer", price: "12499.90", priceCurrency: "TRY", availability: "https://schema.org/InStock", seller: { "@id": org["@id"] } });
    expect(product.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 4.7, reviewCount: 23 });
    expect(product.image).toBe(`${BASE}/img/bpx.jpg`);
    expect(byId[product.brand["@id"]]).toMatchObject({ "@type": "Brand", name: "Brevio" });
  });

  it("omits nodes Google would reject and validates broken documents", () => {
    const doc = buildJsonLd({ url: BASE }, [
      { key: "product:a", type: "Product", name: "No offer", properties: {} },
      { key: `page:${BASE}/x`, type: "Page", name: "x", properties: { page_type: "article", headline: "No author" } },
    ], []);
    expect(validateJsonLd(doc)).toEqual([]);
    expect((doc["@graph"] as unknown[]).length).toBe(1); // only the WebSite node

    const errors = validateJsonLd({ "@context": "https://schema.org", "@graph": [
      { "@type": "Organization", "@id": "a", name: "X", sameAs: ["wikidata.org/wiki/Q1", "https://a.test", "https://a.test"] },
      { "@type": "Product", "@id": "p", name: "P" },
      { "@type": "Product", "@id": "q", name: "Q", offers: { "@type": "Offer", price: "1.299,90", priceCurrency: "TL" } },
      { "@type": "Article", "@id": "r", headline: "h".repeat(120), author: [{ "@id": "missing" }], datePublished: "8 Kasım" },
    ] }).join("\n");
    for (const expected of ["not an absolute URL", "duplicate URLs", "Product requires offers", "ISO 4217", "plain number",
      "headline longer", "dangling reference", "ISO 8601"]) {
      expect(errors).toContain(expected);
    }
  });
});
