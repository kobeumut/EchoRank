// Presentation helpers shared by dashboard components (pure, no React). Labels come from the i18n catalogs.

import type { Translator } from "@/lib/i18n/translate";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

/** Score band: 80+ good, 60+ warning, 40+ serious, below critical. */
export function scoreTone(score: number | null | undefined): Tone {
  if (score == null || Number.isNaN(score)) return "neutral";
  if (score >= 80) return "good";
  if (score >= 60) return "warning";
  if (score >= 40) return "serious";
  return "critical";
}

export function scoreLabel(score: number | null | undefined, t: Translator): string {
  return t(`labels.score.${scoreTone(score)}`);
}

/** Display order of the AI models in the visibility checks (labels: `labels.model.*`). */
export const VISIBILITY_MODEL_ORDER = ["chatgpt", "gemini", "claude", "perplexity"] as const;

/**
 * Localised label for a stored enum value, from the `labels.<group>.<value>` catalog entries.
 * Unknown values are shown as-is rather than as a missing-key placeholder.
 */
export type LabelGroup = "model" | "citation" | "category" | "effort" | "actionStatus" | "entity" | "platform";
export function labelFor(t: Translator, group: LabelGroup, value: string): string {
  const key = `labels.${group}.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

/** "What should be done?" tiers mapped from ActionItem.impact. */
export const TIERS = [
  { impact: "high", tone: "critical" as Tone },
  { impact: "medium", tone: "serious" as Tone },
  { impact: "low", tone: "good" as Tone },
] as const;
export function tierFor(impact: string, t: Translator) {
  const tier = TIERS.find((x) => x.impact === impact) ?? TIERS[2];
  return { ...tier, label: t(`labels.tier.${tier.impact}`) };
}

export const DEFAULT_INTL_LOCALE = "en-US";

export function formatDate(value: string | Date | null | undefined, intlLocale: string = DEFAULT_INTL_LOCALE): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function formatDay(value: string | Date, intlLocale: string = DEFAULT_INTL_LOCALE): string {
  return new Intl.DateTimeFormat(intlLocale, { day: "2-digit", month: "short" }).format(new Date(value));
}

/** "3 min ago", "2 days ago" … (catalog keys `labels.time.*`) */
export function timeAgo(value: string | Date | null | undefined, t: Translator, now = Date.now()): string {
  if (!value) return "—";
  const sec = Math.round((now - new Date(value).getTime()) / 1000);
  if (Number.isNaN(sec)) return "—";
  if (sec < 45) return t("labels.time.justNow");
  const min = Math.round(sec / 60);
  if (min < 60) return t("labels.time.minutesAgo", { count: min });
  const hour = Math.round(min / 60);
  if (hour < 24) return t("labels.time.hoursAgo", { count: hour });
  const day = Math.round(hour / 24);
  if (day < 30) return t("labels.time.daysAgo", { count: day });
  const month = Math.round(day / 30);
  if (month < 12) return t("labels.time.monthsAgo", { count: month });
  return t("labels.time.yearsAgo", { count: Math.round(month / 12) });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
