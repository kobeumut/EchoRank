import { deflateSync } from "node:zlib";

// Minimal, dependency-free PDF 1.4 writer for text reports.
//
// Uses the core Helvetica / Helvetica-Bold fonts (no embedding) with WinAnsiEncoding plus a
// /Differences array that turns it into Windows-1254, so Turkish glyphs (ğ Ğ ş Ş ı İ) render in
// every viewer. Characters outside that set are transliterated or dropped.

const A4 = { w: 595.28, h: 841.89 };

// Advance widths (1/1000 em) from the Adobe core-14 AFM files, chars 32..126.
const ASCII_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ASCII_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Non-ASCII characters: [cp1254 byte, regular width, bold width]. */
const EXTRA: Record<string, [number, number, number]> = {
  "ç": [0xe7, 500, 556], "Ç": [0xc7, 722, 722], "ö": [0xf6, 556, 611], "Ö": [0xd6, 778, 778],
  "ü": [0xfc, 556, 611], "Ü": [0xdc, 722, 722], "ğ": [0xf0, 556, 611], "Ğ": [0xd0, 778, 778],
  "ş": [0xfe, 500, 556], "Ş": [0xde, 667, 667], "ı": [0xfd, 278, 278], "İ": [0xdd, 278, 278],
  "•": [0x95, 350, 350], "–": [0x96, 556, 556], "—": [0x97, 1000, 1000], "€": [0x80, 556, 556],
  "“": [0x93, 333, 500], "”": [0x94, 333, 500], "‘": [0x91, 222, 278], "’": [0x92, 222, 278],
  "…": [0x85, 1000, 1000], "·": [0xb7, 278, 278], "°": [0xb0, 400, 400], "×": [0xd7, 584, 584],
  "â": [0xe2, 556, 556], "î": [0xee, 278, 278], "û": [0xfb, 556, 611], "é": [0xe9, 556, 556],
};

const TRANSLIT: Record<string, string> = { "▲": "+", "▼": "-", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", " ": " ", "\t": " " };

/** Maps text to the characters this writer can encode (others transliterated or dropped). */
export function normalizePdfText(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if ((ch >= " " && ch <= "~") || ch === "\n" || EXTRA[ch]) out += ch;
  }
  return out;
}

function encodeHex(s: string): string {
  let hex = "";
  for (const ch of s) {
    const code = ch >= " " && ch <= "~" ? ch.charCodeAt(0) : EXTRA[ch]?.[0];
    if (code !== undefined) hex += code.toString(16).padStart(2, "0");
  }
  return `<${hex}>`;
}

export function textWidth(s: string, size: number, bold = false): number {
  const ascii = bold ? ASCII_BOLD : ASCII_REGULAR;
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? ascii[c - 32] : (EXTRA[ch]?.[bold ? 2 : 1] ?? 556);
  }
  return (w * size) / 1000;
}

/** Greedy word wrap; words longer than the line are hard-broken. */
export function wrapText(raw: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of normalizePdfText(raw.replace(/\r/g, "")).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (textWidth(rest, size, bold) > maxWidth) {
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function rgb(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

export interface TextStyle {
  size?: number;
  bold?: boolean;
  color?: string;
}

export interface TableColumn {
  header: string;
  /** Fraction of the content width. */
  width: number;
  align?: "left" | "right";
}

export interface TableCell {
  text: string;
  bold?: boolean;
  color?: string;
  /** Horizontal progress bar (0-100) drawn instead of text. */
  bar?: { value: number; color: string };
}

/** Top-down layout cursor over A4 pages. Coordinates passed to drawing helpers are measured from the page top. */
export class PdfDocument {
  readonly margin = 48;
  readonly width = A4.w;
  readonly height = A4.h;
  private pages: string[][] = [];
  private ops: string[] = [];
  y = 0;

  constructor(private meta: { title: string; author?: string; subject?: string; footer?: string }) {
    this.addPage();
  }

  get contentWidth() {
    return this.width - 2 * this.margin;
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.margin;
  }

  /** Starts a new page when fewer than `h` points remain above the bottom margin (+ footer). */
  ensure(h: number) {
    if (this.y + h > this.height - this.margin - 18) this.addPage();
  }

  text(x: number, top: number, s: string, style: TextStyle = {}) {
    const size = style.size ?? 10;
    const baseline = this.height - top - size * 0.8;
    this.ops.push(
      `BT ${rgb(style.color ?? "#0f172a")} rg /${style.bold ? "F2" : "F1"} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${encodeHex(normalizePdfText(s))} Tj ET`,
    );
  }

  rect(x: number, top: number, w: number, h: number, fill: string, stroke?: string) {
    const y = this.height - top - h;
    const parts = [`${rgb(fill)} rg`];
    if (stroke) parts.push(`${rgb(stroke)} RG 0.75 w`);
    parts.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${stroke ? "B" : "f"}`);
    this.ops.push(parts.join(" "));
  }

  hline(top: number, color = "#e2e8f0", x1 = this.margin, x2 = this.width - this.margin) {
    const y = num(this.height - top);
    this.ops.push(`${rgb(color)} RG 0.75 w ${num(x1)} ${y} m ${num(x2)} ${y} l S`);
  }

  /** Wrapped paragraph at the cursor. */
  paragraph(s: string, style: TextStyle & { indent?: number; gap?: number; lineHeight?: number } = {}) {
    const size = style.size ?? 10;
    const lh = style.lineHeight ?? size * 1.4;
    const x = this.margin + (style.indent ?? 0);
    for (const line of wrapText(s, size, this.contentWidth - (style.indent ?? 0), style.bold)) {
      this.ensure(lh);
      this.text(x, this.y, line, style);
      this.y += lh;
    }
    this.y += style.gap ?? 4;
  }

  heading(s: string, size = 13) {
    this.ensure(size * 1.4 + 30);
    this.y += 8;
    this.text(this.margin, this.y, s, { size, bold: true });
    this.y += size * 1.3;
    this.hline(this.y);
    this.y += 8;
  }

  bullets(items: string[], style: TextStyle = {}) {
    const size = style.size ?? 10;
    const lh = size * 1.4;
    for (const item of items) {
      const lines = wrapText(item, size, this.contentWidth - 14, style.bold);
      this.ensure(lh * Math.min(lines.length, 2));
      this.text(this.margin + 2, this.y, "•", { ...style, color: "#4f46e5" });
      for (const line of lines) {
        this.ensure(lh);
        this.text(this.margin + 14, this.y, line, style);
        this.y += lh;
      }
      this.y += 2;
    }
    this.y += 4;
  }

  table(columns: TableColumn[], rows: TableCell[][], opts: { size?: number; headerFill?: string; zebra?: string } = {}) {
    const size = opts.size ?? 9;
    const lh = size * 1.35;
    const pad = 5;
    const widths = columns.map((c) => c.width * this.contentWidth);
    const drawHeader = () => {
      const h = lh + pad * 2;
      this.rect(this.margin, this.y, this.contentWidth, h, opts.headerFill ?? "#eef2ff");
      let x = this.margin;
      columns.forEach((c, i) => {
        const label = normalizePdfText(c.header);
        const tx = c.align === "right" ? x + widths[i] - pad - textWidth(label, size, true) : x + pad;
        this.text(tx, this.y + pad, label, { size, bold: true, color: "#334155" });
        x += widths[i];
      });
      this.y += h;
    };
    this.ensure(lh * 2 + pad * 4);
    drawHeader();
    rows.forEach((row, r) => {
      const cellLines = row.map((cell, i) => wrapText(cell.text, size, widths[i] - pad * 2, cell.bold));
      const h = Math.max(...cellLines.map((l) => l.length)) * lh + pad * 2;
      if (this.y + h > this.height - this.margin - 18) {
        this.addPage();
        drawHeader();
      }
      if (opts.zebra !== "" && r % 2 === 1) this.rect(this.margin, this.y, this.contentWidth, h, opts.zebra ?? "#f8fafc");
      let x = this.margin;
      row.forEach((cell, i) => {
        if (cell.bar) {
          const bw = widths[i] - pad * 2;
          const top = this.y + h / 2 - 3;
          this.rect(x + pad, top, bw, 6, "#e2e8f0");
          this.rect(x + pad, top, Math.max(2, (bw * Math.max(0, Math.min(100, cell.bar.value))) / 100), 6, cell.bar.color);
        }
        cellLines[i].forEach((line, j) => {
          const tx = columns[i].align === "right" ? x + widths[i] - pad - textWidth(line, size, cell.bold) : x + pad;
          this.text(tx, this.y + pad + j * lh, line, { size, bold: cell.bold, color: cell.color });
        });
        x += widths[i];
      });
      this.y += h;
      this.hline(this.y);
    });
    this.y += 10;
  }

  /** Serializes the document. Adds "page / total" footers. */
  toBuffer(): Buffer {
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      this.ops = ops;
      const label = `${i + 1} / ${total}`;
      const top = this.height - this.margin + 6;
      if (this.meta.footer) this.text(this.margin, top, this.meta.footer, { size: 8, color: "#94a3b8" });
      this.text(this.width - this.margin - textWidth(label, 8), top, label, { size: 8, color: "#94a3b8" });
    });

    const objects: Buffer[] = [];
    const add = (body: string | Buffer) => {
      objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
      return objects.length;
    };
    const encoding = "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [208 /Gbreve 221 /Idotaccent 222 /Scedilla 240 /gbreve 253 /dotlessi 254 /scedilla] >>";
    const catalogId = add(""); // placeholder, filled below
    const pagesId = add("");
    const f1 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${encoding} >>`);
    const f2 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding ${encoding} >>`);
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const data = deflateSync(Buffer.from(ops.join("\n"), "latin1"));
      const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      );
    }
    objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
    objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");
    const d = new Date();
    const pdfDate = `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
    const infoId = add(
      `<< /Title ${encodeHex(normalizePdfText(this.meta.title))} /Author ${encodeHex(normalizePdfText(this.meta.author ?? "AI Visibility"))}${
        this.meta.subject ? ` /Subject ${encodeHex(normalizePdfText(this.meta.subject))}` : ""
      } /Producer (ai-visibility pdf-writer) /CreationDate (${pdfDate}) >>`,
    );

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
      chunks.push(chunk);
      offset += chunk.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}
