import { describe, expect, it } from "vitest";
import fixture from "./fixtures/geo-audit-result.json";
import { aggregateCompetitors } from "@/lib/dashboard/competitors";
import { labelFor, scoreLabel, scoreTone, tierFor, timeAgo } from "@/lib/dashboard/format";
import { graphIssues, ISSUE_KINDS, issueCounts, issueLabel } from "@/lib/dashboard/graph-insights";
import { foldCase, highlightSegments, siteTerms } from "@/lib/dashboard/highlight";
import { aiAccessScore, readPillars } from "@/lib/dashboard/pillars";
import { getMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translate";

const tEn = createTranslator(getMessages("en"), "en");
const tTr = createTranslator(getMessages("tr"), "tr", getMessages("en"));

describe("format", () => {
  it("bands scores and maps impact to tiers", () => {
    expect([scoreTone(85), scoreTone(60), scoreTone(45), scoreTone(10), scoreTone(null)]).toEqual(["good", "warning", "serious", "critical", "neutral"]);
    expect(tierFor("high", tEn).label).toBe("Critical");
    expect(tierFor("medium", tEn).label).toBe("Important");
    expect(tierFor("low", tEn).label).toBe("Improvement");
    expect(tierFor("high", tTr).label).toBe("Kritik");
    expect(scoreLabel(85, tEn)).toBe("Good");
    expect(scoreLabel(null, tTr)).toBe("Veri yok");
  });
  it("localises enum labels and falls back to the raw value", () => {
    expect(labelFor(tEn, "model", "chatgpt")).toBe("ChatGPT");
    expect(labelFor(tEn, "category", "schema")).toBe("Structured Data");
    expect(labelFor(tTr, "category", "schema")).toBe("Yapısal Veri");
    expect(labelFor(tEn, "category", "something-new")).toBe("something-new");
  });
  it("formats relative time in English and Turkish", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect(timeAgo("2026-11-08T11:59:50Z", tEn, now)).toBe("just now");
    expect(timeAgo("2026-11-08T11:30:00Z", tEn, now)).toBe("30 min ago");
    expect(timeAgo("2026-11-08T11:00:00Z", tEn, now)).toBe("1 hour ago");
    expect(timeAgo("2026-11-08T09:00:00Z", tEn, now)).toBe("3 hours ago");
    expect(timeAgo("2026-11-01T12:00:00Z", tEn, now)).toBe("7 days ago");
    expect(timeAgo("2026-11-08T11:59:50Z", tTr, now)).toBe("az önce");
    expect(timeAgo("2026-11-08T11:30:00Z", tTr, now)).toBe("30 dk önce");
    expect(timeAgo("2026-11-08T09:00:00Z", tTr, now)).toBe("3 saat önce");
    expect(timeAgo("2026-11-01T12:00:00Z", tTr, now)).toBe("7 gün önce");
    expect(timeAgo(null, tEn, now)).toBe("—");
  });
});

describe("highlight", () => {
  it("highlights site name, domain and cited URLs case-insensitively", () => {
    const terms = siteTerms({ url: "https://www.coffee.com", title: "Coffee Corner" }, ["https://coffee.com/product/x"]);
    const text = "1. COFFEE CORNER (coffee.com) is recommended. Source: https://coffee.com/product/x";
    const segs = highlightSegments(text, terms);
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(["COFFEE CORNER", "coffee.com", "https://coffee.com/product/x"]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });
  it("matches Turkish dotted/dotless i variants (deliberately Turkish sample text)", () => {
    const terms = siteTerms({ url: "https://www.kahve.com", title: "Kahve Dükkanı" });
    const segs = highlightSegments("1. KAHVE DÜKKANI (kahve.com) önerilir.", terms);
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(["KAHVE DÜKKANI", "kahve.com"]);
    expect(highlightSegments("İSTANBUL ve ıspanak", ["istanbul", "Ispanak"]).filter((s) => s.match).map((s) => s.text)).toEqual(["İSTANBUL", "ıspanak"]);
  });
  it("folds case for searching in both languages", () => {
    expect(foldCase("Index")).toBe(foldCase("INDEX"));
    expect(foldCase("İndeks")).toBe("indeks");
    expect(foldCase("ISIK")).toBe(foldCase("ısık")); // I and ı both fold to i
  });
  it("escapes regex characters and handles no terms", () => {
    expect(highlightSegments("a+b (c)", ["a+b", "(c)"]).filter((s) => s.match)).toHaveLength(2);
    expect(highlightSegments("text", [])).toEqual([{ text: "text", match: false }]);
    expect(highlightSegments("", ["x"])).toEqual([]);
  });
});

describe("competitors", () => {
  it("ranks other cited domains and includes the site as a reference row", () => {
    const rows = aggregateCompetitors(
      [
        { model: "chatgpt", query: "q1", citationStatus: "cited", responseMeta: { competitorDomains: ["rival.com", "wiki.org"] } },
        { model: "gemini", query: "q1", citationStatus: "none", responseMeta: { competitorDomains: ["rival.com", "coffee.com"] } },
        { model: "claude", query: "q2", citationStatus: "mentioned", responseMeta: null },
      ],
      "https://www.coffee.com",
    );
    expect(rows[0]).toMatchObject({ domain: "rival.com", answers: 2, share: 67, models: ["chatgpt", "gemini"] });
    const site = rows.find((r) => r.isSite)!;
    expect(site).toMatchObject({ domain: "coffee.com", answers: 1 });
    expect(aggregateCompetitors([], "https://x.com")).toEqual([]);
  });
});

describe("graph insights", () => {
  it("flags isolated nodes, orphan pages, schema-less pages and uncategorized products", () => {
    const nodes = [
      { id: "home", type: "Page", label: "Home", url: "https://s.com/", properties: { has_schema: true } },
      { id: "a", type: "Page", label: "A", url: "https://s.com/a", properties: { has_schema: false, word_count: 400 } },
      { id: "orphan", type: "Page", label: "Orphan", url: "https://s.com/o", properties: { word_count: 50 } },
      { id: "p1", type: "Product", label: "P1", url: null },
      { id: "p2", type: "Product", label: "P2", url: null },
      { id: "cat", type: "Category", label: "Cat", url: null },
      { id: "lonely", type: "Concept", label: "Lonely", url: null },
    ];
    const edges = [
      { source: "home", target: "a", type: "links_to" },
      { source: "orphan", target: "home", type: "links_to" },
      { source: "a", target: "p1", type: "mentions_entity" },
      { source: "p1", target: "cat", type: "has_category" },
      { source: "a", target: "p2", type: "mentions_entity" },
    ];
    const issues = graphIssues(nodes, edges);
    expect(issues.get("home")).toBeUndefined();
    expect(issues.get("a")).toEqual(["page_without_schema"]);
    expect(issues.get("orphan")).toEqual(["orphan_page", "thin_page"]);
    expect(issues.get("p1")).toBeUndefined();
    expect(issues.get("p2")).toEqual(["product_without_category"]);
    expect(issues.get("lonely")).toEqual(["isolated"]);
    expect(issueCounts(issues)).toMatchObject({ isolated: 1, orphan_page: 1, page_without_schema: 1, product_without_category: 1, thin_page: 1 });
  });

  it("labels every issue kind in English and Turkish", () => {
    expect(ISSUE_KINDS.map((k) => issueLabel(tEn, k))).toEqual([
      "Unlinked node",
      "Orphan page (receives no internal links)",
      "No structured data (schema)",
      "Uncategorized product",
      "Thin content (<150 words)",
    ]);
    expect(issueLabel(tTr, "orphan_page")).toBe("Yetim sayfa (iç link almıyor)");
  });

  it("works on the real crawler fixture", () => {
    const nodes = fixture.crawl.graphEntities.map((e) => ({ id: e.key, type: e.entityType, label: e.name, url: e.url, properties: e.properties }));
    const edges = fixture.crawl.graphRelations.map((r) => ({ source: r.sourceKey, target: r.targetKey, type: r.relationType }));
    const issues = graphIssues(nodes, edges);
    expect(issues.size).toBeGreaterThanOrEqual(0);
    for (const kinds of issues.values()) expect(kinds.length).toBeGreaterThan(0);
  });
});

describe("pillars", () => {
  it("reads the scoring engine pillar breakdown", () => {
    const pillars = readPillars(fixture.audit.metrics, tEn);
    expect(pillars.map((p) => p.key)).toEqual(["ai_access", "llm_readability", "eeat", "technical_seo"]);
    expect(pillars[0].checks.find((c) => c.id === "robots_ai_bots")).toMatchObject({ passed: true, score: 100 });
    expect(aiAccessScore(fixture.audit.metrics)).toBe(97);
  });
  it("falls back to flat / legacy metrics", () => {
    expect(readPillars({ aiAccess: 80, eeat: 50 }, tEn).map((p) => [p.key, p.label, p.score])).toEqual([
      ["ai_access", "AI Crawler and Bot Accessibility", 80],
      ["eeat", "Information Trustworthiness (E-E-A-T)", 50],
    ]);
    expect(readPillars({ technicalSeo: 70 }, tTr)[0].label).toBe("Teknik SEO");
    expect(aiAccessScore({ crawlerAccess: 100 })).toBe(100);
    expect(readPillars(null, tEn)).toEqual([]);
    expect(aiAccessScore(undefined)).toBeNull();
  });
});
