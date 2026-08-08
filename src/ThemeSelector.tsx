import { THEMES, type ThemeId } from "./theme";

export function ThemeSelector({
  theme,
  onChange,
}: {
  theme: ThemeId;
  onChange: (id: ThemeId) => void;
}) {
  return (
    <div className="system-bar">
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
