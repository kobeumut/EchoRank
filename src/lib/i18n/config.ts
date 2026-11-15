// Locale configuration shared by server and client code. Pure module: no React, no Next.js imports.

export const LOCALES = ["en", "tr"] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the default and the fallback for every missing translation. */
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie that stores the user's explicit choice (set by the language switcher). */
export const LOCALE_COOKIE = "locale";

/** Native names, shown in the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", tr: "Türkçe" };

/** BCP 47 tags used for `Intl` date / number formatting. */
export const INTL_LOCALES: Record<Locale, string> = { en: "en-US", tr: "tr-TR" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Normalises "tr-TR", "TR", "en_GB" … to a supported locale, or null. */
export function toLocale(value: string | null | undefined): Locale | null {
  const base = value?.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}

/** Picks the best supported locale from an `Accept-Language` header (quality-ordered). */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag, q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((x) => x.tag && x.tag !== "*" && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const locale = toLocale(tag);
    if (locale) return locale;
  }
  return null;
}

/** Resolution order: explicit choice (cookie / `?lang=`) → `Accept-Language` → default (`en`). */
export function resolveLocale(input: { cookie?: string | null; query?: string | null; acceptLanguage?: string | null }): Locale {
  return toLocale(input.query) ?? toLocale(input.cookie) ?? negotiateLocale(input.acceptLanguage) ?? DEFAULT_LOCALE;
}
