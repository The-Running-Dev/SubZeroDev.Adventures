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
  return (
    <div className="system-bar-group">
      <label className="system-bar-label" htmlFor="theme-select">
        DISPLAY MODE
      </label>
      <select
        id="theme-select"
        className="theme-select"
        value={theme}
        onChange={(event) => onChange(event.target.value as ThemeId)}
      >
        {THEMES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
