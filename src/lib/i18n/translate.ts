// Dependency-free message lookup: `{name}` interpolation and CLDR plural suffixes (`_one` / `_other` …).

import { DEFAULT_LOCALE, INTL_LOCALES, type Locale } from "./config";

export type Messages = Record<string, string>;
export type Params = Record<string, string | number | null | undefined>;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name] ?? "") : match));
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(INTL_LOCALES[locale])));
  return rules.select(count);
}

/**
 * Looks `key` up in `messages`, then in `fallback` (English), then returns the key itself.
 * If `params.count` is a number and `key_<plural category>` exists, that variant is used
 * (falling back to `key_other`, then to the plain key).
 */
export function translate(messages: Messages, key: string, params?: Params, locale: Locale = DEFAULT_LOCALE, fallback: Messages = {}): string {
  const lookup = (source: Messages) => {
    if (typeof params?.count === "number") {
      const plural = source[`${key}_${pluralCategory(locale, params.count)}`] ?? source[`${key}_other`];
      if (plural !== undefined) return plural;
    }
    return source[key];
  };
  return interpolate(lookup(messages) ?? lookup(fallback) ?? key, params);
}

/** A translator bound to a locale (what `useT()` / `getT()` return). */
export type Translator = (key: string, params?: Params) => string;

export function createTranslator(messages: Messages, locale: Locale, fallback: Messages = {}): Translator {
  return (key, params) => translate(messages, key, params, locale, fallback);
}
