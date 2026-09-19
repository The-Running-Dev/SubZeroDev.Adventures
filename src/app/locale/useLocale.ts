import { useTranslation } from "react-i18next";
import { LOCALE_STORAGE_KEY, type Locale } from "./locale";

export function useLocale() {
  const { i18n } = useTranslation();
  const locale: Locale = i18n.resolvedLanguage === "bg" ? "bg" : "en";
  const intlLocale = locale === "bg" ? "bg-BG" : "en";
  return {
    locale,
    async changeLocale(next: Locale) {
      await i18n.changeLanguage(next);
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        /* In-memory switching still succeeds. */
      }
    },
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(intlLocale, options).format(value),
    date: (
      value: string | number | Date,
      options?: Intl.DateTimeFormatOptions,
    ) => new Intl.DateTimeFormat(intlLocale, options).format(new Date(value)),
    relativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) =>
      new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" }).format(
        value,
        unit,
      ),
  };
}
