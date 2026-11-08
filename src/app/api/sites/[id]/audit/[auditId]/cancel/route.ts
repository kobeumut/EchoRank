import { handle, json } from "@/lib/http";
import { cancelAudit } from "@/lib/services/audit";

type Ctx = { params: Promise<{ id: string; auditId: string }> };

/** Cancels a queued or running audit: stops the engine process and frees the site for a new audit. 409 when it is already finished. */
export const POST = handle<Ctx>(async (_req, { params }) => {
  const { id, auditId } = await params;
  return json({ audit: await cancelAudit(id, auditId) });
});
