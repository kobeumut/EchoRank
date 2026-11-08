import { prisma } from "@/lib/db";
import { handle, json, requireApiToken } from "@/lib/http";
import { getSiteOrThrow } from "@/lib/services/sites";

type Ctx = { params: Promise<{ id: string }> };
export const GET = handle<Ctx>(async (request, { params }) => {
  requireApiToken(request);
  const { id } = await params;
  await getSiteOrThrow(id);
  return json({ items: await prisma.reportRun.findMany({
    where: { siteId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
    select: { id: true, scheduleId: true, frequency: true, status: true, steps: true, deliveries: true, createdAt: true, finishedAt: true },
  }) });
});
