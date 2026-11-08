import { handle, json, parseQuery } from "@/lib/http";
import { buildPeriodicReport } from "@/lib/reports/builder";
import { reportFilename, reportLinks } from "@/lib/reports/dispatch";
import { renderReportHtml, renderReportText } from "@/lib/reports/html";
import { renderReportPdf } from "@/lib/reports/pdf";
import { reportSummaryQuerySchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Executive report for the last day / week: ?frequency=weekly&format=json|html|pdf|text[&download=1] */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const { frequency, format, download } = parseQuery(request, reportSummaryQuerySchema);
  const report = await buildPeriodicReport(id, frequency);
  const disposition = (ext: "pdf" | "html") => `${download ? "attachment" : "inline"}; filename="${reportFilename(report, ext)}"`;
  const headers = { "cache-control": "private, no-store" };
  switch (format) {
    case "html":
      return new Response(renderReportHtml(report, { pdfUrl: reportLinks(id, frequency).pdf }), {
        headers: { ...headers, "content-type": "text/html; charset=utf-8", ...(download && { "content-disposition": disposition("html") }) },
      });
    case "pdf":
      return new Response(new Uint8Array(renderReportPdf(report)), {
        headers: { ...headers, "content-type": "application/pdf", "content-disposition": disposition("pdf") },
      });
    case "text":
      return new Response(renderReportText(report), { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    default:
      return json(report);
  }
});
