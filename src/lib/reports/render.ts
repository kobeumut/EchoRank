import pdfmake from "pdfmake";
import type { Content } from "pdfmake/interfaces";
import { realpathSync } from "node:fs";
import type { ReportSnapshot } from "./snapshot";
// The bundled font module has no TypeScript declaration; Roboto supports Turkish text.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const roboto = require("pdfmake/fonts/Roboto") as { Roboto: Record<"normal" | "bold" | "italics" | "bolditalics", string> };
const fontFiles = new Set(Object.values(roboto.Roboto).map((path) => realpathSync(path)));
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => {
  try { return fontFiles.has(realpathSync(path)); } catch { return false; }
});
pdfmake.addFonts(roboto);

export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const score = (n: number | null) => n === null ? "Not measured" : String(n);
function sections(r: ReportSnapshot): [string, string[]][] {
  return [
    ["Executive summary", [r.summary]],
    ["Scores & evidence", [
      `GEO ${score(r.scores.geo)} / SEO ${score(r.scores.seo)} / E-E-A-T proxy ${score(r.scores.eeat)}`,
      `Score changes: GEO ${score(r.scores.delta.geo)}, SEO ${score(r.scores.delta.seo)}, E-E-A-T ${score(r.scores.delta.eeat)} points. Audit: ${r.scores.auditedAt ?? "none"}; baseline: ${r.scores.baselineAt ?? "none"}.`,
      `Citations: ${r.visibility.citations}/${r.visibility.checks} checks; previous period ${r.visibility.previousCitations}/${r.visibility.previousChecks}. Citation rate: ${score(r.visibility.citationRate)}${r.visibility.citationRate === null ? "" : "%"}.`,
    ]],
    ["Daily trend (UTC)", r.history.length ? r.history.map((h) => `${h.date} | GEO ${score(h.geo)} | E-E-A-T ${score(h.eeat)} | citations ${h.citations}/${h.checks}`) : ["No observations in this period."]],
    ["Anomaly alerts", r.alerts.length ? r.alerts : ["No alert threshold exceeded (or insufficient evidence)."]],
    [`Pending critical actions (${r.actions.openCount})`, r.actions.open.length ? r.actions.open.map((a) => `${a.title} [${a.status}]${a.targetUrl ? ` — ${a.targetUrl}` : ""}`) : ["None."]],
    [`Resolved critical actions (${r.actions.resolvedCount})`, r.actions.resolved.length ? r.actions.resolved.map((a) => a.title) : ["None resolved in this period."]],
    ["Job execution", r.steps.length ? r.steps.map((s) => `${s.name}: ${s.status} — ${s.detail}`) : ["On-demand report; no checks triggered."]],
    ["Method & limitations", [r.caveats]],
  ];
}
export function renderReportHtml(r: ReportSnapshot): string {
  const e = escapeHtml;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(r.site.title)} — visibility report</title></head><body style="margin:0;background:#eef2f6;color:#172a3a;font-family:Arial,sans-serif;line-height:1.6"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:24px"><table role="presentation" style="max-width:760px;width:100%;margin:auto;background:white;border-collapse:collapse"><tr><td style="padding:32px;background:#102c3b;color:white"><p style="letter-spacing:2px;font-size:12px">AI VISIBILITY / ${r.period.days === 7 ? "WEEKLY" : "DAILY"} BRIEF</p><h1 style="font-size:28px;margin:8px 0">${e(r.site.title)}</h1><p>${e(r.site.url)}<br>${e(r.period.since)} — ${e(r.period.until)}</p></td></tr>${sections(r).map(([title, lines]) => `<tr><td style="padding:16px 32px;border-bottom:1px solid #e4eaf0"><h2 style="font-size:18px;color:#087c72">${e(title)}</h2>${lines.map((line) => `<p style="overflow-wrap:anywhere">${e(line)}</p>`).join("")}</td></tr>`).join("")}<tr><td style="padding:24px 32px;color:#566978;font-size:12px">Generated from recorded observations. Missing measurements are not zero scores.</td></tr></table></td></tr></table></body></html>`;
}
export async function renderReportPdf(r: ReportSnapshot): Promise<Buffer> {
  const content: Content[] = [
    { text: "AI VISIBILITY / EXECUTIVE BRIEF", color: "#087c72", fontSize: 11, bold: true },
    { text: r.site.title, fontSize: 26, bold: true, margin: [0, 12, 0, 6] },
    { text: `${r.site.url}\n${r.period.since} — ${r.period.until}`, color: "#566978", margin: [0, 0, 0, 18] },
  ];
  for (const [title, lines] of sections(r)) content.push(
    { text: title, fontSize: 15, bold: true, color: "#087c72", margin: [0, 16, 0, 6] },
    ...lines.map((text): Content => ({ text, margin: [0, 0, 0, 7] })),
  );
  return pdfmake.createPdf({ content, defaultStyle: { font: "Roboto", fontSize: 10, color: "#172a3a" }, pageMargins: [42, 42, 42, 42], footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 9, color: "#566978" }) }).getBuffer();
}
