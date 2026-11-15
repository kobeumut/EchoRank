import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AUTOGEO_RULE_TYPES, SUGGESTION_STATUSES } from "@/lib/constants";
import { autoGeoReportSchema, createUnifiedDiff } from "@/lib/services/autogeo";
import { diffSides, ruleTypeOf, suggestionsFromReport } from "@/lib/services/autogeo-suggestions";
import { startAudit } from "@/lib/services/audit";
import * as result from "@/app/api/sites/[id]/audit/[auditId]/result/route";
import * as route from "@/app/api/sites/[id]/autogeo/route";
import * as itemRoute from "@/app/api/sites/[id]/autogeo/[suggestionId]/route";
import * as applyRoute from "@/app/api/sites/[id]/autogeo/[suggestionId]/apply/route";
import { ctx, req, resetDb } from "./helpers";

// Engine output for a Turkish sample page (Turkish snippets are the input of these tests, not text of ours).
const RAW = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/autogeo-report.json"), "utf8"));
const AUDIT = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/geo-audit-result.json"), "utf8"));
const REPORT = autoGeoReportSchema.parse(RAW);
const WEAK = "https://shop.example.com/blog/espresso-rehberi";
const IMPROVEMENTS = RAW.pages.reduce((n: number, p: { improvements: unknown[] }) => n + p.improvements.length, 0);

const sctx = (id: string, suggestionId: string) => ({ params: Promise.resolve({ id, suggestionId }) });
const get = async (siteId: string, qs = "") => {
  const res = await route.GET(req(`/api/sites/${siteId}/autogeo${qs}`), ctx(siteId));
  return { status: res.status, body: await res.json() };
};
const post = async (siteId: string, body?: unknown) => {
  const res = await route.POST(req(`/api/sites/${siteId}/autogeo`, { method: "POST", body }), ctx(siteId));
  return { status: res.status, body: await res.json() };
};

describe("suggestion extraction", () => {
  it("maps engine rules to the public rule types", () => {
    expect(ruleTypeOf("autogeo.statistics", "statistics")).toBe("stats");
    expect(ruleTypeOf("autogeo.quotations", "quotations")).toBe("quotes");
    expect(ruleTypeOf("autogeo.answer_capsules")).toBe("answer_capsule");
    expect(ruleTypeOf("autogeo.authority_fluency")).toBe("tone");
    expect(ruleTypeOf("autogeo.comparison_table", "statistics")).toBe("comparison_table");
    expect(ruleTypeOf("schema.faq")).toBeNull();
  });

  it("turns every improvement into a draft whose snippets reproduce its diff", () => {
    const drafts = suggestionsFromReport(REPORT);
    expect(drafts).toHaveLength(IMPROVEMENTS);
    for (const d of drafts) {
      expect(AUTOGEO_RULE_TYPES).toContain(d.ruleType);
      expect(d.suggestedSnippet.length).toBeGreaterThan(0);
      expect(d.diffMarkdown).toMatch(/^--- a\//);
    }
    // insertions keep their anchor heading, so applying = replace original with suggested
    // ("Teknik özellikler" = "Technical specifications": heading of the Turkish sample page in the fixture)
    const insert = drafts.find((d) => d.ruleType === "answer_capsule" && d.originalSnippet === "## Teknik özellikler")!;
    expect(insert.suggestedSnippet).toMatch(/^## Teknik özellikler\n\nTeknik özellikler: Basınç/);
  });

  it("recovers both sides of a unified diff", () => {
    const diff = createUnifiedDiff("a\nb\nc", "a\nB\nc\nd");
    expect(diffSides(diff)).toEqual({ before: "a\nb\nc", after: "a\nB\nc\nd" });
    expect(diffSides("")).toEqual({ before: "", after: "" });
  });
});

describe("GET/POST /api/sites/[id]/autogeo + PATCH /autogeo/[suggestionId]", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  async function ingest(siteId: string, body: unknown) {
    const job = await startAudit(siteId, { trigger: "manual" });
    const rctx = { params: Promise.resolve({ id: siteId, auditId: job.audit.id }) };
    const res = await result.POST(req(`/api/sites/${siteId}/audit/${job.audit.id}/result`, { method: "POST", body }), rctx);
    expect(res.status).toBe(200);
    return res.json();
  }
  const site = () => prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });

  it("persists suggestions on audit ingestion, linked to their action items, and lists them", async () => {
    const s = await site();
    const ingested = await ingest(s.id, { ...AUDIT, autogeo: RAW });
    expect(ingested.autogeo.suggestions).toMatchObject({ created: IMPROVEMENTS, superseded: 0 });

    const { status, body } = await get(s.id);
    expect(status).toBe(200);
    expect(body.summary.pages).toHaveLength(4); // legacy contract kept
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.suggestions.total).toBe(IMPROVEMENTS);
    expect(body.suggestions.byStatus).toEqual({ pending: IMPROVEMENTS });
    const gains = body.suggestions.items.map((i: { expectedGain: number }) => i.expectedGain);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
    expect(body.suggestions.items.every((i: { actionItemId: string | null }) => i.actionItemId)).toBe(true);
  });

  it("filters by rule type, page, gain and paginates", async () => {
    const s = await site();
    await post(s.id, { report: RAW });
    const stats = (await get(s.id, "?ruleType=stats")).body.suggestions;
    expect(stats.items.length).toBeGreaterThan(0);
    expect(stats.items.every((i: { ruleType: string }) => i.ruleType === "stats")).toBe(true);
    const page = (await get(s.id, `?pageUrl=${encodeURIComponent(WEAK)}`)).body.suggestions;
    expect(page.total).toBe(RAW.pages[0].improvements.length);
    const first = (await get(s.id, "?limit=2&offset=0&sort=recent")).body.suggestions;
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(IMPROVEMENTS);
    const big = (await get(s.id, "?minGain=1000")).body.suggestions;
    expect(big.total).toBe(0);
  });

  it("is idempotent, keeps user decisions and supersedes what a re-analysis drops", async () => {
    const s = await site();
    expect((await post(s.id, { report: RAW })).body).toMatchObject({ source: "report", created: IMPROVEMENTS });
    expect((await post(s.id, { report: RAW })).body).toMatchObject({ created: 0, updated: IMPROVEMENTS, superseded: 0 });

    const target = (await get(s.id, `?pageUrl=${encodeURIComponent(WEAK)}`)).body.suggestions.items[0];
    const res = await itemRoute.PATCH(
      req(`/api/sites/${s.id}/autogeo/${target.id}`, { method: "PATCH", body: { status: "applied" } }), sctx(s.id, target.id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("applied");

    // the weak page was rewritten: the engine now proposes a single, different change for it
    const rewritten = {
      ...RAW,
      pages: RAW.pages.map((p: { url: string; improvements: object[] }) =>
        p.url === WEAK ? { ...p, improvements: [{ ...p.improvements[0], before_markdown: "New paragraph.", after_markdown: "New paragraph, up 42%." }] } : p),
    };
    const third = (await post(s.id, { report: rewritten })).body;
    expect(third.created).toBe(1);
    expect(third.superseded).toBe(RAW.pages[0].improvements.length - 1); // the applied one is kept as is
    const applied = await prisma.autoGeoSuggestion.findUniqueOrThrow({ where: { id: target.id } });
    expect(applied.status).toBe("applied");

    // re-proposed again -> back to pending
    const back = (await post(s.id, { report: RAW })).body;
    expect(back.superseded).toBe(1);
    expect((await get(s.id, "?status=pending")).body.suggestions.total).toBe(IMPROVEMENTS - 1);
  });

  it("supersedes pending suggestions of a page that is now clean", async () => {
    const s = await site();
    await post(s.id, { report: RAW });
    const clean = { ...RAW, pages: RAW.pages.map((p: { url: string }) => (p.url === WEAK ? { ...p, improvements: [] } : p)) };
    const res = (await post(s.id, { report: clean })).body;
    expect(res).toMatchObject({ created: 0, superseded: RAW.pages[0].improvements.length });
    // pages missing from a report were not analysed: untouched
    const partial = { ...RAW, pages: RAW.pages.filter((p: { url: string }) => p.url === WEAK) };
    expect((await post(s.id, { report: partial })).body.superseded).toBe(0);
  });

  it("rebuilds suggestions from stored action items when no report is posted", async () => {
    const s = await site();
    await ingest(s.id, { ...AUDIT, autogeo: RAW });
    await prisma.autoGeoSuggestion.deleteMany({ where: { siteId: s.id } });
    const { status, body } = await post(s.id);
    expect(status).toBe(200);
    expect(body.source).toBe("action_items");
    expect(body.created).toBeGreaterThan(0);
    const rows = await prisma.autoGeoSuggestion.findMany({ where: { siteId: s.id } });
    expect(rows.every((r) => r.actionItemId && r.suggestedSnippet && r.diffMarkdown)).toBe(true);
  });

  describe("Apply to CMS delivery message", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is written in the request's language (English by default)", async () => {
      vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true"); // no DNS in tests
      vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
      const s = await prisma.site.create({
        data: { url: "https://shop.example.com", title: "Shop", settings: { distribution: { syndication: { webhooks: [{ url: "https://cms.example.com/hook" }] } } } },
      });
      await post(s.id, { report: RAW });
      const row = await prisma.autoGeoSuggestion.findFirstOrThrow({ where: { siteId: s.id } });
      const apply = async (query = "") => {
        const res = await applyRoute.POST(req(`/api/sites/${s.id}/autogeo/${row.id}/apply${query}`, { method: "POST" }), sctx(s.id, row.id));
        return { status: res.status, body: await res.json() };
      };
      expect((await apply()).body.deliveries[0]).toMatchObject({ status: "sent", message: "Delivered" });
      expect((await apply("?lang=tr")).body.deliveries[0]).toMatchObject({ status: "sent", message: "Teslim edildi" });
      vi.unstubAllEnvs();
    });
  });

  it("validates input and scopes suggestions to their site", async () => {
    const s = await site();
    const other = await prisma.site.create({ data: { url: "https://other.example.com", title: "Other" } });
    expect((await get(s.id, "?status=bogus")).status).toBe(400);
    expect((await get(s.id, "?ruleType=stats,nope")).status).toBe(400);
    expect((await post(s.id, { report: { pages: "x" } })).status).toBe(400);
    expect((await post(s.id, { unknown: true })).status).toBe(400);
    await post(s.id, { report: RAW });
    const row = await prisma.autoGeoSuggestion.findFirstOrThrow({ where: { siteId: s.id } });
    const patch = (siteId: string, body: unknown) =>
      itemRoute.PATCH(req(`/api/sites/${siteId}/autogeo/${row.id}`, { method: "PATCH", body }), sctx(siteId, row.id));
    expect((await patch(other.id, { status: "dismissed" })).status).toBe(404);
    expect((await patch(s.id, { status: "superseded" })).status).toBe(400);
    expect(SUGGESTION_STATUSES).toContain("superseded");
    expect((await get("missing")).status).toBe(404);
  });
});
