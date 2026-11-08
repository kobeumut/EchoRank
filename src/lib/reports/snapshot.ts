import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getSiteOrThrow } from "../services/sites";

const DAY = 86_400_000;
const rate = (hits: number, total: number) => total ? Math.round(hits / total * 100) : null;
const diff = (a: number | null, b: number | null) => a === null || b === null ? null : a - b;
export type Step = { name: string; status: "ok" | "failed" | "skipped"; detail: string };

/** Immutable evidence, equal adjacent UTC windows; never treat missing observations as zero. */
export async function buildSnapshot(siteId: string, days: number, until = new Date(), steps: Step[] = []) {
  const site = await getSiteOrThrow(siteId);
  const since = new Date(until.getTime() - days * DAY);
  const before = new Date(since.getTime() - days * DAY);
  const [audits, baseline, checks, open, resolved, openCount, resolvedCount] = await Promise.all([
    prisma.geoAudit.findMany({ where: { siteId, status: "completed", createdAt: { gte: since, lte: until } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1001 }),
    prisma.geoAudit.findFirst({ where: { siteId, status: "completed", createdAt: { lt: since } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    prisma.llmVisibilityRecord.findMany({ where: { siteId, checkedAt: { gte: before, lte: until } }, orderBy: [{ checkedAt: "asc" }, { id: "asc" }], take: 10001 }),
    prisma.actionItem.findMany({ where: { siteId, impact: "high", status: { in: ["open", "in_progress"] } }, orderBy: [{ priority: "desc" }, { id: "asc" }], take: 100 }),
    prisma.actionItem.findMany({ where: { siteId, impact: "high", status: "resolved", resolvedAt: { gte: since, lte: until } }, orderBy: [{ resolvedAt: "desc" }, { id: "asc" }], take: 100 }),
    prisma.actionItem.count({ where: { siteId, impact: "high", status: { in: ["open", "in_progress"] } } }),
    prisma.actionItem.count({ where: { siteId, impact: "high", status: "resolved", resolvedAt: { gte: since, lte: until } } }),
  ]);
  if (audits.length > 1000 || checks.length > 10000) throw new Error("Report evidence limit exceeded; shorten the reporting window");
  const current = checks.filter((c) => c.checkedAt >= since);
  const previous = checks.filter((c) => c.checkedAt < since);
  const cited = (rows: typeof checks) => rows.filter((c) => c.citationStatus === "cited").length;
  // ponytail: last observation per model/query, so changed batch sizes do not manufacture a trend.
  const latestByQuery = (rows: typeof checks) => new Map(rows.map((c) => [JSON.stringify([c.model, c.query]), c]));
  const cur = latestByQuery(current), prev = latestByQuery(previous);
  const matched = [...cur.keys()].filter((key) => prev.has(key));
  const currentRate = rate(matched.filter((key) => cur.get(key)!.citationStatus === "cited").length, matched.length);
  const previousRate = rate(matched.filter((key) => prev.get(key)!.citationStatus === "cited").length, matched.length);
  const change = diff(currentRate, previousRate);
  const latest = audits.at(-1);
  const scores = {
    geo: latest?.geoScore ?? null, seo: latest?.seoScore ?? null, eeat: latest?.eeatScore ?? null,
    auditedAt: latest?.createdAt.toISOString() ?? null,
    baselineAt: baseline?.createdAt.toISOString() ?? null,
    delta: { geo: diff(latest?.geoScore ?? null, baseline?.geoScore ?? null), seo: diff(latest?.seoScore ?? null, baseline?.seoScore ?? null), eeat: diff(latest?.eeatScore ?? null, baseline?.eeatScore ?? null) },
  };
  const candidateRates = (rows: typeof checks) => {
    const counts = new Map<string, number>();
    for (const c of rows) {
      const meta = c.responseMeta as { competitorDomains?: unknown } | null;
      if (Array.isArray(meta?.competitorDomains)) for (const domain of new Set(meta.competitorDomains)) {
        if (typeof domain === "string") counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
    }
    return new Map([...counts].map(([key, value]) => [key, rate(value, rows.length)!]));
  };
  const nowCandidates = candidateRates(matched.map((key) => cur.get(key)!));
  const oldCandidates = candidateRates(matched.map((key) => prev.get(key)!));
  const alerts: string[] = [];
  if (scores.delta.geo !== null && scores.delta.geo <= -10) alerts.push(`GEO score dropped ${-scores.delta.geo} points since the pre-period audit.`);
  if (scores.delta.eeat !== null && scores.delta.eeat <= -10) alerts.push(`E-E-A-T proxy dropped ${-scores.delta.eeat} points.`);
  if (matched.length >= 5 && change !== null && change <= -20) alerts.push(`Citation rate dropped ${-change} percentage points on ${matched.length} matched model/query pairs.`);
  if (matched.length >= 5) for (const [domain, value] of nowCandidates) {
    const delta = value - (oldCandidates.get(domain) ?? 0);
    if (delta >= 20) alerts.push(`Other-source candidate ${domain} rose ${delta} percentage points (not a verified competitor).`);
  }
  const summary = change === null
    ? "Insufficient comparable observations to calculate AI visibility change."
    : `AI citation visibility ${change >= 0 ? "increased" : "decreased"} by ${Math.abs(change)} percentage points (${previousRate}% to ${currentRate}%) on ${matched.length} matched model/query pairs.`;
  const history = [...new Set([...audits.map((a) => a.createdAt.toISOString().slice(0, 10)), ...current.map((c) => c.checkedAt.toISOString().slice(0, 10))])].sort().map((date) => {
    const a = audits.filter((a) => a.createdAt.toISOString().startsWith(date)).at(-1);
    const rows = current.filter((c) => c.checkedAt.toISOString().startsWith(date));
    return { date, geo: a?.geoScore ?? null, eeat: a?.eeatScore ?? null, citations: cited(rows), checks: rows.length, citationRate: rate(cited(rows), rows.length) };
  });
  const action = (a: (typeof open)[number]) => ({ id: a.id, title: a.title, status: a.status, targetUrl: a.targetUrl });
  return {
    version: 1, site: { id: site.id, title: site.title, url: site.url },
    period: { days, since: since.toISOString(), until: until.toISOString() }, summary, scores,
    visibility: { checks: current.length, citations: cited(current), previousChecks: previous.length, previousCitations: cited(previous), citationRate: rate(cited(current), current.length), matchedPairs: matched.length, currentRate, previousRate, change },
    history, alerts, steps, actions: { openCount, resolvedCount, open: open.map(action), resolved: resolved.map(action) },
    caveats: "Citation evidence is provider-reported; E-E-A-T is a rule-based trust proxy, not factual verification. Other-source domains are only competitor candidates. Comparisons require matching model/query pairs; provider model/configuration changes can still affect results. Scores are not carried forward when no audit ran in the period. Action lists show at most 100 items per section.",
  };
}
export type ReportSnapshot = Awaited<ReturnType<typeof buildSnapshot>>;
export const snapshotJson = (snapshot: ReportSnapshot): Prisma.InputJsonValue => JSON.parse(JSON.stringify(snapshot));
