import pdfmake from "pdfmake";
import type { Content } from "pdfmake/interfaces";
import { realpathSync } from "node:fs";
import { ACTION_STATUSES } from "../constants";
import { DEFAULT_LOCALE, toLocale, type Locale } from "../i18n/config";
import { serverT } from "../i18n/request";
import type { Translator } from "../i18n/translate";
import type { ReportSnapshot } from "./snapshot";
// The bundled font module has no TypeScript declaration; Roboto covers the Latin Extended-A glyphs Turkish needs (ç ğ ı ö ş ü İ).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const roboto = require("pdfmake/fonts/Roboto") as { Roboto: Record<"normal" | "bold" | "italics" | "bolditalics", string> };
const fontFiles = new Set(Object.values(roboto.Roboto).map((path) => realpathSync(path)));
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => {
  try { return fontFiles.has(realpathSync(path)); } catch { return false; }
});
pdfmake.addFonts(roboto);

export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Language a stored snapshot was generated in (`locale` is absent from snapshots created before localization: English). */
export const reportLocale = (r: ReportSnapshot): Locale => toLocale((r as { locale?: string }).locale) ?? DEFAULT_LOCALE;

function sections(r: ReportSnapshot, t: Translator): [string, string[]][] {
  const score = (n: number | null) => n === null ? t("reports.score.notMeasured") : String(n);
  const none = t("reports.none");
  const actionStatus = (status: string) => (ACTION_STATUSES as readonly string[]).includes(status) ? t(`labels.actionStatus.${status}`) : status;
  const citationRate = `${score(r.visibility.citationRate)}${r.visibility.citationRate === null ? "" : "%"}`;
  return [
    [t("reports.section.summary"), [r.summary]],
    [t("reports.section.scores"), [
      t("reports.scores.line", { geo: score(r.scores.geo), seo: score(r.scores.seo), eeat: score(r.scores.eeat) }),
      t("reports.scores.changes", { geo: score(r.scores.delta.geo), seo: score(r.scores.delta.seo), eeat: score(r.scores.delta.eeat), audit: r.scores.auditedAt ?? none, baseline: r.scores.baselineAt ?? none }),
      t("reports.citations.line", { citations: r.visibility.citations, checks: r.visibility.checks, previousCitations: r.visibility.previousCitations, previousChecks: r.visibility.previousChecks, rate: citationRate }),
    ]],
    [t("reports.section.trend"), r.history.length ? r.history.map((h) => t("reports.trend.row", { date: h.date, geo: score(h.geo), eeat: score(h.eeat), citations: h.citations, checks: h.checks })) : [t("reports.trend.empty")]],
    [t("reports.section.alerts"), r.alerts.length ? r.alerts : [t("reports.alerts.empty")]],
    [t("reports.section.pending", { count: r.actions.openCount }), r.actions.open.length ? r.actions.open.map((a) => `${a.title} [${actionStatus(a.status)}]${a.targetUrl ? ` — ${a.targetUrl}` : ""}`) : [t("reports.actions.none")]],
    [t("reports.section.resolved", { count: r.actions.resolvedCount }), r.actions.resolved.length ? r.actions.resolved.map((a) => a.title) : [t("reports.actions.noneResolved")]],
    [t("reports.section.job"), r.steps.length ? r.steps.map((s) => `${s.name}: ${t(`reports.status.${s.status}`)} — ${s.detail}`) : [t("reports.job.empty")]],
    [t("reports.section.method"), [r.caveats]],
  ];
}
/** HTML e-mail / download. Rendered in `locale` (default: the language the snapshot was generated in). */
export function renderReportHtml(r: ReportSnapshot, locale: Locale = reportLocale(r)): string {
  const e = escapeHtml;
  const t = serverT(locale);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(t("reports.html.title", { site: r.site.title }))}</title></head><body style="margin:0;background:#eef2f6;color:#172a3a;font-family:Arial,sans-serif;line-height:1.6"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:24px"><table role="presentation" style="max-width:760px;width:100%;margin:auto;background:white;border-collapse:collapse"><tr><td style="padding:32px;background:#102c3b;color:white"><p style="letter-spacing:2px;font-size:12px">${e(t(r.period.days === 7 ? "reports.html.brief.weekly" : "reports.html.brief.daily"))}</p><h1 style="font-size:28px;margin:8px 0">${e(r.site.title)}</h1><p>${e(r.site.url)}<br>${e(r.period.since)} — ${e(r.period.until)}</p></td></tr>${sections(r, t).map(([title, lines]) => `<tr><td style="padding:16px 32px;border-bottom:1px solid #e4eaf0"><h2 style="font-size:18px;color:#087c72">${e(title)}</h2>${lines.map((line) => `<p style="overflow-wrap:anywhere">${e(line)}</p>`).join("")}</td></tr>`).join("")}<tr><td style="padding:24px 32px;color:#566978;font-size:12px">${e(t("reports.html.footer"))}</td></tr></table></td></tr></table></body></html>`;
}
export async function renderReportPdf(r: ReportSnapshot, locale: Locale = reportLocale(r)): Promise<Buffer> {
  const t = serverT(locale);
  const content: Content[] = [
    { text: t("reports.pdf.title"), color: "#087c72", fontSize: 11, bold: true },
    { text: r.site.title, fontSize: 26, bold: true, margin: [0, 12, 0, 6] },
    { text: `${r.site.url}\n${r.period.since} — ${r.period.until}`, color: "#566978", margin: [0, 0, 0, 18] },
  ];
  for (const [title, lines] of sections(r, t)) content.push(
    { text: title, fontSize: 15, bold: true, color: "#087c72", margin: [0, 16, 0, 6] },
    ...lines.map((text): Content => ({ text, margin: [0, 0, 0, 7] })),
  );
  return pdfmake.createPdf({ content, defaultStyle: { font: "Roboto", fontSize: 10, color: "#172a3a" }, pageMargins: [42, 42, 42, 42], footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 9, color: "#566978" }) }).getBuffer();
}
