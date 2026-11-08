import { z } from "zod";
import { prisma } from "@/lib/db";
import { handle, HttpError, json, parseBody, requireApiToken } from "@/lib/http";
import { computeNextRun } from "@/lib/services/reports";

type Ctx = { params: Promise<{ id: string; scheduleId: string }> };
/** Disable or resume without changing destinations; claimed work must first finish. */
export const PATCH = handle<Ctx>(async (request, { params }) => {
  requireApiToken(request);
  const { id, scheduleId } = await params;
  const { enabled } = await parseBody(request, z.object({ enabled: z.boolean() }).strict());
  return json(await prisma.$transaction(async (tx) => {
    const schedule = await tx.scheduledReport.findFirst({ where: { id: scheduleId, siteId: id } });
    if (!schedule) throw new HttpError(404, "Schedule not found");
    if (schedule.claimId) throw new HttpError(409, "Schedule is running; wait or recover its interrupted claim");
    const changed = await tx.scheduledReport.updateMany({
      where: { id: scheduleId, siteId: id, claimId: null },
      data: { enabled, nextRunAt: enabled ? computeNextRun(schedule.frequency as "daily" | "weekly") : null },
    });
    if (!changed.count) throw new HttpError(409, "Schedule was claimed concurrently");
    return tx.scheduledReport.findUniqueOrThrow({ where: { id: scheduleId } });
  }));
});
