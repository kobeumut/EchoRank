// Pure helpers for the AutoGEO Content Studio (no React): side-by-side line/word diff, GEO signal highlighting
// (statistics, quotes, citations, placeholders), impact tiers, answer-capsule/table extraction and the GEO score
// simulator. Kept framework-free so they are unit-tested in tests/autogeo-studio.test.ts.
import { markdownToHtml, parseMarkdownTable } from "../autogeo/markdown";
import type { Tone } from "./format";

// ---------------------------------------------------------------- labels & tiers

export const STUDIO_RULE_TYPES = ["stats", "quotes", "citations", "tone", "answer_capsule", "keyword_stuffing", "comparison_table"] as const;
export type StudioRuleType = (typeof STUDIO_RULE_TYPES)[number];

export const RULE_TYPE_LABELS: Record<string, string> = {
  stats: "İstatistik",
  quotes: "Alıntı",
  citations: "Kaynak",
  tone: "Ton",
  answer_capsule: "Yanıt Kapsülü",
  keyword_stuffing: "Anahtar Kelime",
  comparison_table: "Tablo",
};

export const SUGGESTION_STATUS_LABELS: Record<string, string> = {
  pending: "Bekliyor",
  applied: "Uygulandı",
  dismissed: "Yoksayıldı",
  superseded: "Güncelliğini yitirdi",
};

export type Impact = "high" | "medium" | "low";
export const IMPACTS: { value: Impact; label: string; tone: Tone }[] = [
  { value: "high", label: "Yüksek", tone: "critical" },
  { value: "medium", label: "Orta", tone: "serious" },
  { value: "low", label: "Düşük", tone: "good" },
];

/** Same bands as the AutoGEO ActionItem impact (`impactOf` in services/autogeo.ts): ≥15% high, ≥6% medium. */
export function impactOfGain(gain: number): Impact {
  return gain >= 15 ? "high" : gain >= 6 ? "medium" : "low";
}

export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- diff

export type DiffKind = "same" | "removed" | "added";
export type DiffSeg = { text: string; kind: DiffKind };
export type DiffRow = {
  type: "same" | "changed" | "removed" | "added";
  left: { no: number; segs: DiffSeg[] } | null;
  right: { no: number; segs: DiffSeg[] } | null;
};

const MAX_LCS_CELLS = 4_000_000;

/** LCS-based edit script over two token arrays; falls back to "replace all" for huge inputs. */
function editScript<T>(a: T[], b: T[]): { t: DiffKind; v: T }[] {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return [...a.map((v) => ({ t: "removed" as const, v })), ...b.map((v) => ({ t: "added" as const, v }))];
  // Trim common prefix/suffix first: most AutoGEO rewrites touch a few words of a long block.
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf);
  const B = b.slice(pre, m - suf);
  const w = B.length + 1;
  const lcs = new Uint32Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out: { t: DiffKind; v: T }[] = a.slice(0, pre).map((v) => ({ t: "same" as const, v }));
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      out.push({ t: "same", v: A[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ t: "removed", v: A[i++] });
    else out.push({ t: "added", v: B[j++] });
  }
  while (i < A.length) out.push({ t: "removed", v: A[i++] });
  while (j < B.length) out.push({ t: "added", v: B[j++] });
  for (const v of a.slice(n - suf)) out.push({ t: "same", v });
  return out;
}

export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function pushSeg(segs: DiffSeg[], text: string, kind: DiffKind) {
  const last = segs[segs.length - 1];
  if (last && last.kind === kind) last.text += text;
  else if (text) segs.push({ text, kind });
}

/** Word-level diff of one line pair: left = same/removed segments, right = same/added segments. */
export function wordDiff(before: string, after: string): { left: DiffSeg[]; right: DiffSeg[] } {
  const left: DiffSeg[] = [];
  const right: DiffSeg[] = [];
  for (const op of editScript(tokenize(before), tokenize(after))) {
    if (op.t !== "added") pushSeg(left, op.v, op.t);
    if (op.t !== "removed") pushSeg(right, op.v, op.t);
  }
  // A whitespace-only "same" island between two changes reads better as part of the change.
  return { left: absorbSpaces(left), right: absorbSpaces(right) };
}

function absorbSpaces(segs: DiffSeg[]): DiffSeg[] {
  const out: DiffSeg[] = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s.kind === "same" && /^\s+$/.test(s.text) && k > 0 && k < segs.length - 1 && segs[k - 1].kind !== "same" && segs[k + 1].kind === segs[k - 1].kind) {
      pushSeg(out, s.text, segs[k - 1].kind);
      continue;
    }
    pushSeg(out, s.text, s.kind);
  }
  return out;
}

const lines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").split("\n"));

/**
 * Aligned side-by-side rows. Consecutive removed/added line runs are paired into "changed" rows with a word-level
 * diff; surplus lines stay pure removals/additions. Line numbers are 1-based per side.
 */
export function sideBySideDiff(before: string, after: string): DiffRow[] {
  const ops = editScript(lines(before), lines(after));
  const rows: DiffRow[] = [];
  let ln = 0;
  let rn = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "same") {
      ln++;
      rn++;
      rows.push({ type: "same", left: { no: ln, segs: [{ text: ops[k].v, kind: "same" }] }, right: { no: rn, segs: [{ text: ops[k].v, kind: "same" }] } });
      k++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length && ops[k].t !== "same") (ops[k].t === "removed" ? removed : added).push(ops[k++].v);
    const pairs = Math.max(removed.length, added.length);
    for (let p = 0; p < pairs; p++) {
      const l = removed[p];
      const r = added[p];
      if (l !== undefined && r !== undefined) {
        const wd = wordDiff(l, r);
        rows.push({ type: "changed", left: { no: ++ln, segs: wd.left }, right: { no: ++rn, segs: wd.right } });
      } else if (l !== undefined) rows.push({ type: "removed", left: { no: ++ln, segs: [{ text: l, kind: "removed" }] }, right: null });
      else rows.push({ type: "added", left: null, right: { no: ++rn, segs: [{ text: r!, kind: "added" }] } });
    }
  }
  return rows;
}

export function diffStats(rows: DiffRow[]) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    for (const s of r.left?.segs ?? []) if (s.kind === "removed") removed += countWords(s.text);
    for (const s of r.right?.segs ?? []) if (s.kind === "added") added += countWords(s.text);
  }
  return { addedWords: added, removedWords: removed };
}

// ---------------------------------------------------------------- GEO signal highlighting

export type SignalTag = "placeholder" | "citation" | "stat" | "quote";
export const SIGNAL_LABELS: Record<SignalTag, string> = {
  stat: "İstatistik",
  quote: "Uzman alıntısı",
  citation: "Kaynak atfı",
  placeholder: "Doldurulacak alan",
};

// Highest priority first; a character keeps the first tag that claims it.
const SIGNAL_PATTERNS: [SignalTag, RegExp][] = [
  // [Kaynak, Yıl](https://…) placeholder links are citations to fill; plain links and numbered refs are citations.
  ["citation", /\[(?:[^\[\]\n]|\[[^\[\]\n]*\])+\]\([^()\s]+\)|https?:\/\/[^\s)>\]]+|\[\d{1,3}\]|\((?:[\p{Lu}][^()\n]{1,60}),\s*(?:19|20)\d{2}\)|\b[\p{Lu}][\p{L}.&-]+(?:\s[\p{Lu}][\p{L}.&-]+)*['’](?:[ae]|ya|ye|na|ne)\s+göre\b|\baccording to\s+[^,.;\n]+/gu],
  ["placeholder", /%?\[[^\[\]\n]{2,120}\](?!\()/gu],
  [
    "stat",
    /(?:%|±)\s?\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*(?:\s?(?:%|‰|°C|TL|₺|\$|€|USD|EUR|milyon|milyar|bin|kat|bar|W|kW|L|ml|mg|kg|g|km|mm|cm|dk|sn|saat|gün|hafta|ay|yıl|kişi|adet|x)(?![\p{L}]))|\b(?!(?:19|20)\d{2}\b)\d+(?:[.,]\d+)*\b/gu,
  ],
  ["quote", /“[^”\n]{3,}”|"[^"\n]{8,}"|^\s*>.*$/gmu],
];

export type Piece = { text: string; kind: DiffKind; tag: SignalTag | null };

/** Per-character GEO signal tags of `text`. */
export function signalTags(text: string): (SignalTag | null)[] {
  const tags: (SignalTag | null)[] = new Array(text.length).fill(null);
  for (const [tag, re] of SIGNAL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      for (let c = start; c < start + m[0].length; c++) if (tags[c] === null) tags[c] = tag;
    }
  }
  return tags;
}

/** Splits diff segments of one line at GEO-signal boundaries. */
export function annotate(segs: DiffSeg[]): Piece[] {
  const text = segs.map((s) => s.text).join("");
  const tags = signalTags(text);
  const out: Piece[] = [];
  let pos = 0;
  for (const s of segs) {
    for (let c = 0; c < s.text.length; c++) {
      const tag = tags[pos + c];
      const last = out[out.length - 1];
      if (last && last.kind === s.kind && last.tag === tag) last.text += s.text[c];
      else out.push({ text: s.text[c], kind: s.kind, tag });
    }
    pos += s.text.length;
  }
  return out;
}

/** Counts of GEO signals the suggestion adds (present after, absent before), by tag. */
export function addedSignals(before: string, after: string): Record<SignalTag, number> {
  const count = (t: string) => {
    const res: Record<SignalTag, number> = { stat: 0, quote: 0, citation: 0, placeholder: 0 };
    const tags = signalTags(t);
    for (let c = 0; c < tags.length; c++) if (tags[c] && tags[c] !== tags[c - 1]) res[tags[c]!]++;
    return res;
  };
  const a = count(before);
  const b = count(after);
  return { stat: Math.max(0, b.stat - a.stat), quote: Math.max(0, b.quote - a.quote), citation: Math.max(0, b.citation - a.citation), placeholder: Math.max(0, b.placeholder - a.placeholder) };
}

export function placeholderCount(text: string): number {
  return [...text.matchAll(/%?\[[^\[\]\n]{2,120}\]/gu)].length;
}

// ---------------------------------------------------------------- answer capsules & tables

/** Words of rendered text (Markdown syntax, link targets and table pipes ignored). */
export function countWords(text: string): number {
  const plain = text
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#>*_`|[\]]/g, " ")
    .trim();
  return plain ? plain.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

export type CapsuleFit = { tone: Tone; label: string };
export function capsuleFit(words: number): CapsuleFit {
  if (words >= 40 && words <= 60) return { tone: "good", label: "İdeal (40-60)" };
  if (words >= 30 && words <= 75) return { tone: "warning", label: words < 40 ? "Biraz kısa" : "Biraz uzun" };
  return { tone: "critical", label: words < 40 ? "Çok kısa" : "Çok uzun" };
}

export type CapsuleCard = {
  key: string;
  pageUrl: string;
  heading: string | null;
  markdown: string;
  html: string;
  words: number;
  placeholders: number;
  source: "page" | "suggestion";
  suggestionId?: string;
  status?: string;
};

export type TableCard = {
  key: string;
  pageUrl: string;
  title: string;
  rows: string[][];
  markdown: string;
  html: string;
  suggestionId?: string;
  status?: string;
};

export type StudioSuggestion = {
  id: string;
  pageUrl: string;
  ruleType: string;
  ruleId: string | null;
  title: string | null;
  originalSnippet: string;
  suggestedSnippet: string;
  diffMarkdown: string | null;
  expectedGain: number;
  status: string;
  actionItemId: string | null;
  createdAt: string;
  updatedAt: string;
};

type CapsuleDetail = { text?: string; markdown?: string; html?: string; word_count?: number };
type TableDetail = { markdown?: string; html?: string; rows?: string[][] };
export type StudioActionItem = { id: string; ruleId: string | null; targetUrl: string | null; details: Record<string, unknown> | null };

/** The part of a suggestion that is new: for insertions the anchor block (original) is a prefix and is dropped. */
export function insertedPart(s: Pick<StudioSuggestion, "originalSnippet" | "suggestedSnippet">): string {
  const o = s.originalSnippet.trim();
  const t = s.suggestedSnippet.trim();
  if (o && t.startsWith(o) && t.length > o.length) return t.slice(o.length).trim();
  return t;
}

function headingOf(s: StudioSuggestion): string | null {
  const h = /^#{1,6}\s+(.+)$/m.exec(s.originalSnippet);
  if (h) return h[1].trim();
  const q = /['‘’"“]([^'‘’"”]{2,120})['’"”]\s+için/u.exec(s.title ?? "");
  return q ? q[1].trim() : null;
}

/**
 * Capsule cards: one per answer-capsule suggestion (heading-level, 40-60 words) plus the page-level capsules the
 * engine stored on the AutoGEO action items. Dismissed/superseded suggestions are skipped.
 */
export function collectCapsules(suggestions: StudioSuggestion[], items: StudioActionItem[]): CapsuleCard[] {
  const out: CapsuleCard[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    if (s.ruleType !== "answer_capsule" || s.status === "dismissed" || s.status === "superseded") continue;
    const md = insertedPart(s);
    if (!md || seen.has(`${s.pageUrl}\u0000${md}`)) continue;
    seen.add(`${s.pageUrl}\u0000${md}`);
    out.push({ key: s.id, pageUrl: s.pageUrl, heading: headingOf(s), markdown: md, html: markdownToHtml(md), words: countWords(md), placeholders: placeholderCount(md), source: "suggestion", suggestionId: s.id, status: s.status });
  }
  for (const item of items) {
    const cap = item.details?.answerCapsule as CapsuleDetail | undefined;
    const md = cap?.markdown || cap?.text;
    if (!item.targetUrl || !md || seen.has(`${item.targetUrl}\u0000${md}`)) continue;
    seen.add(`${item.targetUrl}\u0000${md}`);
    out.push({ key: `item:${item.id}`, pageUrl: item.targetUrl, heading: null, markdown: md, html: cap?.html || markdownToHtml(md), words: countWords(md), placeholders: placeholderCount(md), source: "page" });
  }
  return out;
}

/** Table cards from comparison-table / key-figure suggestions and the stored `comparisonTable` details. */
export function collectTables(suggestions: StudioSuggestion[], items: StudioActionItem[]): TableCard[] {
  const out: TableCard[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    if (s.status === "dismissed" || s.status === "superseded") continue;
    const md = insertedPart(s);
    const rows = parseMarkdownTable(md);
    if (!rows || parseMarkdownTable(s.originalSnippet)) continue;
    const key = `${s.pageUrl}\u0000${md}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: s.id, pageUrl: s.pageUrl, title: s.title ?? RULE_TYPE_LABELS[s.ruleType] ?? "Tablo", rows, markdown: md, html: markdownToHtml(md), suggestionId: s.id, status: s.status });
  }
  for (const item of items) {
    const t = item.details?.comparisonTable as TableDetail | undefined;
    if (!item.targetUrl || !t?.markdown || seen.has(`${item.targetUrl}\u0000${t.markdown.trim()}`)) continue;
    seen.add(`${item.targetUrl}\u0000${t.markdown.trim()}`);
    const rows = Array.isArray(t.rows) && t.rows.length ? t.rows : parseMarkdownTable(t.markdown);
    if (!rows) continue;
    out.push({ key: `item:${item.id}`, pageUrl: item.targetUrl, title: "Karşılaştırma tablosu", rows, markdown: t.markdown, html: t.html || markdownToHtml(t.markdown) });
  }
  return out;
}

// ---------------------------------------------------------------- GEO score simulator

export type SimPage = { url: string; score: number };
export type SimResult = {
  current: number;
  /** After the suggestions already marked applied (awaiting re-audit). */
  withApplied: number;
  /** After applied + selected pending suggestions. */
  projected: number;
  appliedGain: number;
  selectedGain: number;
  pages: { url: string; current: number; projected: number; selected: number }[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const clampGain = (g: number) => Math.min(Math.max(g, 0), 60) / 100;

/**
 * Heuristic GEO score projection. Each suggestion closes `expectedGain`% (GEO-paper visibility estimate, capped at
 * 60%) of the page's remaining gap to 100, compounding multiplicatively so stacked suggestions show diminishing
 * returns and never exceed 100. The site score moves by the mean page delta over all analysed pages.
 */
export function simulateScore(
  siteScore: number | null | undefined,
  pages: SimPage[],
  suggestions: Pick<StudioSuggestion, "id" | "pageUrl" | "expectedGain" | "status">[],
  selected: ReadonlySet<string>,
): SimResult {
  const base = new Map(pages.map((p) => [p.url, p.score]));
  const fallback = siteScore ?? (pages.length ? pages.reduce((s, p) => s + p.score, 0) / pages.length : 0);
  const keepApplied = new Map<string, number>();
  const keepAll = new Map<string, number>();
  for (const s of suggestions) {
    const applied = s.status === "applied";
    const chosen = s.status === "pending" && selected.has(s.id);
    if (!applied && !chosen) continue;
    const keep = 1 - clampGain(s.expectedGain);
    if (applied) keepApplied.set(s.pageUrl, (keepApplied.get(s.pageUrl) ?? 1) * keep);
    keepAll.set(s.pageUrl, (keepAll.get(s.pageUrl) ?? 1) * keep);
  }
  const urls = [...new Set([...base.keys(), ...keepAll.keys()])];
  const n = Math.max(urls.length, 1);
  let dApplied = 0;
  let dAll = 0;
  const perPage: SimResult["pages"] = [];
  for (const url of urls) {
    const cur = base.get(url) ?? fallback;
    const gap = 100 - cur;
    const a = gap * (1 - (keepApplied.get(url) ?? 1));
    const all = gap * (1 - (keepAll.get(url) ?? 1));
    dApplied += a;
    dAll += all;
    if (all > 0) perPage.push({ url, current: round1(cur), projected: round1(cur + all), selected: round1(all - a) });
  }
  const current = round1(fallback);
  const withApplied = round1(Math.min(100, fallback + dApplied / n));
  const projected = round1(Math.min(100, fallback + dAll / n));
  return {
    current,
    withApplied,
    projected,
    appliedGain: round1(withApplied - current),
    selectedGain: round1(projected - withApplied),
    pages: perPage.sort((x, y) => y.projected - y.current - (x.projected - x.current)),
  };
}
