import { z } from "zod";
import { apiToken, isSameOrigin } from "@/lib/auth";
import { handle, HttpError, json, parseBody, parseQuery } from "@/lib/http";
import { getLlmSettings, llmSettingsInput, saveLlmSettings } from "@/lib/services/app-settings";

// Listing codex / agy models spawns the CLI.
export const maxDuration = 60;

/** Per-CLI model choice plus the models each installed CLI offers. `?refresh=1` re-asks the CLIs. */
export const GET = handle(async (request) => {
  const { refresh } = parseQuery(request, z.object({ refresh: z.enum(["0", "1"]).optional() }));
  return json(await getLlmSettings({ refresh: refresh === "1" }));
});

/** The proxy guards this with API_TOKEN; without one, only the dashboard itself may change what a CLI runs. */
export const PUT = handle(async (request) => {
  if (!apiToken() && !isSameOrigin(request)) throw new HttpError(403, "Without API_TOKEN, settings can only be changed from the dashboard");
  return json(await saveLlmSettings(await parseBody(request, llmSettingsInput)));
});
