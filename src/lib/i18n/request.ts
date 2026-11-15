// Locale resolution for Route Handlers and background services that only have a `Request`.
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./config";
import { getMessages, en } from "./messages";
import { createTranslator, type Translator } from "./translate";

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Locale for an API request: `?lang=` (or `?locale=`) → `locale` cookie → `Accept-Language` → English.
 * Programmatic clients (cron, curl) get English unless they ask for another language.
 */
export function localeFromRequest(request: Request): Locale {
  const url = new URL(request.url);
  return resolveLocale({
    query: url.searchParams.get("lang") ?? url.searchParams.get("locale"),
    cookie: cookieValue(request.headers.get("cookie"), LOCALE_COOKIE),
    acceptLanguage: request.headers.get("accept-language"),
  });
}

/** Translator for server-side code that is not tied to React (services, report renderers, API routes). */
export function serverT(locale: Locale): Translator {
  return createTranslator(getMessages(locale), locale, en);
}
