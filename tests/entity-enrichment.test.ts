import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { enrichmentOf } from "@/lib/services/entity-enrichment";
import * as route from "@/app/api/sites/[id]/entities/reconcile/route";
import { ctx, req, resetDb } from "./helpers";

const BASE = "https://shop.example.com";
const claim = (v: string) => ({ rank: "normal", mainsnak: { datavalue: { value: /^Q\d+$/.test(v) ? { id: v } : v } } });
const ITEMS: Record<string, object> = {
  Q1001: {
    id: "Q1001", labels: { en: { value: "Coffee Corner" } }, descriptions: {}, aliases: {},
    claims: { P31: [claim("Q4830453")], P856: [claim(BASE)], P4264: [claim("coffee-corner")] },
    sitelinks: { enwiki: { title: "Coffee_Corner", url: "https://en.wikipedia.org/wiki/Coffee_Corner" } },
  },
};

beforeEach(async () => {
  await resetDb();
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
    const q = Object.fromEntries(new URL(String(input)).searchParams);
    if (q.action === "wbgetentities") return Response.json({ entities: Object.fromEntries(q.ids.split("|").map((id) => [id, ITEMS[id] ?? { id, missing: "" }])) });
    if (q.action === "wbsearchentities") return Response.json({ search: [] });
    return Response.json({ results: { bindings: [] } });
  }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => prisma.$disconnect());

async function seed() {
  const site = await prisma.site.create({ data: { url: BASE, title: "Coffee Corner", settings: { locale: "en" } } });
  const mk = (key: string, entityType: string, name: string, properties: object) =>
    prisma.graphEntity.create({ data: { siteId: site.id, key, entityType, name, properties } });
  const org = await mk("organization:coffee", "Organization", "Coffee Corner Inc.", { url: BASE, same_as: ["https://instagram.com/coffeecorner"] });
  const concept = await mk("concept:espresso", "Concept", "espresso", {
    wikidataId: "Q180289", wikipediaUrl: "https://en.wikipedia.org/wiki/Espresso", sameAs: ["https://www.wikidata.org/wiki/Q180289"],
    confidence: 0.92, reconciliation: { status: "matched", method: "wikidata_search" },
  });
  const person = await mk("person:jane", "Person", "Jane Smith", { confidence: 0.7, reconciliation: { status: "review", candidates: [{ qid: "Q3002" }] } });
  await mk("brand:brevio", "Brand", "Brevio", {});
  await mk("page:/", "Page", "Home", {}); // not reconcilable
  return { site, org, concept, person };
}
const get = async (siteId: string, qs = "") => {
  const res = await route.GET(req(`/api/sites/${siteId}/entities/reconcile${qs}`), ctx(siteId));
  return { status: res.status, body: await res.json() };
};
const post = async (siteId: string, body?: unknown) => {
  const res = await route.POST(req(`/api/sites/${siteId}/entities/reconcile`, { method: "POST", body }), ctx(siteId));
  return { status: res.status, body: await res.json() };
};

describe("enrichmentOf", () => {
  it("only verifies manual pins or matches above the auto-accept threshold", () => {
    const row = (properties: object) => ({ id: "e", key: "k", entityType: "Brand", name: "B", properties });
    expect(enrichmentOf(row({ wikidataId: "Q1", confidence: 0.92, reconciliation: { status: "matched" } })).isVerified).toBe(true);
    expect(enrichmentOf(row({ wikidataId: "Q1", confidence: 0.6, reconciliation: { status: "matched" } })).isVerified).toBe(false);
    expect(enrichmentOf(row({ wikidataId: "Q1", confidence: 0.2, reconciliation: { status: "verified" } })).isVerified).toBe(true);
    expect(enrichmentOf(row({ confidence: 1, reconciliation: { status: "verified" } })).isVerified).toBe(false);
    const e = enrichmentOf(row({ wikidataId: "Q1", wikipediaUrl: "https://en.wikipedia.org/wiki/B", sameAs: ["https://x.com/b", "javascript:alert(1)"] }));
    expect(e.sameAsLinks).toEqual(["https://www.wikidata.org/wiki/Q1", "https://en.wikipedia.org/wiki/B", "https://x.com/b"]);
    expect(e.status).toBe("pending");
  });
});

describe("GET/POST /api/sites/[id]/entities/reconcile", () => {
  it("mirrors reconcilable graph entities and exposes the verified sameAs list", async () => {
    const { site } = await seed();
    const { status, body } = await get(site.id);
    expect(status).toBe(200);
    expect(body.total).toBe(4);
    expect(body.byStatus).toEqual({ matched: 1, review: 1, pending: 2 });
    expect(body.items[0]).toMatchObject({ entityKey: "concept:espresso", isVerified: true, matchConfidence: 0.92, wikidataId: "Q180289" });
    expect(body.sameAs).toEqual([
      { entityKey: "concept:espresso", entityName: "espresso", entityType: "Concept", wikidataId: "Q180289",
        sameAsLinks: ["https://www.wikidata.org/wiki/Q180289", "https://en.wikipedia.org/wiki/Espresso"] },
    ]);
    expect(body.sync).toMatchObject({ entities: 4, changed: 4, removed: 0 });
    expect((await get(site.id)).body.sync.changed).toBe(0); // idempotent

    expect((await get(site.id, "?verified=false")).body.total).toBe(3);
    expect((await get(site.id, "?status=review&type=Person")).body.items).toHaveLength(1);
    expect((await get(site.id, "?minConfidence=0.8")).body.total).toBe(1);
  });

  it("verifies, rejects and syncs through the Wikidata reconciler", async () => {
    const { site, org, concept } = await seed();
    const verified = await post(site.id, { action: "verify", entityId: org.id, qid: "Q1001" });
    expect(verified.status).toBe(200);
    expect(verified.body.entity).toMatchObject({ status: "verified", wikidataId: "Q1001" });
    expect(verified.body.enrichment).toMatchObject({ entityKey: "organization:coffee", isVerified: true, matchConfidence: 1, wikidataId: "Q1001" });
    expect(verified.body.enrichment.sameAsLinks).toEqual(expect.arrayContaining([
      "https://www.wikidata.org/wiki/Q1001", "https://www.linkedin.com/company/coffee-corner", "https://instagram.com/coffeecorner",
    ]));
    // the knowledge graph got its same_as edge too
    expect(await prisma.graphRelation.count({ where: { siteId: site.id, sourceId: org.id, relationType: "same_as" } })).toBe(1);

    const rejected = await post(site.id, { action: "reject", entityId: concept.id });
    expect(rejected.body.enrichment).toMatchObject({ status: "rejected", isVerified: false, wikidataId: null });
    expect((await get(site.id)).body.sameAs.map((s: { entityKey: string }) => s.entityKey)).toEqual(["organization:coffee"]);

    await prisma.graphEntity.delete({ where: { id: concept.id } });
    const synced = await post(site.id);
    expect(synced.body).toMatchObject({ action: "sync", entities: 3, removed: 1 });
  });

  it("validates bodies and scopes entities to the site", async () => {
    const { site, org } = await seed();
    const other = await prisma.site.create({ data: { url: "https://other.example.com", title: "Other" } });
    expect((await post(site.id, { action: "verify", entityId: org.id, qid: "42" })).status).toBe(400);
    expect((await post(site.id, { action: "verify", qid: "Q1" })).status).toBe(400);
    expect((await post(site.id, { action: "explode" })).status).toBe(400);
    expect((await post(other.id, { action: "reject", entityId: org.id })).status).toBe(404);
    expect((await post(site.id, { action: "verify", entityId: org.id, qid: "Q999" })).status).toBe(422);
    expect((await get(site.id, "?verified=yes")).status).toBe(400);
    expect((await get("missing")).status).toBe(404);
  });
});
