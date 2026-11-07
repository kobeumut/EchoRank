import { after } from "next/server";
import { handle, json, parseBody } from "@/lib/http";
import { executeAudit, getAuditRunner, listAudits, startAudit } from "@/lib/services/audit";
import { startAuditSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Lists recent audits (with their crawl session state). */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return json({ items: await listAudits(id) });
});

/** Queues a new crawl + audit. 202 Accepted; poll GET for progress. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const job = await startAudit(id, await parseBody(request, startAuditSchema));
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
