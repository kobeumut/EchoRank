import type { ScheduledReport } from "@prisma/client";
import { z } from "zod";
import { publicRequest } from "./outbound";
import { renderReportHtml } from "./render";
import type { ReportSnapshot } from "./snapshot";

export type Delivery = { channel: string; status: "sent" | "failed" | "skipped"; detail: string };
/** Independent attempts; never let one channel suppress the other, never log destination secrets. */
export async function deliverReport(schedule: ScheduledReport, runId: string, report: ReportSnapshot): Promise<Delivery[]> {
  const results: Delivery[] = [];
  const recipients = z.array(z.email()).max(50).safeParse(schedule.recipients ?? []);
  if (!recipients.success) results.push({ channel: "email", status: "failed", detail: "Invalid stored recipients" });
  else if (recipients.data.length) {
    if (!process.env.RESEND_API_KEY || !process.env.REPORT_FROM_EMAIL) results.push({ channel: "email", status: "failed", detail: "Configure RESEND_API_KEY and REPORT_FROM_EMAIL" });
    else {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "Idempotency-Key": `report-${runId}` },
          body: JSON.stringify({ from: process.env.REPORT_FROM_EMAIL, to: recipients.data, subject: `AI visibility: ${report.site.title}`, html: renderReportHtml(report) }),
        });
        await response.body?.cancel();
        results.push({ channel: "email", status: response.ok ? "sent" : "failed", detail: `Resend HTTP ${response.status}` });
      } catch { results.push({ channel: "email", status: "failed", detail: "Email request failed or timed out" }); }
    }
  }
  if (schedule.webhookUrl) {
    try {
      const response = await publicRequest(schedule.webhookUrl, JSON.stringify({
        // Slack uses text, Discord uses content; full immutable evidence is downloadable via the API.
        text: `${report.site.title}: ${report.summary}`.slice(0, 1900),
        content: `${report.site.title}: ${report.summary}`.slice(0, 1900),
        allowed_mentions: { parse: [] }, unfurl_links: false, unfurl_media: false,
      }));
      results.push({ channel: "webhook", status: response.status >= 200 && response.status < 300 ? "sent" : "failed", detail: `Webhook HTTP ${response.status}` });
    } catch { results.push({ channel: "webhook", status: "failed", detail: "Webhook rejected, unavailable, or timed out" }); }
  }
  if (!results.length) results.push({ channel: "none", status: "skipped", detail: "No delivery channel configured" });
  return results;
}
