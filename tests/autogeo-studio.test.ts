import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { markdownToHtml, parseMarkdownTable } from "@/lib/autogeo/markdown";
import {
  addedSignals,
  annotate,
  capsuleFit,
  collectCapsules,
  collectTables,
  countWords,
  impactLabel,
  impactOfGain,
  insertedPart,
  ruleTypeLabel,
  sideBySideDiff,
  signalLabel,
  signalTags,
  SIGNAL_TAGS,
  simulateScore,
  suggestionStatusLabel,
  wordDiff,
  type StudioSuggestion,
} from "@/lib/dashboard/autogeo-studio";
import { getMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translate";
import { autoGeoReportSchema } from "@/lib/services/autogeo";
import { storeAutoGeoReport } from "@/lib/services/autogeo-suggestions";
import * as applyRoute from "@/app/api/sites/[id]/autogeo/[suggestionId]/apply/route";
import { req, resetDb } from "./helpers";

const RAW = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/autogeo-report.json"), "utf8"));

const tEn = createTranslator(getMessages("en"), "en");
const tTr = createTranslator(getMessages("tr"), "tr", getMessages("en"));

describe("markdown -> html", () => {
  it("renders paragraphs, headings, lists, links and escapes html", () => {
    const html = markdownToHtml("## Heading\n\nText **bold** and [Source, Year](https://source-url) <script>.\n\n- a\n- b\n\n1. x");
    expect(html).toBe(
      '<h2>Heading</h2>\n<p>Text <strong>bold</strong> and <a href="https://source-url">Source, Year</a> &lt;script&gt;.</p>\n<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n<ol>\n  <li>x</li>\n</ol>',
    );
  });
  it("drops script links and renders quotes with attribution", () => {
    expect(markdownToHtml("[x](javascript:alert(1))")).toBe("<p>x</p>");
    expect(markdownToHtml("> Coffee takes patience.\n> — [Full Name], [Title]")).toBe(
      "<blockquote>\n  <p>Coffee takes patience.</p>\n  <footer>— <cite>[Full Name], [Title]</cite></footer>\n</blockquote>",
    );
  });
  it("renders and parses GFM tables", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | [VALUE] |";
    expect(parseMarkdownTable(md)).toEqual([["A", "B"], ["1", "[VALUE]"]]);
    expect(markdownToHtml(md)).toContain("<thead><tr><th>A</th><th>B</th></tr></thead>");
    expect(markdownToHtml(md)).toContain("<tr><td>1</td><td>[VALUE]</td></tr>");
    expect(parseMarkdownTable("no table")).toBeNull();
  });
});

describe("diff", () => {
  it("diffs words inside a changed line", () => {
    const { left, right } = wordDiff("most people love it", "%[PERCENT] people love it");
    expect(left).toEqual([{ text: "most", kind: "removed" }, { text: " people love it", kind: "same" }]);
    expect(right[0]).toEqual({ text: "%[PERCENT]", kind: "added" });
  });
  it("diffs Turkish text with non-ASCII letters (deliberately Turkish sample)", () => {
    const { left, right } = wordDiff("çoğu kişi onu sever", "%[ORAN] kişi onu sever");
    expect(left).toEqual([{ text: "çoğu", kind: "removed" }, { text: " kişi onu sever", kind: "same" }]);
    expect(right[0]).toEqual({ text: "%[ORAN]", kind: "added" });
  });
  it("aligns side-by-side rows: same, changed, added", () => {
    const rows = sideBySideDiff("> Quote.", "> Quote.\n> — [Full Name]");
    expect(rows.map((r) => r.type)).toEqual(["same", "added"]);
    expect(rows[1]).toMatchObject({ left: null, right: { no: 2 } });
    const changed = sideBySideDiff("a\nb old\nc", "a\nb new\nc");
    expect(changed.map((r) => r.type)).toEqual(["same", "changed", "same"]);
  });
});

describe("GEO signals", () => {
  it("tags citations, placeholders, statistics and quotes", () => {
    const text = "%[PERCENT] of people at 15 bar ([Source, Year](https://source-url)) in 2024";
    const pieces = annotate([{ text, kind: "same" }]).filter((p) => p.tag);
    expect(pieces.map((p) => [p.tag, p.text])).toEqual([
      ["placeholder", "%[PERCENT]"],
      ["stat", "15 bar"],
      ["citation", "[Source, Year](https://source-url)"],
    ]);
    expect(signalTags("> Coffee is a way of life.")[3]).toBe("quote");
  });
  it("tags English unit words as part of a statistic", () => {
    const pieces = annotate([{ text: "Used by 3 million people", kind: "same" }]).filter((p) => p.tag);
    expect(pieces.map((p) => [p.tag, p.text])).toEqual([["stat", "3 million"]]);
  });
  it("tags Turkish units and the Turkish attribution form (deliberately Turkish samples)", () => {
    const text = "%[ORAN] kişi 15 bar ile ([Kaynak, Yıl](https://kaynak-adresi)) 2024 yılında; Ahmet Yılmaz'a göre 3 milyon kişi";
    const pieces = annotate([{ text, kind: "same" }]).filter((p) => p.tag);
    expect(pieces.map((p) => [p.tag, p.text])).toEqual([
      ["placeholder", "%[ORAN]"],
      ["stat", "15 bar"],
      ["citation", "[Kaynak, Yıl](https://kaynak-adresi)"],
      ["citation", "Ahmet Yılmaz'a göre"],
      ["stat", "3 milyon"],
    ]);
  });
  it("counts the signals a rewrite adds", () => {
    expect(addedSignals("Many people like it.", "[NUMBER] people like it ([Source, Year](https://x.org)). 40% growth.")).toMatchObject({ citation: 1, placeholder: 1, stat: 1 });
  });
  it("localises signal, rule type, status and impact labels", () => {
    expect(SIGNAL_TAGS.map((tag) => signalLabel(tEn, tag))).toEqual(["Statistic", "Expert quote", "Source citation", "Placeholder to fill"]);
    expect(signalLabel(tTr, "citation")).toBe("Kaynak atfı");
    expect(ruleTypeLabel(tEn, "answer_capsule")).toBe("Answer Capsule");
    expect(ruleTypeLabel(tTr, "answer_capsule")).toBe("Yanıt Kapsülü");
    expect(ruleTypeLabel(tEn, "something_new")).toBe("something_new");
    expect(suggestionStatusLabel(tEn, "superseded")).toBe("Superseded");
    expect(suggestionStatusLabel(tTr, "applied")).toBe("Uygulandı");
    expect(impactLabel(tEn, "medium")).toBe("Medium");
    expect(impactLabel(tTr, "high")).toBe("Yüksek");
  });
});

describe("capsules, tables, impact", () => {
  const row = (o: Partial<StudioSuggestion>): StudioSuggestion => ({
    id: "s1", pageUrl: "https://x.com/a", ruleType: "answer_capsule", ruleId: null, title: null, originalSnippet: "", suggestedSnippet: "",
    diffMarkdown: null, expectedGain: 10, status: "pending", actionItemId: null, createdAt: "", updatedAt: "", ...o,
  });
  it("bands impact like the action items", () => {
    expect([impactOfGain(19.2), impactOfGain(6), impactOfGain(2)]).toEqual(["high", "medium", "low"]);
  });
  it("counts words and grades capsule length", () => {
    expect(countWords("Espresso [NUMBER] bar ([Source, Year](https://x)).")).toBe(5);
    expect(capsuleFit(45, tEn)).toEqual({ tone: "good", label: "Ideal (40-60)" });
    expect(capsuleFit(35, tEn)).toEqual({ tone: "warning", label: "Slightly short" });
    expect(capsuleFit(70, tEn).label).toBe("Slightly long");
    expect(capsuleFit(13, tEn)).toEqual({ tone: "critical", label: "Too short" });
    expect(capsuleFit(90, tTr)).toEqual({ tone: "critical", label: "Çok uzun" });
  });
  it("extracts the inserted part, heading and tables", () => {
    const ins = row({ originalSnippet: "## Process", suggestedSnippet: "## Process\n\nProcess: discovery.", title: "Answer capsule for 'Process'" });
    expect(insertedPart(ins)).toBe("Process: discovery.");
    const rewrite = row({ id: "s2", originalSnippet: "This is good.", suggestedSnippet: "Espresso is good.", title: "Answer capsule for 'What is espresso?'" });
    const caps = collectCapsules([ins, rewrite, row({ id: "s3", status: "dismissed", suggestedSnippet: "x" })], [
      { id: "i1", ruleId: "autogeo.answer_capsules", targetUrl: "https://x.com/a", details: { answerCapsule: { markdown: "Page summary.", html: "<p>Page summary.</p>" } } },
    ]);
    expect(caps.map((c) => [c.heading, c.markdown, c.source])).toEqual([
      ["Process", "Process: discovery.", "suggestion"],
      ["What is espresso?", "Espresso is good.", "suggestion"],
      [null, "Page summary.", "page"],
    ]);
    const table = row({ ruleType: "comparison_table", originalSnippet: "## H", suggestedSnippet: "## H\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" });
    const items = [{ id: "i2", ruleId: "autogeo.comparison_table", targetUrl: "https://x.com/a", details: { comparisonTable: { markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |" } } }];
    const tables = collectTables([table], items, tEn);
    expect(tables).toHaveLength(1); // same table from suggestion and action item is deduped
    expect(tables[0].rows).toEqual([["A", "B"], ["1", "2"]]);
    expect(tables[0].title).toBe("Table"); // no stored title: falls back to the (localised) rule type label
    expect(collectTables([], items, tEn)[0].title).toBe("Comparison table");
    expect(collectTables([], items, tTr)[0].title).toBe("Karşılaştırma tablosu");
  });
  it("reads the heading from suggestion titles stored in either language (deliberately Turkish sample)", () => {
    const tr = row({ originalSnippet: "Bu iyi.", suggestedSnippet: "Espresso iyidir.", title: "'Espresso nedir?' için yanıt kapsülü" });
    const [card] = collectCapsules([tr], []);
    expect(card.heading).toBe("Espresso nedir?");
    expect(card.markdown).toBe("Espresso iyidir.");
  });
});

describe("score simulator", () => {
  const pages = [{ url: "a", score: 40 }, { url: "b", score: 80 }];
  const sugg = [
    { id: "1", pageUrl: "a", expectedGain: 50, status: "pending" },
    { id: "2", pageUrl: "a", expectedGain: 50, status: "applied" },
    { id: "3", pageUrl: "b", expectedGain: 20, status: "dismissed" },
  ];
  it("projects applied and selected gains with diminishing returns", () => {
    const none = simulateScore(60, pages, sugg, new Set());
    // applied: page a closes 50% of 60 → +30, averaged over 2 pages → +15
    expect(none).toMatchObject({ current: 60, withApplied: 75, projected: 75, appliedGain: 15, selectedGain: 0 });
    const sel = simulateScore(60, pages, sugg, new Set(["1", "3"]));
    // a: 1-(0.5*0.5)=75% of 60 = 45 → +22.5; dismissed suggestion ignored
    expect(sel).toMatchObject({ projected: 82.5, selectedGain: 7.5 });
    expect(sel.pages).toEqual([{ url: "a", current: 40, projected: 85, selected: 15 }]);
  });
  it("never exceeds 100 and handles empty data", () => {
    const max = simulateScore(99, [{ url: "a", score: 99 }], [{ id: "1", pageUrl: "a", expectedGain: 1000, status: "pending" }], new Set(["1"]));
    expect(max.projected).toBeLessThanOrEqual(100);
    expect(simulateScore(null, [], [], new Set())).toMatchObject({ current: 0, projected: 0 });
  });
});

describe("POST /autogeo/:id/apply (Apply to CMS)", () => {
  type Call = { url: string; init: RequestInit & { body?: string } };
  let calls: Call[] = [];
  const mockFetch = (status: number) => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: Call["init"]) => {
      calls.push({ url: String(url), init });
      return new Response(status < 300 ? "ok" : "nope", { status });
    }));
  };
  beforeEach(async () => {
    await resetDb();
    process.env.ALLOW_PRIVATE_NETWORK_TARGETS = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
  });
  afterAll(() => prisma.$disconnect());

  async function setup(settings: object = {}, integrations: object = {}) {
    const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop", settings, integrations } });
    await storeAutoGeoReport(site.id, autoGeoReportSchema.parse(RAW));
    const s = await prisma.autoGeoSuggestion.findFirstOrThrow({ where: { siteId: site.id, ruleType: "quotes", pageUrl: { contains: "espresso-rehberi" } } });
    const apply = async (id = s.id, siteId = site.id) => {
      const res = await applyRoute.POST(req(`/api/sites/${siteId}/autogeo/${id}/apply`, { method: "POST" }), { params: Promise.resolve({ id: siteId, suggestionId: id }) });
      return { status: res.status, body: await res.json() };
    };
    return { site, s, apply };
  }

  it("reports configured:false and leaves the status alone without webhooks", async () => {
    const { s, apply } = await setup();
    mockFetch(200);
    const { status, body } = await apply();
    expect(status).toBe(200);
    expect(body).toMatchObject({ configured: false, applied: false, deliveries: [] });
    expect(calls).toHaveLength(0);
    expect((await prisma.autoGeoSuggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("pending");
  });

  it("pushes a signed event to the CMS webhook and marks the suggestion applied", async () => {
    const { s, apply } = await setup({ distribution: { syndication: { webhooks: [{ url: "https://cms.example.com/hook" }] } } }, { webhookSecret: "s3cret" });
    mockFetch(200);
    const { status, body } = await apply();
    expect(status).toBe(200);
    expect(body).toMatchObject({ configured: true, applied: true, suggestion: { status: "applied" }, deliveries: [{ status: "sent", httpStatus: 200 }] });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-aiv-event"]).toBe("autogeo.suggestion.applied");
    expect(headers["x-aiv-signature"]).toBe(`sha256=${createHmac("sha256", "s3cret").update(`${headers["x-aiv-timestamp"]}.${calls[0].init.body}`).digest("hex")}`);
    const payload = JSON.parse(calls[0].init.body!);
    expect(payload.suggestion).toMatchObject({ id: s.id, pageUrl: s.pageUrl, ruleType: "quotes" });
    expect(payload.suggestion.suggested.html).toContain("<blockquote>");
    expect(await prisma.platformSubmission.count({ where: { platform: "webhook", status: "sent" } })).toBe(1);
  });

  it("returns 502 and keeps the status when every webhook fails; 404 for foreign ids", async () => {
    const { s, apply } = await setup({ distribution: { syndication: { webhooks: [{ url: "https://cms.example.com/hook" }] } } });
    mockFetch(500);
    const { status, body } = await apply();
    expect(status).toBe(502);
    expect(body.details.deliveries[0]).toMatchObject({ status: "failed", httpStatus: 500 });
    expect((await prisma.autoGeoSuggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("pending");
    const other = await prisma.site.create({ data: { url: "https://other.example.com", title: "O" } });
    expect((await apply(s.id, other.id)).status).toBe(404);
  });
});
