// Presentation helpers shared by dashboard components (pure, no React).

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

/** Score band: 80+ good, 60+ warning, 40+ serious, below critical. */
export function scoreTone(score: number | null | undefined): Tone {
  if (score == null || Number.isNaN(score)) return "neutral";
  if (score >= 80) return "good";
  if (score >= 60) return "warning";
  if (score >= 40) return "serious";
  return "critical";
}

export function scoreLabel(score: number | null | undefined): string {
  return { good: "İyi", warning: "Orta", serious: "Zayıf", critical: "Kritik", neutral: "Veri yok" }[scoreTone(score)];
}

export const MODEL_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
  copilot: "Copilot",
  other: "Diğer",
};
export const VISIBILITY_MODEL_ORDER = ["chatgpt", "gemini", "claude", "perplexity"] as const;

export const CITATION_LABELS: Record<string, string> = { cited: "Atıf (kaynak)", mentioned: "Bahsedildi", none: "Yer almadı" };

/** "Ne Yapılmalı?" tiers mapped from ActionItem.impact. */
export const TIERS = [
  { impact: "high", label: "Kritik", tone: "critical" as Tone },
  { impact: "medium", label: "Önemli", tone: "serious" as Tone },
  { impact: "low", label: "İyileştirme", tone: "good" as Tone },
] as const;
export function tierFor(impact: string) {
  return TIERS.find((t) => t.impact === impact) ?? TIERS[2];
}

export const CATEGORY_LABELS: Record<string, string> = {
  crawler: "AI Bot Erişimi",
  schema: "Yapısal Veri",
  content: "İçerik",
  authority: "Otorite / E-E-A-T",
  technical: "Teknik",
};
export const EFFORT_LABELS: Record<string, string> = { high: "Yüksek efor", medium: "Orta efor", low: "Düşük efor" };
export const ACTION_STATUS_LABELS: Record<string, string> = {
  open: "Açık",
  in_progress: "Üzerinde çalışılıyor",
  resolved: "Çözüldü",
  dismissed: "Yok sayıldı",
};

export const ENTITY_LABELS: Record<string, string> = {
  Page: "Sayfa",
  Product: "Ürün",
  Category: "Kategori",
  FAQ: "SSS",
  Question: "SSS",
  Organization: "Kurum",
  Author: "Yazar",
  Person: "Yazar",
  Brand: "Marka",
  Article: "Makale",
  Concept: "Kavram",
  Offer: "Teklif",
  WebSite: "Web sitesi",
};

export const PLATFORM_LABELS: Record<string, string> = {
  indexnow: "IndexNow",
  google_indexing: "Google Indexing API",
  google_search_console: "Search Console",
  webhook: "Webhook",
};

const dateFmt = new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short" });

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

export function formatDay(value: string | Date): string {
  return dayFmt.format(new Date(value));
}

/** "3 dk önce", "2 gün önce" … */
export function timeAgo(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const sec = Math.round((now - new Date(value).getTime()) / 1000);
  if (Number.isNaN(sec)) return "—";
  if (sec < 45) return "az önce";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} dk önce`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} saat önce`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day} gün önce`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} ay önce`;
  return `${Math.round(month / 12)} yıl önce`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
