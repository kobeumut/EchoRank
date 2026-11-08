import { handle, HttpError, json, parseBody } from "@/lib/http";
import { runJob } from "@/lib/scheduler/jobs";
import { runJobSchema } from "@/lib/validation";

export const maxDuration = 800;

/**
 * External-cron / manual trigger: { job: "daily" | "weekly" | "reports" | "distribution" | "snapshot", dryRun?, siteId? }.
 * Runs synchronously and returns the JobRun. Real runs make paid LLM calls and send e-mail, so they
 * need API_TOKEN configured (dry runs don't). 409 when the same job is already running.
 */
export const POST = handle<unknown>(async (request) => {
  const input = await parseBody(request, runJobSchema);
  if (!input.dryRun) {
    const token = process.env.API_TOKEN;
    if (!token) throw new HttpError(503, "Configure API_TOKEN before triggering real job runs (or pass dryRun: true)");
    if (request.headers.get("authorization") !== `Bearer ${token}`) throw new HttpError(401, "Unauthorized");
  }
  const run = await runJob(input.job, { trigger: "api", dryRun: input.dryRun, siteId: input.siteId });
  return json(run, run.status === "failed" ? 500 : 200);
});
