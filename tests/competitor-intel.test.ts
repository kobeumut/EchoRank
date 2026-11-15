import { describe, expect, it } from "vitest";
import {
  brandRows, citeMagnetTip, dominantSentiment, filterGaps, gapDomains, gapsCsv, intentLabel, sentimentLabel, siteRank, siteTrendDelta, somCsv, toCsv, trendSeries,
} from "@/lib/dashboard/competitor-intel";
import type { CitationGap, CompetitorReport, CompetitorSnapshot } from "@/components/dashboard/types";
import { getMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translate";

const tEn = createTranslator(getMessages("en"), "en");
const tTr = createTranslator(getMessages("tr"), "tr", getMessages("en"));

const snap = (domain: string, share: number, extra: Partial<CompetitorSnapshot> = {}): CompetitorSnapshot => ({
  competitorDomain: domain, competitorName: domain.split(".")[0], shareOfModel: share, mentionShare: null, citedQueriesCount: 0,
  gapQueriesCount: 0, topCitedUrls: null, sentimentScore: null, samples: 4, windowDays: 30, lastCheckedAt: "2026-11-08T00:00:00Z", ...extra,
});
const gap = (query: string, intent: CitationGap["intent"], model: string, domains: string[], factors: string[] = []): CitationGap => ({
  query, intent, model, checkedAt: "2026-11-08T00:00:00Z", targetMentioned: false, targetPage: null, intentSource: "classifier",
  competitors: domains.map((domain) => ({ domain, urls: [`https://${domain}/p`], missingFactors: factors })),
});

const report = {
  site: snap("shop.test", 25, { citedQueriesCount: 2, topCitedUrls: [{ url: "https://shop.test/a", count: 2 }] }),
  competitors: [snap("rival.test", 50), snap("other.test", 25)],
  perModel: { chatgpt: { samples: 2, shares: [{ domain: "shop.test", citationShare: 40, recommendationShare: null, citations: 2 }] } },
  trend: {
    granularity: "day",
    points: [
      { start: "2026-11-01", samples: 2, shares: [{ domain: "shop.test", citationShare: 10 }, { domain: "rival.test", citationShare: 90 }] },
      { start: "2026-11-02", samples: 2, shares: [{ domain: "shop.test", citationShare: null }] },
      { start: "2026-11-03", samples: 2, shares: [{ domain: "shop.test", citationShare: 35.5 }] },
    ],
  },
} as unknown as CompetitorReport;

describe("competitor intel helpers", () => {
  it("builds brand rows with site first and ranks the site", () => {
    const rows = brandRows(report);
    expect(rows.map((r) => [r.domain, r.isSite, r.color])).toEqual([
      ["shop.test", true, "var(--series-1)"], ["rival.test", false, "var(--series-2)"], ["other.test", false, "var(--series-3)"],
    ]);
    expect(siteRank(rows)).toBe(2); // tie with other.test shares rank 2
    expect(siteRank([])).toBeNull();
  });

  it("aligns trend series to buckets and measures the site delta", () => {
    const series = trendSeries(report, brandRows(report));
    expect(series[0].values).toEqual([10, null, 35.5]);
    expect(series[1].values).toEqual([90, null, null]);
    expect(siteTrendDelta(series)).toBe(25.5);
    expect(siteTrendDelta([{ ...series[0], values: [5] }])).toBeNull();
  });

  it("filters gaps by intent, model, competitor and text; orders matrix columns by wins", () => {
    const gaps = [
      gap("Best coffee machine", "comparative", "chatgpt", ["rival.test", "other.test"]),
      gap("coffee machine price", "transactional", "gemini", ["rival.test"]),
      gap("Is Shop reliable", "reputation", "chatgpt", ["other.test"]),
    ];
    expect(filterGaps(gaps, { intent: "comparative" }).map((g) => g.query)).toEqual(["Best coffee machine"]);
    expect(filterGaps(gaps, { model: "chatgpt", competitor: "other.test" })).toHaveLength(2);
    expect(filterGaps(gaps, { search: "BEST" })).toHaveLength(1);
    expect(filterGaps(gaps, { search: "is shop" })).toHaveLength(1); // dotted capital I must still fold to i
    expect(filterGaps(gaps, { intent: "all", model: "all", competitor: "all", search: "" })).toHaveLength(3);
    expect(gapDomains(gaps)).toEqual([{ domain: "other.test", count: 2 }, { domain: "rival.test", count: 2 }]);
  });

  it("folds Turkish dotted/dotless i when searching (deliberately Turkish sample queries)", () => {
    const gaps = [gap("En iyi kahve makinesi", "comparative", "chatgpt", ["rival.test"]), gap("Işıklı tabela fiyatı", "transactional", "gemini", ["rival.test"])];
    expect(filterGaps(gaps, { search: "İYİ" }).map((g) => g.query)).toEqual(["En iyi kahve makinesi"]);
    expect(filterGaps(gaps, { search: "ışıklı" })).toHaveLength(1);
    expect(filterGaps(gaps, { search: "IŞIKLI" })).toHaveLength(1);
  });

  it("maps Cite-Magnet factors and picks the dominant tone", () => {
    expect(citeMagnetTip("no_data_tables", tEn).label).toBe("Data table");
    expect(citeMagnetTip("no_data_tables", tTr).label).toBe("Veri tablosu");
    expect(citeMagnetTip("custom", tEn)).toEqual({ label: "custom", tip: "A standout feature of the competitor page for this query." });
    expect(intentLabel(tEn, "reputation")).toBe("Brand");
    expect(intentLabel(tTr, "transactional")).toBe("İşlemsel");
    expect(sentimentLabel(tEn, "negative")).toBe("Negative / Risky");
    expect(sentimentLabel(tTr, "unknown")).toBe("Belirsiz");
    expect(dominantSentiment({ positive: 2, neutral: 3, negative: 3, unknown: 9 })).toBe("negative");
    expect(dominantSentiment({ positive: 0, neutral: 0, negative: 0, unknown: 4 })).toBe("unknown");
  });

  it("writes escaped CSV with a formula-injection guard", () => {
    expect(toCsv(["a", "b"], [["x,y", '=SUM(1)'], [-1, null], [["p", "q"], 'say "hi"']])).toBe(
      'a,b\r\n"x,y",\'=SUM(1)\r\n-1,\r\np | q,"say ""hi"""\r\n',
    );
    const som = somCsv(report, ["chatgpt", "gemini"]).split("\r\n");
    expect(som[0]).toBe("domain,name,is_site,share_of_model,mention_share,cited_queries,gap_queries,sentiment_score,som_chatgpt,som_gemini,top_cited_urls");
    expect(som[1]).toBe("shop.test,shop,true,25,,2,0,,40,,https://shop.test/a");
    const gaps = gapsCsv([gap("q", "comparative", "chatgpt", ["rival.test"], ["no_data_tables"])]).split("\r\n");
    expect(gaps[1]).toBe("q,comparative,chatgpt,2026-11-08T00:00:00Z,false,,rival.test,https://rival.test/p,no_data_tables");
  });
});
