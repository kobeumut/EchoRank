import { handle, json, parseQuery } from "@/lib/http";
import { listJobRuns } from "@/lib/scheduler/jobs";
import { resolveSchedules } from "@/lib/scheduler/cron";
import { jobListQuerySchema } from "@/lib/validation";

/** Recent scheduled-job runs (?job=daily&limit=50) and the configured cron expressions. */
export const GET = handle<unknown>(async (request) => {
  const q = parseQuery(request, jobListQuerySchema);
  return json({ schedules: resolveSchedules(), items: await listJobRuns(q) });
});
