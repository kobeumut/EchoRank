import { handle, json } from "@/lib/http";
import { applySuggestionToCms } from "@/lib/services/autogeo-suggestions";

type Ctx = { params: Promise<{ id: string; suggestionId: string }> };

/**
 * "Apply to CMS": sends the suggestion to the site's syndication webhooks as a signed `autogeo.suggestion.applied`
 * event and marks it applied. `configured: false` when no webhook is set up (nothing sent, status unchanged);
 * 502 with `details.deliveries` when every webhook failed.
 */
export const POST = handle<Ctx>(async (_request, { params }) => {
  const { id, suggestionId } = await params;
  return json(await applySuggestionToCms(id, suggestionId));
});
