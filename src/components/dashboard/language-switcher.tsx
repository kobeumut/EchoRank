"use client";

import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n/config";
import { useLocale, useT } from "@/lib/i18n/provider";

/** Compact EN / TR toggle for the header. The choice is stored in the `locale` cookie. */
export function LanguageSwitcher() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <div role="group" aria-label={t("common.language")} className="flex items-center rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
      {LOCALES.map((code: Locale) => (
        <button
          key={code}
          type="button"
          lang={code}
          title={LOCALE_NAMES[code]}
          aria-pressed={locale === code}
          onClick={() => locale !== code && setLocale(code)}
          className={`rounded px-1.5 py-1 font-medium uppercase ${locale === code ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"}`}
        >
          {code}
        </button>
      ))}
    </div>
  );
}
