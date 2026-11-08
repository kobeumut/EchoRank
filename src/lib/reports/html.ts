import type { Anomaly } from "../monitoring/trends";
import { trPct, type PeriodicReport, type ReportAction, type ScoreLine } from "./builder";

// E-mail safe HTML (tables + inline styles, no scripts / external assets / SVG) and plain text.

const C = {
  ink: "#0f172a",
  muted: "#64748b",
  line: "#e2e8f0",
  bg: "#f1f5f9",
  card: "#ffffff",
  brand: "#4f46e5",
  up: "#047857",
  upBg: "#ecfdf5",
  down: "#b91c1c",
  downBg: "#fef2f2",
  flatBg: "#eef2ff",
  warn: "#b45309",
};

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short", timeZone: "UTC" });
export const trDate = (iso: string) => dateFmt.format(new Date(iso));
export const trShortDate = (iso: string) => shortDate.format(new Date(iso));

export const IMPACT_TR: Record<string, string> = { high: "Yüksek", medium: "Orta", low: "Düşük" };
export const CATEGORY_TR: Record<string, string> = {
  crawler: "Tarayıcı erişimi",
  schema: "Yapısal veri",
  content: "İçerik",
  authority: "Otorite / E-E-A-T",
  technical: "Teknik SEO",
};
export const FREQUENCY_TR = { daily: "Günlük", weekly: "Haftalık" } as const;

export function reportSubject(r: PeriodicReport) {
  const arrow = r.headline.direction === "up" ? "▲" : r.headline.direction === "down" ? "▼" : "•";
  const { changePct, changePoints } = r.headline;
  const change = changePct ? ` ${arrow} ${trPct(Math.abs(changePct))}` : changePoints ? ` ${arrow}` : "";
  return `${FREQUENCY_TR[r.frequency]} AI görünürlük raporu — ${r.site.title}${change}`;
}

export function periodLabel(r: PeriodicReport) {
  return r.frequency === "daily" ? trDate(r.period.end) : `${trDate(r.period.start)} – ${trDate(r.period.end)}`;
}

function deltaBadge(delta: number | null, suffix = "") {
  if (delta == null) return `<span style="color:${C.muted};font-size:12px;">—</span>`;
  if (delta === 0) return `<span style="color:${C.muted};font-size:12px;">0${suffix}</span>`;
  const color = delta > 0 ? C.up : C.down;
  return `<span style="color:${color};font-size:12px;font-weight:600;">${delta > 0 ? "▲ +" : "▼ "}${delta}${suffix}</span>`;
}

function kpi(label: string, value: string, delta: string) {
  return `<td width="20%" style="padding:6px;" valign="top">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:8px;">
    <tr><td style="padding:12px 10px 4px;color:${C.muted};font-size:11px;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</td></tr>
    <tr><td style="padding:0 10px;color:${C.ink};font-size:24px;font-weight:700;">${value}</td></tr>
    <tr><td style="padding:2px 10px 12px;">${delta}</td></tr>
  </table></td>`;
}

const scoreValue = (s: ScoreLine) => (s.current == null ? "—" : String(s.current));
const rateValue = (n: number | null) => (n == null ? "—" : trPct(n));

function section(title: string, body: string) {
  return `<tr><td style="padding:20px 24px 0;">
  <h2 style="margin:0 0 10px;font-size:16px;color:${C.ink};">${esc(title)}</h2>${body}</td></tr>`;
}

function table(headers: string[], rows: string[][], align: ("left" | "right")[] = [], widths: (string | undefined)[] = []) {
  const th = headers
    .map((h, i) => `<th align="${align[i] ?? "left"}"${widths[i] ? ` width="${widths[i]}"` : ""} style="padding:8px;border-bottom:2px solid ${C.line};color:${C.muted};font-size:11px;text-transform:uppercase;">${esc(h)}</th>`)
    .join("");
  const tr = rows
    .map(
      (r) =>
        `<tr>${r.map((cell, i) => `<td align="${align[i] ?? "left"}" style="padding:8px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink};" valign="top">${cell}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${C.card};">
<tr>${th}</tr>${tr}</table>`;
}

function bar(value: number | null, color: string) {
  if (value == null) return `<span style="color:${C.muted};">—</span>`;
  const w = Math.max(2, Math.min(100, value));
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
<td width="${w}%" style="background:${color};height:8px;font-size:0;line-height:0;border-radius:4px;">&nbsp;</td>
${w < 100 ? `<td width="${100 - w}%" style="background:${C.line};height:8px;font-size:0;line-height:0;">&nbsp;</td>` : ""}
</tr></table>`;
}

function actionRows(items: ReportAction[], resolved: boolean) {
  return items.map((a) => [
    `<strong>${esc(a.title)}</strong>${a.targetUrl ? `<br><span style="color:${C.muted};font-size:12px;word-break:break-all;">${esc(a.targetUrl)}</span>` : ""}`,
    esc(CATEGORY_TR[a.category] ?? a.category),
    `<span style="color:${a.impact === "high" ? C.down : a.impact === "medium" ? C.warn : C.muted};font-weight:600;">${esc(IMPACT_TR[a.impact] ?? a.impact)}</span>`,
    resolved ? esc(a.resolvedAt ? trShortDate(a.resolvedAt) : "") : a.expectedGain != null ? `+${a.expectedGain}` : "—",
  ]);
}

function anomalyList(items: Anomaly[]) {
  return items
    .map(
      (a) =>
        `<tr><td style="padding:8px 10px;border-left:4px solid ${a.severity === "high" ? C.down : C.warn};background:${a.severity === "high" ? C.downBg : "#fffbeb"};font-size:13px;color:${C.ink};">
<strong>${a.severity === "high" ? "Kritik" : "Uyarı"}:</strong> ${esc(a.message)}</td></tr><tr><td style="height:6px;font-size:0;">&nbsp;</td></tr>`,
    )
    .join("");
}

export interface RenderOptions {
  /** Absolute link to the online report (APP_BASE_URL based), shown as a button. */
  reportUrl?: string | null;
  pdfUrl?: string | null;
}

export function renderReportHtml(r: PeriodicReport, opts: RenderOptions = {}): string {
  const h = r.headline;
  const bannerBg = h.direction === "up" ? C.upBg : h.direction === "down" ? C.downBg : C.flatBg;
  const bannerInk = h.direction === "up" ? C.up : h.direction === "down" ? C.down : C.brand;
  const v = r.visibility;

  const kpis = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${kpi("GEO", scoreValue(r.scores.geo), deltaBadge(r.scores.geo.delta))}
${kpi("SEO", scoreValue(r.scores.seo), deltaBadge(r.scores.seo.delta))}
${kpi("E-E-A-T", scoreValue(r.scores.eeat), deltaBadge(r.scores.eeat.delta))}
${kpi("AI görünürlük", rateValue(v.current.visibilityRate), deltaBadge(v.current.visibilityRate != null && v.previous.visibilityRate != null ? v.current.visibilityRate - v.previous.visibilityRate : null, " puan"))}
${kpi("Model atıfı", String(v.current.cited), deltaBadge(v.previous.totalChecks ? v.current.cited - v.previous.cited : null))}
</tr></table>`;

  const summary = `<ul style="margin:0;padding-left:18px;color:${C.ink};font-size:14px;line-height:1.6;">${r.executiveSummary
    .map((s) => `<li style="margin-bottom:4px;">${esc(s)}</li>`)
    .join("")}</ul>`;

  const trend = r.trend.length
    ? table(
        ["Tarih", "GEO", "SEO", "E-E-A-T", "AI görünürlük", ""],
        r.trend.map((p) => [
          esc(trShortDate(p.date)),
          p.geoScore == null ? "—" : String(p.geoScore),
          p.seoScore == null ? "—" : String(p.seoScore),
          p.eeatScore == null ? "—" : String(p.eeatScore),
          rateValue(p.visibilityRate),
          bar(p.visibilityRate ?? p.geoScore, p.visibilityRate != null ? C.brand : "#94a3b8"),
        ]),
        ["left", "right", "right", "right", "right", "left"],
        [undefined, undefined, undefined, undefined, undefined, "34%"],
      )
    : `<p style="color:${C.muted};font-size:13px;margin:0;">Trend için yeterli veri yok — zamanlanmış denetimler çalıştıkça grafik dolacak.</p>`;

  const perModel = v.perModel.length
    ? table(
        ["Model", "Yanıt", "Atıf", "Bahsetme", "Görünürlük", "Değişim"],
        v.perModel.map((m) => [
          `<strong>${esc(m.model)}</strong>`,
          String(m.current?.total ?? 0),
          String(m.current?.cited ?? 0),
          String(m.current?.mentioned ?? 0),
          m.current ? trPct(m.current.visibilityRate) : "—",
          deltaBadge(m.current && m.previousVisibilityRate != null ? m.current.visibilityRate - m.previousVisibilityRate : null, " puan"),
        ]),
        ["left", "right", "right", "right", "right", "right"],
      )
    : `<p style="color:${C.muted};font-size:13px;margin:0;">Bu dönemde LLM görünürlük kontrolü yapılmadı.</p>`;

  const competitors = v.competitors.length
    ? table(
        ["Rakip alan adı", "Atıf", "Yanıt payı"],
        v.competitors.map((c) => [esc(c.domain), String(c.count), trPct(c.share)]),
        ["left", "right", "right"],
      )
    : "";

  const resolved = r.actions.resolved.length
    ? table(["Aksiyon", "Kategori", "Etki", "Çözüldü"], actionRows(r.actions.resolved, true), ["left", "left", "left", "right"])
    : `<p style="color:${C.muted};font-size:13px;margin:0;">Bu dönemde çözülen aksiyon yok.</p>`;
  const pending = r.actions.pendingCritical.length
    ? table(["Aksiyon", "Kategori", "Etki", "Beklenen kazanç"], actionRows(r.actions.pendingCritical, false), ["left", "left", "left", "right"])
    : `<p style="color:${C.up};font-size:13px;margin:0;">Bekleyen kritik aksiyon yok. 🎉</p>`;

  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;${
      primary ? `background:${C.brand};color:#fff;` : `background:#fff;color:${C.brand};border:1px solid ${C.brand};`
    }">${esc(label)}</a>`;
  const links = [opts.reportUrl && button(opts.reportUrl, "Raporu tarayıcıda aç", true), opts.pdfUrl && button(opts.pdfUrl, "PDF indir", false)]
    .filter(Boolean)
    .join("");

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(reportSubject(r))}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${esc(h.text)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${C.card};border-radius:12px;overflow:hidden;border:1px solid ${C.line};">
<tr><td style="background:${C.ink};padding:22px 24px;">
  <div style="color:#a5b4fc;font-size:12px;letter-spacing:.08em;text-transform:uppercase;">${esc(FREQUENCY_TR[r.frequency])} GEO · SEO · LLM görünürlük raporu</div>
  <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px;">${esc(r.site.title)}</div>
  <div style="color:#cbd5e1;font-size:13px;margin-top:2px;">${esc(r.site.url)} · ${esc(periodLabel(r))}</div>
</td></tr>
<tr><td style="padding:20px 24px 0;">
  <div style="background:${bannerBg};color:${bannerInk};border-radius:8px;padding:14px 16px;font-size:16px;font-weight:600;">${esc(h.text)}</div>
</td></tr>
<tr><td style="padding:12px 18px 0;">${kpis}</td></tr>
${section("Yönetici Özeti", summary)}
${r.anomalies.length ? section("Anormallikler", `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${anomalyList(r.anomalies)}</table>`) : ""}
${section(`Bekleyen kritik aksiyonlar (${r.actions.pendingCount} açık)`, pending)}
${section(`Çözülen aksiyonlar (${r.actions.resolvedCount})`, resolved)}
${section("Model bazında yapay zeka görünürlüğü", perModel)}
${competitors ? section("Yanıtlarda öne çıkan rakipler", competitors) : ""}
${section("Skor trendi", trend)}
${links ? `<tr><td style="padding:20px 24px 0;">${links}</td></tr>` : ""}
<tr><td style="padding:24px;color:${C.muted};font-size:11px;line-height:1.5;">
  Oluşturulma: ${esc(trDate(r.generatedAt))} · Dönem anahtarı: ${esc(r.periodKey)}<br>
  Görünürlük oranı, kontrol edilen yapay zeka yanıtlarında sitenize atıf yapılan veya markanızdan bahsedilen yanıtların payıdır.
  Bu e-postayı zamanlanmış rapor aboneliğiniz nedeniyle alıyorsunuz.
</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderReportText(r: PeriodicReport, opts: RenderOptions = {}): string {
  const v = r.visibility;
  const s = r.scores;
  const fmtScore = (l: ScoreLine) => (l.current == null ? "—" : `${l.current}${l.delta != null ? ` (${l.delta > 0 ? "+" : ""}${l.delta})` : ""}`);
  const lines = [
    reportSubject(r),
    `${r.site.url} · ${periodLabel(r)}`,
    "",
    r.headline.text,
    "",
    `GEO ${fmtScore(s.geo)} | SEO ${fmtScore(s.seo)} | E-E-A-T ${fmtScore(s.eeat)} | AI görünürlük ${rateValue(v.current.visibilityRate)} | Atıf ${v.current.cited}`,
    "",
    "YÖNETİCİ ÖZETİ",
    ...r.executiveSummary.map((x) => `• ${x}`),
  ];
  if (r.anomalies.length) lines.push("", "ANORMALLİKLER", ...r.anomalies.map((a) => `• [${a.severity === "high" ? "Kritik" : "Uyarı"}] ${a.message}`));
  lines.push("", `BEKLEYEN KRİTİK AKSİYONLAR (${r.actions.pendingCount} açık)`);
  lines.push(...(r.actions.pendingCritical.length ? r.actions.pendingCritical.map((a) => `• [${IMPACT_TR[a.impact] ?? a.impact}] ${a.title}`) : ["• Yok"]));
  lines.push("", `ÇÖZÜLEN AKSİYONLAR (${r.actions.resolvedCount})`);
  lines.push(...(r.actions.resolved.length ? r.actions.resolved.map((a) => `• ${a.title}`) : ["• Bu dönemde çözülen aksiyon yok"]));
  if (v.perModel.length) {
    lines.push("", "MODEL BAZINDA GÖRÜNÜRLÜK");
    lines.push(...v.perModel.map((m) => `• ${m.model}: ${m.current ? `${trPct(m.current.visibilityRate)} (${m.current.cited}/${m.current.total} atıf)` : "kontrol yok"}`));
  }
  if (opts.reportUrl) lines.push("", `Rapor: ${opts.reportUrl}`);
  if (opts.pdfUrl) lines.push(`PDF: ${opts.pdfUrl}`);
  return lines.join("\n");
}

export interface AlertContent {
  site: { id: string; url: string; title: string };
  anomalies: Anomaly[];
  detectedAt: string;
}

export function alertSubject(a: AlertContent) {
  const high = a.anomalies.some((x) => x.severity === "high");
  return `${high ? "🚨 Kritik" : "⚠️"} AI görünürlük anormalliği — ${a.site.title}`;
}

export function renderAlertText(a: AlertContent) {
  return [alertSubject(a), `${a.site.url} · ${trDate(a.detectedAt)}`, "", ...a.anomalies.map((x) => `• [${x.severity === "high" ? "Kritik" : "Uyarı"}] ${x.message}`)].join("\n");
}

export function renderAlertHtml(a: AlertContent, opts: RenderOptions = {}) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${esc(alertSubject(a))}</title></head>
<body style="margin:0;padding:24px 12px;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" align="center" style="max-width:600px;width:100%;background:#fff;border:1px solid ${C.line};border-radius:12px;">
<tr><td style="padding:20px 24px;border-bottom:1px solid ${C.line};">
<div style="font-size:18px;font-weight:700;color:${C.ink};">${esc(alertSubject(a))}</div>
<div style="font-size:13px;color:${C.muted};margin-top:4px;">${esc(a.site.url)} · ${esc(trDate(a.detectedAt))}</div></td></tr>
<tr><td style="padding:16px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${anomalyList(a.anomalies)}</table></td></tr>
${opts.reportUrl ? `<tr><td style="padding:0 24px 20px;"><a href="${esc(opts.reportUrl)}" style="color:${C.brand};font-size:13px;">Güncel raporu görüntüle →</a></td></tr>` : ""}
</table></body></html>`;
}
