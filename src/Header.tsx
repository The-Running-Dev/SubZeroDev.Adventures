import type { ReactNode } from "react";
import { ThemeSelector } from "./ThemeSelector";
import type { ThemeId } from "./theme";

interface HeaderProps {
  /**
   * Which top-level nav item the current page is: the disk shelf at `"/"`
   * (`"shelf"`), a story actually loaded and in progress there (`"playing"`), or one
   * of the standalone pages reached by a real navigation (`"standings"`, `"profile"`).
   */
  current: "shelf" | "playing" | "standings" | "profile";
  /** The loaded story's title -- required, and only ever shown, while `current` is
   *  `"playing"`. A third nav item next to "Standings", marking that specific story
   *  current instead of "Disk library" while it's the thing actually on screen. */
  playingTitle?: string;
  /**
   * Only supplied by the single-page app (PlayApp.tsx): lets "Disk library" return to
   * the shelf in place (abandoning an in-progress run first, if any) instead of a full
   * navigation. Every other page has no such state -- "Disk library" there is a plain
   * link back to `/`.
   */
  onSelectShelf?: () => void;
  theme: ThemeId;
  onThemeChange: (id: ThemeId) => void;
  /** The account menu -- PlayApp's and the profile page's, since both carry identity
   *  state. Omitted entirely (not rendered empty) where it doesn't apply. */
  children?: ReactNode;
}

/**
 * The global header, shared across every page this site has: the single-page app
 * (PlayApp.tsx), the standings page (src/ranking/Ranking.tsx), and a player's own
 * profile (src/profile/OwnProfile.tsx). "Disk library" and "Standings" are peer nav
 * items; the account menu (when present) and the display-mode select sit alongside them.
 */
export function Header({
  current,
  playingTitle,
  onSelectShelf,
  theme,
  onThemeChange,
  children,
}: HeaderProps) {
  return (
    <header className="system-bar">
      <nav className="system-bar-nav" aria-label="Primary">
        {onSelectShelf ? (
          <button
            className="system-bar-link"
            aria-current={current === "shelf" ? "page" : undefined}
            onClick={onSelectShelf}
          >
            Disk library
          </button>
        ) : (
          <a className="system-bar-link" href="/">
            Disk library
          </a>
        )}
        <a
          className="system-bar-link"
          href="/ranking"
          aria-current={current === "standings" ? "page" : undefined}
        >
          Standings
        </a>
        {current === "playing" && playingTitle && (
          <span
            className="system-bar-link system-bar-current-story"
            aria-current="page"
          >
            {playingTitle}
          </span>
        )}
      </nav>
      {children}
      <ThemeSelector theme={theme} onChange={onThemeChange} />
    </header>
  );
}
