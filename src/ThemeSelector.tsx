import { useTranslation } from "react-i18next";
import { THEMES, type ThemeId } from "./theme";

/**
 * The display-mode control. It renders only its own label + select, not the surrounding
 * bar: `.system-bar` is the app's global header (PlayApp.tsx), which also carries the
 * standings link and the account menu.
 */
export function ThemeSelector({
  theme,
  onChange,
}: {
  theme: ThemeId;
  onChange: (id: ThemeId) => void;
}) {
  const { t } = useTranslation("shell");
  return (
    <div className="system-bar-group">
      <label className="system-bar-label" htmlFor="theme-select">
        {t("display")}
      </label>
      <select
        id="theme-select"
        className="theme-select"
        value={theme}
        onChange={(event) => onChange(event.target.value as ThemeId)}
      >
        {THEMES.map((option) => (
          <option key={option.id} value={option.id}>
            {t(`themes.${option.id}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
