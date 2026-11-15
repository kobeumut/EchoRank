// Server-side locale resolution (Server Components, Route Handlers, services).
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, resolveLocale, type Locale } from "./config";
import { getMessages, en } from "./messages";
import { createTranslator, type Translator } from "./translate";

/** Locale of the current request: `locale` cookie → `Accept-Language` → English. */
export async function getLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale({ cookie: cookieStore.get(LOCALE_COOKIE)?.value, acceptLanguage: headerStore.get("accept-language") });
}

export async function getT(locale?: Locale): Promise<Translator> {
  const resolved = locale ?? (await getLocale());
  return createTranslator(getMessages(resolved), resolved, en);
}

export { DEFAULT_LOCALE };
