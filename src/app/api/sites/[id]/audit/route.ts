import { after } from "next/server";
import { handle, json, parseBody } from "@/lib/http";
import { localeFromRequest } from "@/lib/i18n/request";
import { executeAudit, getAuditRunner, listAudits, startAudit } from "@/lib/services/audit";
import { startAuditSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Lists recent audits (with their crawl session state and estimated progress). `runner` tells whether this
 * server executes audits itself (GEO_AUDIT_BIN); without it a queued audit waits for an external worker.
 */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return json({ items: await listAudits(id), runner: !!getAuditRunner() });
});

/**
 * Queues a new crawl + audit. 202 Accepted; poll GET for progress. The scoring engine writes its text in the
 * language of this request (`?lang=` / `locale` cookie / `Accept-Language`, default English).
 */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const job = await startAudit(id, await parseBody(request, startAuditSchema), undefined, localeFromRequest(request));
  const hasRunner = !!getAuditRunner();
  if (hasRunner) after(() => executeAudit(job));
  return json(
    {
      audit: job.audit,
      crawlSession: job.crawlSession,
      execution: hasRunner ? "started" : "queued",
    },
    202,
  );
});
