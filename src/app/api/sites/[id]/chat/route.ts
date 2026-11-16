import { apiToken } from "@/lib/auth";
import { authorizeModelCalls, handle, json, parseBody } from "@/lib/http";
import { localeFromRequest } from "@/lib/i18n/request";
import { askSiteChat, chatOptions, paidChatProvider, siteChatInput } from "@/lib/services/site-chat";
import { getSiteOrThrow } from "@/lib/services/sites";

type Ctx = { params: Promise<{ id: string }> };
// A CLI answer may take up to LLM_CLI_TIMEOUT_MS (max 300 s).
export const maxDuration = 320;

/** Which models can answer (names only). `apiAllowed`: API-key models may answer (API_TOKEN set); CLI ones always can. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  await getSiteOrThrow((await params).id);
  const options = await chatOptions();
  const apiAllowed = !!apiToken();
  return json({ ...options, apiAllowed, enabled: apiAllowed || options.providers.some((p) => p.resolved.cli) });
});

/** Same rule as visibility checks: API-key calls need API_TOKEN, CLI calls do not (see authorizeModelCalls). */
export const POST = handle<Ctx>(async (request, { params }) => {
  const input = await parseBody(request, siteChatInput);
  await authorizeModelCalls(request, () => paidChatProvider(input), "using the site assistant");
  return json(await askSiteChat((await params).id, input, localeFromRequest(request)));
});
