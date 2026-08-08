export const THEMES = [
  { id: "dos", label: "DOS Blue" },
  { id: "matrix", label: "Matrix" },
  { id: "amber", label: "Amber CRT" },
  { id: "bbs", label: "Terminal" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "bbs";

const STORAGE_KEY = "subzerodev.play.theme.v1";

const THEME_COLORS: Readonly<Record<ThemeId, string>> = {
  dos: "#090a0d",
  matrix: "#000000",
  amber: "#140c00",
  bbs: "#000000",
};

function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

/** Storage can throw (private browsing, full quota); the default theme is always a safe fallback. */
export function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Best-effort: the theme still applies for this page view.
  }
}

/**
 * Also keeps the note in `index.html`'s pre-paint script true: this key and
 * the theme ids there duplicate this module's constants because that script
 * runs before any bundle loads and cannot import from it. Keep them in sync.
 */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[id]);
}
