// What the dashboard shows for an audit that is still active. Pure, so the states are testable.

/** Engine stage → catalog key of the label the dashboard shows. */
export const AUDIT_STAGE_KEYS: Record<string, string> = {
  crawl: "sites.audit.stage.crawl",
  graph: "sites.audit.stage.graph",
  signals: "sites.audit.stage.signals",
  bots: "sites.audit.stage.bots",
  scoring: "sites.audit.stage.scoring",
  ingest: "sites.audit.stage.ingest",
};

/** A queued audit that has not started after this long (with a runner configured) is probably orphaned. */
export const STUCK_QUEUE_MS = 60_000;

type AuditLike = {
  status: string;
  createdAt: string;
  crawlSession: { status: string; progress?: number; stage?: string | null; pagesCrawled: number; pagesTotal?: number | null; startedAt: string | null } | null;
};

export type AuditProgressView =
  /** Queued and this server has no runner (GEO_AUDIT_BIN): nothing is executing it, only an external worker could. */
  | { kind: "no-runner"; waitingMs: number }
  /** Queued, the runner should pick it up any moment; `stuck` when it has been too long. */
  | { kind: "starting"; waitingMs: number; stuck: boolean }
  /** Running. `percent` is an estimate (null = the runner reports no progress); `pages` is set while crawling. */
  | { kind: "running"; percent: number | null; labelKey: string; pages: { done: number; total: number } | null; elapsedMs: number };

export function auditProgressView(audit: AuditLike, runner: boolean | undefined, now: number): AuditProgressView {
  const crawl = audit.crawlSession;
  const running = crawl?.status === "running" || audit.status === "running";
  if (!running) {
    const waitingMs = Math.max(0, now - new Date(audit.createdAt).getTime());
    return runner === false ? { kind: "no-runner", waitingMs } : { kind: "starting", waitingMs, stuck: waitingMs > STUCK_QUEUE_MS };
  }
  const stage = crawl?.stage ?? null;
  const percent = stage ? Math.min(99, Math.max(0, crawl?.progress ?? 0)) : null;
  const total = crawl?.pagesTotal ?? 0;
  const pages = stage === "crawl" && total > 0 ? { done: Math.min(crawl?.pagesCrawled ?? 0, total), total } : null;
  const startedAt = new Date(crawl?.startedAt ?? audit.createdAt).getTime();
  const labelKey = stage ? (AUDIT_STAGE_KEYS[stage] ?? "sites.audit.stage.running") : "sites.audit.stage.starting";
  return { kind: "running", percent, labelKey, pages, elapsedMs: Math.max(0, now - startedAt) };
}
