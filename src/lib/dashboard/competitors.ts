// Competitor citation analysis over stored LlmVisibilityRecord rows (responseMeta from runVisibility).

export type VisibilityRecordLike = {
  model: string;
  query: string;
  citationStatus: string;
  responseMeta?: unknown;
};

export type CompetitorRow = {
  domain: string;
  isSite: boolean;
  /** Answers that cite this domain. */
  answers: number;
  /** answers / total answers, 0-100. */
  share: number;
  models: string[];
  queries: string[];
};

function meta(r: VisibilityRecordLike): { competitorDomains: string[]; citedUrls: string[] } {
  const m = r.responseMeta;
  if (!m || typeof m !== "object" || Array.isArray(m)) return { competitorDomains: [], citedUrls: [] };
  const o = m as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { competitorDomains: strings(o.competitorDomains), citedUrls: strings(o.citedUrls) };
}

export function siteHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Ranks domains cited next to (or instead of) the site. The site itself is included as a reference row
 * (cited answers) so the table reads "who gets cited more than us".
 */
export function aggregateCompetitors(records: VisibilityRecordLike[], siteUrl: string, limit = 20): CompetitorRow[] {
  const total = records.length;
  if (!total) return [];
  const own = siteHost(siteUrl);
  const rows = new Map<string, { answers: number; models: Set<string>; queries: Set<string> }>();
  const bump = (domain: string, r: VisibilityRecordLike) => {
    const row = rows.get(domain) ?? { answers: 0, models: new Set(), queries: new Set() };
    row.answers++;
    row.models.add(r.model);
    row.queries.add(r.query);
    rows.set(domain, row);
  };
  for (const r of records) {
    const m = meta(r);
    for (const d of new Set(m.competitorDomains.map((x) => x.toLowerCase()))) if (d && d !== own) bump(d, r);
    if (r.citationStatus === "cited") bump(own, r);
  }
  const out = [...rows.entries()].map(([domain, v]) => ({
    domain,
    isSite: domain === own,
    answers: v.answers,
    share: Math.round((v.answers / total) * 100),
    models: [...v.models].sort(),
    queries: [...v.queries],
  }));
  out.sort((a, b) => b.answers - a.answers || Number(b.isSite) - Number(a.isSite) || a.domain.localeCompare(b.domain));
  const top = out.slice(0, limit);
  const siteRow = out.find((r) => r.isSite);
  if (siteRow && !top.includes(siteRow)) top.push(siteRow);
  return top;
}
