// Estimated progress of an audit run. The scoring engine (`geo-audit --progress`) names the stage it is in
// and, while crawling, how many pages are done out of how many are known so far; everything else is a
// fixed share of the run. It is an estimate, not a promise: sites differ wildly in size.

export const AUDIT_STAGES = ["crawl", "graph", "signals", "bots", "scoring", "ingest"] as const;
export type AuditStage = (typeof AUDIT_STAGES)[number];

/** Share of the whole run each stage covers, as [from, to] percent. Crawling dominates. */
const RANGE: Record<AuditStage, readonly [number, number]> = {
  crawl: [2, 60],
  graph: [60, 66],
  signals: [66, 76],
  bots: [76, 88],
  scoring: [88, 94],
  ingest: [94, 99],
};

export const isAuditStage = (value: unknown): value is AuditStage => AUDIT_STAGES.includes(value as AuditStage);

/** 0-99 while running (100 is reserved for a finished audit). Outside the crawl a stage counts from its start. */
export function auditPercent(stage: string | null | undefined, done = 0, total = 0): number {
  if (!isAuditStage(stage)) return 0;
  const [from, to] = RANGE[stage];
  if (stage !== "crawl") return from;
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return Math.round(from + (to - from) * fraction);
}
