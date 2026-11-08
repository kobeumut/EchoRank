import { handle, json, parseBody } from "@/lib/http";
import { deleteSchedule, getScheduleOrThrow, updateSchedule } from "@/lib/services/reports";
import { updateScheduleSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string; scheduleId: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id, scheduleId } = await params;
  return json(await getScheduleOrThrow(id, scheduleId));
});

export const PATCH = handle<Ctx>(async (request, { params }) => {
  const { id, scheduleId } = await params;
  return json(await updateSchedule(id, scheduleId, await parseBody(request, updateScheduleSchema)));
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const { id, scheduleId } = await params;
  await deleteSchedule(id, scheduleId);
  return new Response(null, { status: 204 });
});
