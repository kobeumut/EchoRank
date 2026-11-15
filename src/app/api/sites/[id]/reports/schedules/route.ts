import { prisma } from "@/lib/db";
import { handle, json, parseBody, requireApiToken } from "@/lib/http";
import { createSchedule, serializeSchedule } from "@/lib/services/reports";
import { getSiteOrThrow } from "@/lib/services/sites";
import { createScheduleSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (request, { params }) => {
  requireApiToken(request);
  const { id } = await params;
  await getSiteOrThrow(id);
  const items = await prisma.scheduledReport.findMany({ where: { siteId: id }, orderBy: { createdAt: "asc" } });
  return json({ items: items.map(serializeSchedule) });
});

export const POST = handle<Ctx>(async (request, { params }) => {
  requireApiToken(request);
  const { id } = await params;
  return json(await createSchedule(id, await parseBody(request, createScheduleSchema)), 201);
});
