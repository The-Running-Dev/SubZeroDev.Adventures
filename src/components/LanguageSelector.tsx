import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
import type { Locale } from "../app/locale/locale";

export function LanguageSelector() {
  const { t } = useTranslation();
  const { locale, changeLocale } = useLocale();
  return (
    <label className="system-bar-group locale-control">
      <span className="system-bar-label">{t("language")}</span>
      <select
        className="theme-select"
        value={locale}
        onChange={(event) => void changeLocale(event.target.value as Locale)}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="bg" lang="bg">
          Български
        </option>
      </select>
    </label>
  );
}
