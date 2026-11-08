// Reads the scoring engine's GeoAudit.metrics (see docs/geo-scoring.md) with fallbacks for older/sparse rows.

export type PillarCheck = {
  id: string;
  label: string;
  score: number;
  passed: boolean;
  applicable: boolean;
  detail?: string;
  urls?: string[];
  url_count?: number;
};
export type Pillar = { key: string; label: string; score: number; weight?: number; checks: PillarCheck[] };

const PILLAR_FALLBACK: [key: string, metric: string, label: string][] = [
  ["ai_access", "aiAccess", "AI Crawler ve Bot Erişilebilirliği"],
  ["llm_readability", "llmReadability", "LLM Okunabilirlik ve Semantik Yapı"],
  ["eeat", "eeat", "Bilgi Güvenilirliği (E-E-A-T)"],
  ["technical_seo", "technicalSeo", "Teknik SEO"],
];

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function readPillars(metrics: unknown): Pillar[] {
  const m = obj(metrics);
  if (!m) return [];
  const pillars = obj(m.pillars);
  if (pillars) {
    return Object.values(pillars)
      .map(obj)
      .filter((p): p is Record<string, unknown> => !!p && num(p.score) != null)
      .map((p) => ({
        key: String(p.key ?? ""),
        label: String(p.label ?? p.key ?? ""),
        score: num(p.score)!,
        weight: num(p.weight) ?? undefined,
        checks: (Array.isArray(p.checks) ? p.checks : [])
          .map(obj)
          .filter((c): c is Record<string, unknown> => !!c)
          .map((c) => ({
            id: String(c.id ?? ""),
            label: String(c.label ?? c.id ?? ""),
            score: num(c.score) ?? 0,
            passed: c.passed === true,
            applicable: c.applicable !== false,
            detail: typeof c.detail === "string" ? c.detail : undefined,
            urls: Array.isArray(c.urls) ? c.urls.filter((u): u is string => typeof u === "string") : [],
            url_count: num(c.url_count) ?? undefined,
          })),
      }));
  }
  return PILLAR_FALLBACK.filter(([, metric]) => num(m[metric]) != null).map(([key, metric, label]) => ({
    key,
    label,
    score: num(m[metric])!,
    checks: [],
  }));
}

/** AI bot accessibility score: aiAccess pillar, else legacy `crawlerAccess`. */
export function aiAccessScore(metrics: unknown): number | null {
  const m = obj(metrics);
  if (!m) return null;
  return num(m.aiAccess) ?? num(obj(obj(m.pillars)?.ai_access)?.score) ?? num(m.crawlerAccess);
}

export function metricGrade(metrics: unknown): string | null {
  const g = obj(metrics)?.grade;
  return typeof g === "string" ? g : null;
}
