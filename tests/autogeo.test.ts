import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ACTION_CATEGORIES, ACTION_EFFORTS, ACTION_IMPACTS } from "@/lib/constants";
import { serverT } from "@/lib/i18n/request";
import {
  applyUnifiedDiff,
  AUTOGEO_METRIC_INFO,
  AUTOGEO_METRICS,
  autoGeoReportSchema,
  autogeoToActionItems,
  createUnifiedDiff,
  improvementPatches,
  summarizeAutoGeo,
} from "@/lib/services/autogeo";
import { auditResultSchema } from "@/lib/services/audit-results";
import { startAudit } from "@/lib/services/audit";
import * as result from "@/app/api/sites/[id]/audit/[auditId]/result/route";
import * as autogeoRoute from "@/app/api/sites/[id]/autogeo/route";
import { ctx, req, resetDb } from "./helpers";

// Real output of geo_crawler.scoring.autogeo (services/crawler/tests/autogeo_fixtures.py): Python <-> API contract.
// The analysed sample page is Turkish on purpose: its rewrites ("[SAYI]", "([Kaynak, Yıl](...))") and the engine text
// that is passed through verbatim (metric details, rationales) are in the page's language.
const RAW = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/autogeo-report.json"), "utf8"));
const AUDIT = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/geo-audit-result.json"), "utf8"));
const REPORT = autoGeoReportSchema.parse(RAW);
const WEAK = "https://shop.example.com/blog/espresso-rehberi";
const STRONG = "https://shop.example.com/blog/espresso-nedir";

describe("createUnifiedDiff / applyUnifiedDiff", () => {
  it("produces a GNU unified diff for a rewrite", () => {
    const d = createUnifiedDiff("a\nb\nc", "a\nB\nc", { fromFile: "a/x.md", toFile: "b/x.md" });
    expect(d).toBe("--- a/x.md\n+++ b/x.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
    expect(applyUnifiedDiff("a\nb\nc", d)).toBe("a\nB\nc");
  });

  it("handles insertions, pure additions and identical input", () => {
    const ins = createUnifiedDiff("## H", "## H\n\nCapsule text.");
    expect(ins.split("\n").slice(2)).toEqual(["@@ -1 +1,3 @@", " ## H", "+", "+Capsule text."]);
    expect(applyUnifiedDiff("## H", ins)).toBe("## H\n\nCapsule text.");
    const add = createUnifiedDiff("", "<p>x</p>");
    expect(add).toContain("@@ -0,0 +1 @@");
    expect(applyUnifiedDiff("", add)).toBe("<p>x</p>");
    expect(createUnifiedDiff("same", "same")).toBe("");
  });

  it("splits distant changes into separate hunks and round-trips", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 2", "LINE 2").replace("line 17", "LINE 17");
    const d = createUnifiedDiff(before, after, { context: 1 });
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(applyUnifiedDiff(before, d)).toBe(after);
  });

  it("refuses a diff that does not match the source", () => {
    const d = createUnifiedDiff("a\nb", "a\nc");
    expect(() => applyUnifiedDiff("x\ny", d)).toThrow(/does not apply/);
  });

  it("applies every diff emitted by the Python engine", () => {
    let n = 0;
    for (const page of REPORT.pages)
      for (const imp of page.improvements) {
        const expected = imp.kind === "insert" ? `${imp.before_markdown}\n\n${imp.after_markdown}` : imp.after_markdown;
        expect(applyUnifiedDiff(imp.before_markdown, imp.diff_markdown!)).toBe(expected);
        // the TS generator agrees with difflib on the result
        const ts = createUnifiedDiff(imp.before_markdown, expected);
        expect(applyUnifiedDiff(imp.before_markdown, ts)).toBe(expected);
        n++;
      }
    expect(n).toBeGreaterThan(5);
  });

  it("regenerates patches when the payload has none", () => {
    const imp = { ...REPORT.pages[0].improvements[0], diff_markdown: undefined, diff_html: undefined };
    const p = improvementPatches(imp, WEAK);
    expect(p.markdown.startsWith("--- a/blog/espresso-rehberi.md\n+++ b/blog/espresso-rehberi.md")).toBe(true);
    expect(p.html).toContain("+++ b/blog/espresso-rehberi.html");
  });
});

describe("autogeoToActionItems", () => {
  const items = autogeoToActionItems(REPORT);

  it("emits valid, prioritized ActionItems with copy-paste diffs", () => {
    expect(items.length).toBeGreaterThan(5);
    const parsed = auditResultSchema.shape.actionItems.parse(items);
    expect(parsed).toHaveLength(items.length);
    for (const i of items) {
      expect(i.ruleId.startsWith("autogeo.")).toBe(true);
      expect(ACTION_CATEGORIES).toContain(i.category);
      expect(ACTION_IMPACTS).toContain(i.impact);
      expect(ACTION_EFFORTS).toContain(i.effort);
      expect(i.targetUrl.startsWith("https://shop.example.com/")).toBe(true);
    }
    const prios = items.map((i) => i.priority);
    expect([...prios].sort((a, b) => b - a)).toEqual(prios);
    // (ruleId, targetUrl) is unique -> stable reconciliation across audits
    expect(new Set(items.map((i) => `${i.ruleId}|${i.targetUrl}`)).size).toBe(items.length);
  });

  it("covers all six metrics for weak content and nothing for strong content", () => {
    const weak = items.filter((i) => i.targetUrl === WEAK).map((i) => i.ruleId);
    for (const m of AUTOGEO_METRICS) expect(weak).toContain(`autogeo.${m}`);
    expect(weak).toContain("autogeo.comparison_table");
    expect(items.filter((i) => i.targetUrl === STRONG)).toHaveLength(0);
  });

  it("puts block-level improvements and a combined patch in details", () => {
    const stats = items.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.statistics")!;
    const d = stats.details as {
      snippet: { language: string; code: string; instructions: string };
      improvements: { diffMarkdown: string; diffHtml: string; afterMarkdown: string; metrics: string[] }[];
      score: number;
    };
    expect(d.snippet.language).toBe("diff");
    expect(d.snippet.code).toContain("+++ b/blog/espresso-rehberi.md");
    expect(d.improvements.length).toBeGreaterThan(1);
    // the engine rewrites a Turkish page with Turkish placeholders
    expect(d.improvements.some((i) => i.afterMarkdown.includes("([Kaynak, Yıl](https://kaynak-adresi))"))).toBe(true);
    expect(d.improvements.every((i) => i.diffHtml.includes(".html"))).toBe(true);
    expect(stats.title).toMatch(/^Statistics and numeric data: \d+ improvements — \/blog\/espresso-rehberi$/);
    expect(stats.description).toMatch(/^Statistics and numeric data score \d+\/100\. /);
    expect(stats.description).toMatch(/Estimated visibility gain: \+\d+\.\d%\./);
    expect(stats.description).toMatch(/These patches also improve: .*Keyword stuffing\.$/);
    expect(d.snippet.instructions).toBe("Fill in the bracketed placeholders ([NUMBER], [X]% …) with verified figures and their sources.");
  });

  it("writes titles, descriptions and snippet instructions in the requested locale; ids, scores and diffs stay", () => {
    const tr = autogeoToActionItems(REPORT, { locale: "tr" });
    expect(tr).toHaveLength(items.length);
    const structure = (list: typeof items) =>
      list.map((i) => ({ ruleId: i.ruleId, targetUrl: i.targetUrl, category: i.category, impact: i.impact, effort: i.effort, priority: i.priority }));
    expect(structure(tr)).toEqual(structure(items));
    const stats = tr.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.statistics")!;
    const enStats = items.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.statistics")!;
    expect(stats.title).toMatch(/^İstatistik ve sayısal veri: \d+ iyileştirme — \/blog\/espresso-rehberi$/);
    expect(stats.description).toMatch(/^İstatistik ve sayısal veri skoru \d+\/100\. /);
    expect(stats.description).toMatch(/Tahmini görünürlük kazancı: \+%\d+\.\d\./);
    expect(stats.description).toContain("Bu yamalar ayrıca şunları da iyileştirir: ");
    expect((stats.details.snippet as { instructions: string }).instructions).toBe("Köşeli parantezli [SAYI]/[%ORAN] alanlarını doğrulanmış rakamlarla ve kaynağıyla doldurun.");
    expect((stats.details as { snippet: { code: string } }).snippet.code).toBe((enStats.details as { snippet: { code: string } }).snippet.code);
    expect(tr.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.comparison_table")!.title).toBe("Karşılaştırma tablosu ekleyin — /blog/espresso-rehberi");
    expect(items.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.comparison_table")!.title).toBe("Add a comparison table — /blog/espresso-rehberi");
  });

  it("titles a metric without block-level improvements as needing work and pluralises the count", () => {
    const base = REPORT.pages[0];
    const page = { ...base, improvements: [], metrics: { ...base.metrics, citations: { ...base.metrics.citations, score: 20 } } };
    const weak = autogeoToActionItems({ ...REPORT, pages: [page] }).find((i) => i.ruleId === "autogeo.citations")!;
    expect(weak.title).toBe("Authoritative source citations: needs work — /blog/espresso-rehberi");
    expect(autogeoToActionItems({ ...REPORT, pages: [page] }, { locale: "tr" }).find((i) => i.ruleId === "autogeo.citations")!.title).toBe(
      "Yetkili kaynak gösterimi zayıf — /blog/espresso-rehberi",
    );
    const one = { ...base, improvements: [base.improvements.find((i) => i.metrics?.includes("keyword_stuffing"))!] };
    expect(autogeoToActionItems({ ...REPORT, pages: [one] }).find((i) => i.ruleId === "autogeo.keyword_stuffing")!.title).toBe(
      "Keyword stuffing: 1 improvement — /blog/espresso-rehberi",
    );
  });

  it("has a catalog entry for every metric (label + instructions) in every locale", () => {
    for (const m of AUTOGEO_METRICS) {
      expect(AUTOGEO_METRIC_INFO[m].labelKey).toBe(`autogeo.metric.${m}.label`);
      expect(AUTOGEO_METRIC_INFO[m].instructionsKey).toBe(`autogeo.metric.${m}.instructions`);
      for (const t of [serverT("en"), serverT("tr")]) {
        expect(t(AUTOGEO_METRIC_INFO[m].labelKey)).not.toBe(AUTOGEO_METRIC_INFO[m].labelKey);
        expect(t(AUTOGEO_METRIC_INFO[m].instructionsKey)).not.toBe(AUTOGEO_METRIC_INFO[m].instructionsKey);
      }
    }
  });

  it("flags severe keyword stuffing as high impact and attaches the page capsule", () => {
    const stuffing = items.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.keyword_stuffing")!;
    expect(stuffing.impact).toBe("high");
    const capsule = items.find((i) => i.targetUrl === WEAK && i.ruleId === "autogeo.answer_capsules")!;
    expect(capsule.details.answerCapsule).toMatchObject({ text: expect.any(String) });
  });

  it("respects maxItems", () => {
    expect(autogeoToActionItems(REPORT, { maxItems: 3 })).toHaveLength(3);
    expect(autogeoToActionItems(REPORT, { maxItems: 0 })).toHaveLength(0);
  });

  it("summarizes per-page scores without diffs", () => {
    const s = summarizeAutoGeo(REPORT);
    expect(s.pageCount).toBe(4);
    expect(Object.keys(s.metrics).sort()).toEqual([...AUTOGEO_METRICS].sort());
    expect(s.pages.find((p) => p.url === STRONG)!.score).toBeGreaterThanOrEqual(85);
    expect(JSON.stringify(s)).not.toContain("+++ b/");
  });

  it("rejects malformed payloads", () => {
    expect(autoGeoReportSchema.safeParse({ score: 120, pages: [] }).success).toBe(false);
    expect(autoGeoReportSchema.safeParse({ score: 50, pages: [{ url: "x", score: 10, metrics: {}, improvements: [{ kind: "bogus" }] }] }).success).toBe(false);
  });
});

describe("AutoGEO ingestion via POST /api/sites/[id]/audit/[auditId]/result", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());

  const rctx = (id: string, auditId: string) => ({ params: Promise.resolve({ id, auditId }) });
  async function ingest(siteId: string, body: unknown) {
    const job = await startAudit(siteId, { trigger: "manual" });
    const res = await result.POST(
      req(`/api/sites/${siteId}/audit/${job.audit.id}/result`, { method: "POST", body }),
      rctx(siteId, job.audit.id),
    );
    expect(res.status).toBe(200);
    return { auditId: job.audit.id, body: await res.json() };
  }
  const autogeoOpen = (siteId: string) =>
    prisma.actionItem.count({ where: { siteId, ruleId: { startsWith: "autogeo." }, status: "open" } });

  it("stores AutoGEO action items + metrics summary and serves them on GET /autogeo", async () => {
    const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
    const { auditId, body } = await ingest(site.id, { ...AUDIT, autogeo: RAW });
    const expected = autogeoToActionItems(REPORT).length;
    expect(body.autogeo).toMatchObject({ score: REPORT.score, actionItems: expected });
    expect(body.autogeo.suggestions.created).toBeGreaterThan(0);
    expect(body.actionItems.created).toBe(AUDIT.actionItems.length + expected);

    const audit = await prisma.geoAudit.findUniqueOrThrow({ where: { id: auditId } });
    expect((audit.metrics as { autogeo: { score: number } }).autogeo.score).toBe(REPORT.score);

    const res = await autogeoRoute.GET(req(`/api/sites/${site.id}/autogeo`), ctx(site.id));
    const data = await res.json();
    expect(data.auditId).toBe(auditId);
    expect(data.summary.pages).toHaveLength(4);
    expect(data.items).toHaveLength(expected);
    expect(data.items[0].details.snippet.language).toBe("diff");
  });

  it("keeps AutoGEO items when a payload lacks AutoGEO data and resolves fixed pages", async () => {
    const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
    await ingest(site.id, { ...AUDIT, autogeo: RAW });
    const before = await autogeoOpen(site.id);

    const second = await ingest(site.id, AUDIT); // older crawler: no autogeo key
    expect(second.body.actionItems.resolved).toBe(0);
    expect(await autogeoOpen(site.id)).toBe(before);

    // weak blog page rewritten: it no longer appears in the report
    const fixed = { ...RAW, pages: RAW.pages.filter((p: { url: string }) => p.url !== WEAK) };
    const third = await ingest(site.id, { ...AUDIT, autogeo: fixed });
    const weakCount = autogeoToActionItems(REPORT).filter((i) => i.targetUrl === WEAK).length;
    expect(third.body.actionItems.resolved).toBe(weakCount);
    expect(await autogeoOpen(site.id)).toBe(before - weakCount);
  });

  it("caps the total number of action items at 500", async () => {
    const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
    const many = Array.from({ length: 498 }, (_, i) => ({ ...AUDIT.actionItems[0], ruleId: `test.r${i}` }));
    const { body } = await ingest(site.id, { ...AUDIT, actionItems: many, autogeo: RAW });
    expect(body.autogeo.actionItems).toBe(2);
    expect(await prisma.actionItem.count({ where: { siteId: site.id } })).toBe(500);
  });

  it("returns 404 for an unknown site", async () => {
    const res = await autogeoRoute.GET(req(`/api/sites/nope/autogeo`), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
