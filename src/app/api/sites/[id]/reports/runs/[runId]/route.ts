import { z } from "zod";
import { prisma } from "@/lib/db";
import { handle, HttpError, parseQuery, requireApiToken } from "@/lib/http";
import { renderReportHtml, renderReportPdf } from "@/lib/reports/render";
import type { ReportSnapshot } from "@/lib/reports/snapshot";

type Ctx = { params: Promise<{ id: string; runId: string }> };
export const GET = handle<Ctx>(async (request, { params }) => {
  requireApiToken(request);
  const { id, runId } = await params;
  const { format } = parseQuery(request, z.object({ format: z.enum(["json", "html", "pdf"]).default("json") }));
  const run = await prisma.reportRun.findFirst({ where: { id: runId, siteId: id } });
  if (!run) throw new HttpError(404, "Report not found");
  if (!run.snapshot) throw new HttpError(409, "Report snapshot is not available");
  const snapshot = run.snapshot as unknown as ReportSnapshot;
  const headers: Record<string, string> = { "cache-control": "private, no-store" };
  if (format === "json") return Response.json({ ...run, snapshot }, { headers });
  headers["content-disposition"] = `attachment; filename="visibility-${run.id}.${format}"`;
  headers["x-content-type-options"] = "nosniff";
  if (format === "html") {
    headers["content-type"] = "text/html; charset=utf-8";
    headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    return new Response(renderReportHtml(snapshot), { headers });
  }
  headers["content-type"] = "application/pdf";
  return new Response(new Uint8Array(await renderReportPdf(snapshot)), { headers });
});
