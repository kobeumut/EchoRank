import { handle, json, parseBody } from "@/lib/http";
import { sendScheduledReport } from "@/lib/reports/dispatch";
import { getScheduleOrThrow } from "@/lib/services/reports";
import { sendReportSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string; scheduleId: string }> };
export const maxDuration = 120;

/** Sends (or with dryRun: simulates) the schedule's report now. Does not move nextRunAt. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id, scheduleId } = await params;
  await getScheduleOrThrow(id, scheduleId);
  const input = await parseBody(request, sendReportSchema);
  return json(await sendScheduledReport(scheduleId, input));
});
