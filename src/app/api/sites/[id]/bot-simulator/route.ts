import { handle, json, parseBody } from "@/lib/http";
import { botSimulationInput, getSiteBotSimulation, runSiteBotSimulation } from "@/lib/services/bot-simulator";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 120;

/** Latest audit's live AI-crawler simulation summary (per bot outcome, render mode, token weight, findings). */
export const GET = handle<Ctx>(async (_request, { params }) => json(await getSiteBotSimulation((await params).id)));

/**
 * Runs a live simulation now: fetches the site's homepage (or up to 5 same-host `urls`) as GPTBot, ClaudeBot,
 * PerplexityBot, Google-Extended, Applebot-Extended (or the given `bots`) and returns the full report with
 * WAF / CSR findings and copy-paste Cloudflare / nginx / Apache allow rules.
 */
export const POST = handle<Ctx>(async (request, { params }) => {
  const input = await parseBody(request, botSimulationInput);
  return json(await runSiteBotSimulation((await params).id, input));
});
