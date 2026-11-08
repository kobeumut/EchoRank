import { handle, json, parseBody } from "@/lib/http";
import { updateActionItemSchema, updateActionItemStatus } from "@/lib/services/audit-results";

type Ctx = { params: Promise<{ id: string; actionId: string }> };

/** Changes an action item's status (open | in_progress | resolved | dismissed). */
export const PATCH = handle<Ctx>(async (request, { params }) => {
  const { id, actionId } = await params;
  const { status } = await parseBody(request, updateActionItemSchema);
  return json(await updateActionItemStatus(id, actionId, status));
});
