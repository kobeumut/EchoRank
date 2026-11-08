export const VISIBILITY_MODELS = ["chatgpt", "gemini", "claude", "perplexity"] as const;
export type VisibilityModel = (typeof VISIBILITY_MODELS)[number];
export type SearchAnswer = { text: string; citations: string[] };

function host(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch { return null; }
}

function containsName(text: string, name: string) {
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
