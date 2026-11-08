import { z } from "zod";

export const VISIBILITY_MODELS = ["chatgpt", "gemini", "claude", "perplexity"] as const;
export type VisibilityModel = (typeof VISIBILITY_MODELS)[number];
export type SearchAnswer = { text: string; citations: string[] };

const evidenceUrl = z.string().max(2048).refine((value) => host(value) !== null, "Expected an HTTP(S) URL without credentials");
const label = z.string().trim().min(1).max(200);
export const visibilityAnalysisSettings = z.object({
  competitors: z.array(z.object({ title: label, url: evidenceUrl }).strict()).max(20).default([]),
  // Literal, curator-verified contradiction rules, never executable regular expressions.
  facts: z.array(z.object({
    subject: label, expected: z.string().min(1).max(1000),
    conflictingClaims: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    sourceUrl: evidenceUrl, verifiedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  }).strict().refine((f) => Date.parse(f.validUntil) > Date.parse(f.verifiedAt), "Fact validity must end after verification")).max(100).default([]),
  referencePages: z.array(z.object({
    url: evidenceUrl, observedAt: z.iso.datetime(),
    wordCount: z.number().int().min(0).max(10_000_000).optional(),
    schemaTypes: z.array(label).max(100).optional(),
    tableCount: z.number().int().min(0).max(100_000).optional(),
    text: z.string().max(20_000).optional(), textComplete: z.boolean().default(false),
  }).strict()).max(20).default([]),
}).strict();
export type VisibilityAnalysisSettings = z.infer<typeof visibilityAnalysisSettings>;

export function host(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch { return null; }
}

export function containsName(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !!name && new RegExp(`(?<![\\p{L}\\p{N}_@.-])${escaped}(?![\\p{L}\\p{N}_@-]|\\.[\\p{L}\\p{N}])`, "iu").test(text);
}

/** Deterministic evidence, not another LLM judgement. Links are not verified by fetching them. */
export function analyzeAnswer(answer: SearchAnswer, site: { url: string; title: string }) {
  const target = host(site.url)!;
  const isTarget = (h: string) => h === target || h.endsWith(`.${target}`);
  const links = answer.text.match(/https?:\/\/[^\s<>"\])}]+/gi) ?? [];
  const citations = [...new Set([...answer.citations, ...links]
    .map((url) => url.replace(/[.,;!?]+$/, ""))
    .filter((url) => host(url)))];
  const citedUrls = citations.filter((url) => isTarget(host(url)!));
  const prose = answer.text.replace(/https?:\/\/[^\s<>"\])}]+/gi, "");
  const isMentioned = containsName(prose, site.title) || containsName(prose, target);
  // ponytail: only explicit numbered recommendations have a rank; prose/source order is not ranking.
  let position: number | null = null;
  for (const line of answer.text.split("\n")) {
    if (/^\s*(?:#{1,6}\s*)?(?:sources?|references?|kaynaklar)\s*:?\s*$/i.test(line.replace(/[*_`]/g, ""))) break;
    const match = line.match(/^\s*(\d{1,3})[.)]\s+(.+)$/);
    if (!match) continue;
    const label = match[2].replace(/https?:\/\/[^\s<>"\])}]+/gi, "");
    if (containsName(label, site.title) || containsName(label, target)) {
      position = Number(match[1]) || null;
      break;
    }
  }
  return {
    isCited: citedUrls.length > 0,
    isMentioned,
    citationStatus: citedUrls.length ? "cited" : isMentioned ? "mentioned" : "none",
    position,
    citedUrls,
    citations,
    // Other source domains are candidates, not proof of a recommendation or a business competitor.
    competitorDomains: [...new Set(citations.map((url) => host(url)!).filter((h) => !isTarget(h)))],
    excerpt: answer.text.slice(0, 2000),
  };
}

/** Explicit brand clauses only: no pronoun resolution, source lists, or cross-brand attribution. */
export function brandClauses(text: string, names: string[], otherNames: string[] = []) {
  const prose = text.split(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:sources?|references?|kaynaklar)(?:\*\*|__)?\s*:?/im)[0]
    .replace(/https?:\/\/[^\s<>"\])}]+/gi, "").replace(/[*_`]/g, "");
  return prose.split(/(?<=[.!?])\s+|\n+|;\s*|\b(?:but|whereas|while|ancak|ama|oysa)\b/giu)
    .map((s) => s.trim()).filter((s) => s && names.some((n) => containsName(s, n)) && !otherNames.some((n) => containsName(s, n)));
}

const positive = new Set(["good", "great", "excellent", "reliable", "recommended", "recommend", "best", "affordable", "iyi", "harika", "güvenilir", "kaliteli", "başarılı"]);
const negative = new Set(["bad", "poor", "unreliable", "unsafe", "expensive", "avoid", "terrible", "scam", "kötü", "güvensiz", "pahalı", "başarısız", "dolandırıcı"]);
const negation = /^(?:not|no|never|isn't|isnt|don't|dont|doesn't|doesnt|değil|yok)$/iu;

/** Small EN/TR lexicon: evidence for human review, not a general-purpose sentiment model. */
export function analyzeBrandSentiment(text: string, site: { url: string; title: string }, otherNames: string[] = []) {
  const clauses = brandClauses(text, [site.title, host(site.url) ?? ""], otherNames);
  const evidence = clauses.map((clause) => {
    const words = clause.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    const terms: { term: string; polarity: number }[] = [];
    words.forEach((word, i) => {
      const base = positive.has(word) ? 1 : negative.has(word) ? -1 : 0;
      if (!base) return;
      const negated = words.slice(Math.max(0, i - 3), i).some((w) => negation.test(w)) || negation.test(words[i + 1] ?? "");
      terms.push({ term: word, polarity: negated ? -base : base });
    });
    const sum = terms.reduce((n, t) => n + t.polarity, 0);
    return { text: clause.slice(0, 1000), score: terms.length ? sum / terms.length : 0, terms };
  });
  const score = evidence.length ? evidence.reduce((n, e) => n + e.score, 0) / evidence.length : null;
  return { label: score === null ? "unknown" : score > 0 ? "positive" : score < 0 ? "negative" : "neutral", score, evidence: evidence.slice(0, 50), evidenceCount: evidence.length, method: "brand-clause-en-tr-lexicon-v1" };
}

export function auditBrandClaims(text: string, facts: VisibilityAnalysisSettings["facts"], at: Date, otherNames: string[] = []) {
  const active = facts.filter((f) => Date.parse(f.verifiedAt) <= +at && Date.parse(f.validUntil) >= +at);
  const findings = active.flatMap((fact) => brandClauses(text, [fact.subject], otherNames).flatMap((clause) => {
    // ponytail: ambiguous/negated claims stay unknown; semantic verification needs a separate adjudicator.
    if (/\b(?:not|never|no|isn't|don't|doesn't|may|might|rumou?r|alleged)\b|değil|yok|olabilir|[?"“”]/iu.test(clause)) return [];
    return fact.conflictingClaims.filter((claim) => containsName(clause, claim)).map((claim) => ({
      rule: "verified-fact-conflict", severity: "potential_hallucination", subject: fact.subject,
      text: clause.slice(0, 1000), conflictingClaim: claim, expected: fact.expected,
      sourceUrl: fact.sourceUrl, verifiedAt: fact.verifiedAt, validUntil: fact.validUntil,
    }));
  }));
  return { status: findings.length ? "needs_review" : "unknown", checkedFacts: active.length, findings: findings.slice(0, 100), findingCount: findings.length, method: "literal-verified-fact-rules-v1" };
}
