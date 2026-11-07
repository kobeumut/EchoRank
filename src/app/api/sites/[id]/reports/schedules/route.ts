import { prisma } from "@/lib/db";
import { handle, json, parseBody } from "@/lib/http";
import { createSchedule } from "@/lib/services/reports";
import { getSiteOrThrow } from "@/lib/services/sites";
import { createScheduleSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  await getSiteOrThrow(id);
  return json({ items: await prisma.scheduledReport.findMany({ where: { siteId: id }, orderBy: { createdAt: "asc" } }) });
});

export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await createSchedule(id, await parseBody(request, createScheduleSchema)), 201);
});
