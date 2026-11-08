import { handle, json, parseBody } from "@/lib/http";
import { applyAuditResult, auditResultSchema } from "@/lib/services/audit-results";

type Ctx = { params: Promise<{ id: string; auditId: string }> };

/**
 * Ingests the scoring engine output for an audit (`geo-audit --db-records`, optionally with
 * `crawl` = `--crawl-records`): stores scores/metrics and reconciles "Ne Yapılmalı?" action items.
 */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id, auditId } = await params;
  const input = await parseBody(request, auditResultSchema);
  return json(await applyAuditResult(id, auditId, input));
});
