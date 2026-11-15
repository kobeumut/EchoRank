// Splits an LLM answer into plain / highlighted segments for the site's name, domain and cited URLs.

export type Segment = { text: string; match: boolean };

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case/dotless-insensitive key for matching text in either language. Deliberately Turkish-aware: the "tr" locale maps
 * `İ -> i` and `I -> ı` (plain `toLowerCase()` would turn `İ` into `i` + a combining dot), and the final replace folds the
 * dotless `ı` back to `i` so that English "Index", Turkish "İndeks" and a typed "index" all compare equal.
 */
export function foldCase(text: string): string {
  return text.toLocaleLowerCase("tr").replace(/ı/g, "i");
}

/**
 * Regex source matching `term` case-insensitively, including the Turkish dotted/dotless i family (İ, i, ı, I),
 * which the plain /i flag does not fold. The Turkish-locale variants and the "iıİI" set below are language data
 * needed to highlight Turkish answers correctly; they are harmless for English text.
 */
function caseInsensitiveSource(term: string) {
  let out = "";
  for (const ch of term) {
    const variants = new Set([ch, ch.toLowerCase(), ch.toUpperCase(), ch.toLocaleLowerCase("tr"), ch.toLocaleUpperCase("tr")]);
    if (/[iıİI]/.test(ch)) for (const v of "iıİI") variants.add(v);
    const single = [...variants].filter((v) => [...v].length === 1);
    out += single.length > 1 ? `[${single.map((v) => v.replace(/[\]\\^-]/g, "\\$&")).join("")}]` : escape(ch);
  }
  return out;
}

/** Terms identifying the site in an answer: title, bare host, host with www, cited URLs. */
export function siteTerms(site: { url: string; title: string }, citedUrls: string[] = []): string[] {
  const terms = new Set<string>();
  try {
    const host = new URL(site.url).hostname.toLowerCase().replace(/^www\./, "");
    terms.add(host);
  } catch {
    /* ignore malformed site URL */
  }
  if (site.title.trim().length >= 3) terms.add(site.title.trim());
  for (const u of citedUrls) if (u) terms.add(u);
  return [...terms];
}

/** Case-insensitive, longest-term-first; overlapping matches resolve to the earliest/longest. */
export function highlightSegments(text: string, terms: string[]): Segment[] {
  const usable = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  if (!text) return [];
  if (!usable.length) return [{ text, match: false }];
  const re = new RegExp(usable.map(caseInsensitiveSource).join("|"), "gu");
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), match: false });
    out.push({ text: m[0], match: true });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out;
}
