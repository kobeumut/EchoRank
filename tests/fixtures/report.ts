import type { ReportSnapshot } from "../../src/lib/reports/snapshot";

/** Synthetic example only; no claim about a live website. */
export const sampleReport: ReportSnapshot = {
  version: 1,
  site: { id: "sample", title: "Örnek Mağaza — DEMO", url: "https://example.com" },
  period: { days: 7, since: "2026-11-01T06:00:00.000Z", until: "2026-11-08T06:00:00.000Z" },
  summary: "AI citation visibility increased by 20 percentage points (40% to 60%) on 10 matched model/query pairs.",
  scores: { geo: 74, seo: 82, eeat: 68, auditedAt: "2026-11-08T05:00:00.000Z", baselineAt: "2026-10-31T05:00:00.000Z", delta: { geo: 9, seo: 3, eeat: 5 } },
  visibility: { checks: 10, citations: 6, previousChecks: 10, previousCitations: 4, citationRate: 60, matchedPairs: 10, currentRate: 60, previousRate: 40, change: 20 },
  history: [{ date: "2026-11-02", geo: 65, eeat: 63, citations: 2, checks: 4, citationRate: 50 }, { date: "2026-11-08", geo: 74, eeat: 68, citations: 4, checks: 6, citationRate: 67 }],
  alerts: ["Other-source candidate comparison.example rose 20 percentage points (not a verified competitor)."],
  steps: [{ name: "crawl-graph-eeat", status: "ok", detail: "Synthetic completed full audit" }, { name: "llm-visibility", status: "ok", detail: "10 synthetic observations" }, { name: "indexnow", status: "ok", detail: "Synthetic key-file check; not proof of indexing" }],
  actions: { openCount: 1, resolvedCount: 1, open: [{ id: "a", title: "Add author identity to expert articles", status: "open", targetUrl: "https://example.com/guides" }], resolved: [{ id: "b", title: "Restore AI crawler access", status: "resolved", targetUrl: null }] },
  caveats: "DEMO / synthetic data. Provider-reported citations; E-E-A-T is a rule-based trust proxy, not fact verification. Competitor domains are candidates only. Missing measurements are not zero.",
};
