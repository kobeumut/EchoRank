import { trPct, type PeriodicReport, type ScoreLine } from "./builder";
import { CATEGORY_TR, FREQUENCY_TR, IMPACT_TR, periodLabel, reportSubject, trDate, trShortDate } from "./html";
import { PdfDocument, wrapText, type TableCell } from "./pdf-writer";

const INK = "#0f172a";
const MUTED = "#64748b";
const UP = "#047857";
const DOWN = "#b91c1c";
const WARN = "#b45309";

const deltaText = (d: number | null, suffix = "") => (d == null ? "—" : `${d > 0 ? "+" : ""}${d}${suffix}`);
const deltaColor = (d: number | null) => (d == null || d === 0 ? MUTED : d > 0 ? UP : DOWN);

/** Downloadable PDF version of the periodic report. */
export function renderReportPdf(r: PeriodicReport): Buffer {
  const doc = new PdfDocument({
    title: reportSubject(r),
    subject: r.headline.text,
    footer: `${r.site.url} · ${r.periodKey}`,
  });
  const m = doc.margin;
  const cw = doc.contentWidth;

  // Header band
  doc.rect(0, 0, doc.width, 104, INK);
  doc.text(m, 26, `${FREQUENCY_TR[r.frequency].toUpperCase()} GEO · SEO · LLM GÖRÜNÜRLÜK RAPORU`, { size: 9, bold: true, color: "#a5b4fc" });
  doc.text(m, 42, wrapText(r.site.title, 20, cw, true)[0], { size: 20, bold: true, color: "#ffffff" });
  doc.text(m, 70, `${r.site.url}  ·  ${periodLabel(r)}`, { size: 10, color: "#cbd5e1" });
  doc.y = 124;

  // Headline banner
  const h = r.headline;
  const fill = h.direction === "up" ? "#ecfdf5" : h.direction === "down" ? "#fef2f2" : "#eef2ff";
  const ink = h.direction === "up" ? UP : h.direction === "down" ? DOWN : "#4f46e5";
  const bannerLines = wrapText(h.text, 11, cw - 24, true);
  const bannerH = bannerLines.length * 15 + 18;
  doc.rect(m, doc.y, cw, bannerH, fill);
  bannerLines.forEach((l, i) => doc.text(m + 12, doc.y + 10 + i * 15, l, { size: 11, bold: true, color: ink }));
  doc.y += bannerH + 14;

  // KPI tiles
  const v = r.visibility;
  const visDelta = v.current.visibilityRate != null && v.previous.visibilityRate != null ? v.current.visibilityRate - v.previous.visibilityRate : null;
  const tiles: Array<[string, string, number | null, string]> = [
    ["GEO", score(r.scores.geo), r.scores.geo.delta, ""],
    ["SEO", score(r.scores.seo), r.scores.seo.delta, ""],
    ["E-E-A-T", score(r.scores.eeat), r.scores.eeat.delta, ""],
    ["AI görünürlük", v.current.visibilityRate == null ? "—" : trPct(v.current.visibilityRate), visDelta, " puan"],
    ["Model atıfı", String(v.current.cited), v.previous.totalChecks ? v.current.cited - v.previous.cited : null, ""],
  ];
  const gap = 8;
  const tw = (cw - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach(([label, value, delta, suffix], i) => {
    const x = m + i * (tw + gap);
    doc.rect(x, doc.y, tw, 62, "#ffffff", "#e2e8f0");
    doc.text(x + 8, doc.y + 8, label.toLocaleUpperCase("tr-TR"), { size: 7.5, bold: true, color: MUTED });
    doc.text(x + 8, doc.y + 21, value, { size: 18, bold: true, color: INK });
    doc.text(x + 8, doc.y + 46, deltaText(delta, suffix), { size: 8, bold: true, color: deltaColor(delta) });
  });
  doc.y += 76;

  doc.heading("Yönetici Özeti");
  doc.bullets(r.executiveSummary);

  if (r.anomalies.length) {
    doc.heading("Anormallikler");
    doc.table(
      [
        { header: "Önem", width: 0.14 },
        { header: "Açıklama", width: 0.86 },
      ],
      r.anomalies.map((a) => [
        { text: a.severity === "high" ? "Kritik" : "Uyarı", bold: true, color: a.severity === "high" ? DOWN : WARN },
        { text: a.message },
      ]),
    );
  }

  doc.heading(`Bekleyen kritik aksiyonlar (${r.actions.pendingCount} açık)`);
  if (r.actions.pendingCritical.length) {
    doc.table(
      [
        { header: "Aksiyon", width: 0.52 },
        { header: "Kategori", width: 0.2 },
        { header: "Etki", width: 0.12 },
        { header: "Kazanç", width: 0.16, align: "right" },
      ],
      r.actions.pendingCritical.map((a) => [
        { text: a.targetUrl ? `${a.title}\n${a.targetUrl}` : a.title },
        { text: CATEGORY_TR[a.category] ?? a.category },
        impactCell(a.impact),
        { text: a.expectedGain != null ? `+${a.expectedGain}` : "—" },
      ]),
    );
  } else {
    doc.paragraph("Bekleyen kritik aksiyon yok.", { color: UP });
  }

  doc.heading(`Çözülen aksiyonlar (${r.actions.resolvedCount})`);
  if (r.actions.resolved.length) {
    doc.table(
      [
        { header: "Aksiyon", width: 0.52 },
        { header: "Kategori", width: 0.2 },
        { header: "Etki", width: 0.12 },
        { header: "Tarih", width: 0.16, align: "right" },
      ],
      r.actions.resolved.map((a) => [
        { text: a.title },
        { text: CATEGORY_TR[a.category] ?? a.category },
        impactCell(a.impact),
        { text: a.resolvedAt ? trShortDate(a.resolvedAt) : "" },
      ]),
    );
  } else {
    doc.paragraph("Bu dönemde çözülen aksiyon yok.", { color: MUTED });
  }

  doc.heading("Model bazında yapay zeka görünürlüğü");
  if (v.perModel.length) {
    doc.table(
      [
        { header: "Model", width: 0.24 },
        { header: "Yanıt", width: 0.12, align: "right" },
        { header: "Atıf", width: 0.12, align: "right" },
        { header: "Bahsetme", width: 0.16, align: "right" },
        { header: "Görünürlük", width: 0.18, align: "right" },
        { header: "Değişim", width: 0.18, align: "right" },
      ],
      v.perModel.map((pm) => {
        const d = pm.current && pm.previousVisibilityRate != null ? pm.current.visibilityRate - pm.previousVisibilityRate : null;
        return [
          { text: pm.model, bold: true },
          { text: String(pm.current?.total ?? 0) },
          { text: String(pm.current?.cited ?? 0) },
          { text: String(pm.current?.mentioned ?? 0) },
          { text: pm.current ? trPct(pm.current.visibilityRate) : "—" },
          { text: deltaText(d, " puan"), color: deltaColor(d) },
        ] satisfies TableCell[];
      }),
    );
  } else {
    doc.paragraph("Bu dönemde LLM görünürlük kontrolü yapılmadı.", { color: MUTED });
  }

  if (v.competitors.length) {
    doc.heading("Yanıtlarda öne çıkan rakipler");
    doc.table(
      [
        { header: "Rakip alan adı", width: 0.6 },
        { header: "Atıf", width: 0.2, align: "right" },
        { header: "Yanıt payı", width: 0.2, align: "right" },
      ],
      v.competitors.map((c) => [{ text: c.domain }, { text: String(c.count) }, { text: trPct(c.share) }]),
    );
  }

  doc.heading("Skor trendi");
  if (r.trend.length) {
    doc.table(
      [
        { header: "Tarih", width: 0.18 },
        { header: "GEO", width: 0.1, align: "right" },
        { header: "SEO", width: 0.1, align: "right" },
        { header: "E-E-A-T", width: 0.12, align: "right" },
        { header: "AI görünürlük", width: 0.16, align: "right" },
        { header: "", width: 0.34 },
      ],
      r.trend.map((p) => [
        { text: trShortDate(p.date) },
        { text: p.geoScore == null ? "—" : String(p.geoScore) },
        { text: p.seoScore == null ? "—" : String(p.seoScore) },
        { text: p.eeatScore == null ? "—" : String(p.eeatScore) },
        { text: p.visibilityRate == null ? "—" : trPct(p.visibilityRate) },
        trendBar(p.visibilityRate ?? p.geoScore, p.visibilityRate != null),
      ]),
    );
  } else {
    doc.paragraph("Trend için yeterli veri yok — zamanlanmış denetimler çalıştıkça dolacak.", { color: MUTED });
  }

  doc.paragraph(
    `Oluşturulma: ${trDate(r.generatedAt)}. Görünürlük oranı, kontrol edilen yapay zeka yanıtlarında sitenize atıf yapılan veya markanızdan bahsedilen yanıtların payıdır.`,
    { size: 8, color: MUTED },
  );
  return doc.toBuffer();
}

function score(s: ScoreLine) {
  return s.current == null ? "—" : String(s.current);
}

function impactCell(impact: string): TableCell {
  return { text: IMPACT_TR[impact] ?? impact, bold: true, color: impact === "high" ? DOWN : impact === "medium" ? WARN : MUTED };
}

function trendBar(value: number | null, isVisibility: boolean): TableCell {
  return value == null ? { text: "" } : { text: "", bar: { value, color: isVisibility ? "#4f46e5" : "#94a3b8" } };
}
