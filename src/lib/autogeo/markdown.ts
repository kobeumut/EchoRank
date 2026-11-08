// Minimal, dependency-free Markdown -> HTML for AutoGEO snippets (paragraphs, headings, lists, blockquotes with
// citations, GFM tables, links, bold/italic, inline code). Shared by the Content Studio "Copy HTML" button and the
// CMS webhook payload, so both always emit the same markup. Everything is HTML-escaped; only http(s), mailto and
// relative link targets are kept, so a snippet can never inject script URLs.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:|mailto:)/i.test(href) || /^[/#?.]/.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return href;
}

/** Inline formatting on an already-unescaped line. */
export function inlineMarkdown(text: string): string {
  // Code spans first so their content is not formatted.
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let out = "";
      let last = 0;
      // [label](href) — the label may contain brackets one level deep ("[Kaynak, Yıl]").
      const linkRe = /\[((?:[^\[\]]|\[[^\[\]]*\])+)\]\(([^()\s]+(?:\([^()\s]*\))?)(?:\s+"[^"]*")?\)/g;
      for (const m of part.matchAll(linkRe)) {
        out += emphasis(escapeHtml(part.slice(last, m.index)));
        const href = safeHref(m[2]);
        const label = emphasis(escapeHtml(m[1]));
        out += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
        last = (m.index ?? 0) + m[0].length;
      }
      return out + emphasis(escapeHtml(part.slice(last)));
    })
    .join("");
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?!_)/g, "$1<em>$2</em>");
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);

/** Cells of a `| a | b |` row (escaped pipes `\|` are kept). */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Rows of the first GFM table in `md` (header first), or null when there is none. */
export function parseMarkdownTable(md: string): string[][] | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableRow(lines[i]) || !isTableSep(lines[i + 1])) continue;
    const rows = [tableCells(lines[i])];
    for (let j = i + 2; j < lines.length && isTableRow(lines[j]); j++) rows.push(tableCells(lines[j]));
    return rows;
  }
  return null;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const blockStart = (l: string) => /^\s*$/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || isTableRow(l) || /^\s*(---|\*\*\*)\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inlineMarkdown(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = tableCells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) body.push(tableCells(lines[i++]));
      out.push(
        [
          "<table>",
          `  <thead><tr>${head.map((c) => `<th>${inlineMarkdown(c)}</th>`).join("")}</tr></thead>`,
          "  <tbody>",
          ...body.map((r) => `    <tr>${head.map((_, k) => `<td>${inlineMarkdown(r[k] ?? "")}</td>`).join("")}</tr>`),
          "  </tbody>",
          "</table>",
        ].join("\n"),
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      // "— Ad Soyad, Unvan" as the last line becomes the <footer><cite> attribution.
      const lastIdx = quote.length - 1;
      const attribution = lastIdx > 0 && /^\s*(—|--|-)\s*\S/.test(quote[lastIdx]) ? quote[lastIdx].replace(/^\s*(—|--|-)\s*/, "") : null;
      const textLines = (attribution ? quote.slice(0, lastIdx) : quote).filter((l) => l.trim());
      out.push(
        `<blockquote>\n  <p>${textLines.map(inlineMarkdown).join("<br>\n  ")}</p>${attribution ? `\n  <footer>— <cite>${inlineMarkdown(attribution)}</cite></footer>` : ""}\n</blockquote>`,
      );
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(m[2]);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>\n${items.map((t) => `  <li>${inlineMarkdown(t)}</li>`).join("\n")}\n</${tag}>`);
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blockStart(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${para.map(inlineMarkdown).join("\n")}</p>`);
  }
  return out.join("\n");
}
