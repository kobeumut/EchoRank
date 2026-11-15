"use client";

import { useMemo } from "react";
import { useLocale, useT } from "@/lib/i18n/provider";
import { formatDate, formatDay, labelFor, scoreLabel, tierFor, timeAgo, type LabelGroup } from "@/lib/dashboard/format";

/**
 * Locale-bound versions of the helpers in `lib/dashboard/format.ts`, so components do not have to
 * thread `t` / the `Intl` tag through every call:
 *
 *   const { t, formatDate, label } = useFormat();
 *   label("model", record.model)  // → "ChatGPT"
 */
export function useFormat() {
  const t = useT();
  const { locale, intlLocale } = useLocale();
  return useMemo(
    () => ({
      t,
      locale,
      intlLocale,
      formatDate: (value: string | Date | null | undefined) => formatDate(value, intlLocale),
      formatDay: (value: string | Date) => formatDay(value, intlLocale),
      timeAgo: (value: string | Date | null | undefined) => timeAgo(value, t),
      scoreLabel: (score: number | null | undefined) => scoreLabel(score, t),
      tierFor: (impact: string) => tierFor(impact, t),
      label: (group: LabelGroup, value: string) => labelFor(t, group, value),
    }),
    [t, locale, intlLocale],
  );
}
