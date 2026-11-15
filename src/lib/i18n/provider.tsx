"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { INTL_LOCALES, LOCALE_COOKIE, type Locale } from "./config";
import { createTranslator, type Messages, type Translator } from "./translate";

type I18nValue = { locale: Locale; intlLocale: string; t: Translator; setLocale: (next: Locale) => void };

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Receives the active locale and its (English-filled) messages from the root layout, so only one
 * catalog is shipped to the browser.
 */
export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) {
  const router = useRouter();
  const setLocale = useCallback(
    (next: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    },
    [router],
  );
  const value = useMemo<I18nValue>(
    () => ({ locale, intlLocale: INTL_LOCALES[locale], t: createTranslator(messages, locale), setLocale }),
    [locale, messages, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useT/useLocale must be used inside <I18nProvider>");
  return value;
}

/** `const t = useT(); t(key, params)` — `{param}` interpolation and `_one`/`_other` plurals via `count`. */
export function useT(): Translator {
  return useI18n().t;
}

/** Active locale plus its BCP 47 tag for `Intl` (`intlLocale`) and the setter used by the language switcher. */
export function useLocale() {
  const { locale, intlLocale, setLocale } = useI18n();
  return { locale, intlLocale, setLocale };
}
