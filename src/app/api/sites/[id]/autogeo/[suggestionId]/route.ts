import { handle, json, parseBody } from "@/lib/http";
import { updateSuggestionSchema, updateSuggestionStatus } from "@/lib/services/autogeo-suggestions";

type Ctx = { params: Promise<{ id: string; suggestionId: string }> };

/** { "status": "applied" | "dismissed" | "pending" } — decisions survive re-analysis. */
export const PATCH = handle<Ctx>(async (request, { params }) => {
  const { id, suggestionId } = await params;
  const { status } = await parseBody(request, updateSuggestionSchema);
  return json(await updateSuggestionStatus(id, suggestionId, status));
});
