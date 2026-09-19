import { Link } from "react-router";
import type { ReactNode } from "react";
import { ThemeSelector } from "./ThemeSelector";
import type { ThemeId } from "./theme";

interface HeaderProps {
  /**
   * Which top-level nav item the current page is: the disk shelf at `"/"`
   * (`"shelf"`), a story actually loaded and in progress there (`"playing"`), or one
   * of the routed pages reached by client-side navigation (`"standings"`, `"profile"`,
   * `"content"`, `"start"`, `"discussions"`).
   */
  current:
    | "shelf"
    | "playing"
    | "standings"
    | "profile"
    | "content"
    | "start"
    | "discussions";
  /** The loaded story's title -- required, and only ever shown, while `current` is
   *  `"playing"`. A third nav item next to "Standings", marking that specific story
   *  current instead of "Disk library" while it's the thing actually on screen. */
  playingTitle?: string;
  /**
   * Supplied by the player through AppShell: lets "Disk library" return to
   * the shelf in place (abandoning an in-progress run first, if any) without navigating away.
   * Every other page has no such state -- "Disk library" there is a plain
   * link back to `/`.
   */
  onSelectShelf?: () => void;
  theme: ThemeId;
  onThemeChange: (id: ThemeId) => void;
  /** The persistent account menu, supplied by AppShell when an API is configured. */
  children?: ReactNode;
  hidden?: boolean;
}

/**
 * The global header, shared across every page this site has: the single-page app
 * (PlayApp.tsx), the standings page (src/ranking/Ranking.tsx), a player's own profile
 * (src/profile/OwnProfile.tsx), and the operator channel (src/discussions/Discussions.tsx).
 * "Disk library", "Standings", "My content", "Getting started", and "Discussions" are peer
 * nav items; the account menu (when present) and the display-mode select sit alongside them.
 */
export function Header({
  current,
  playingTitle,
  onSelectShelf,
  theme,
  onThemeChange,
  children,
  hidden,
}: HeaderProps) {
  return (
    <header
      className="system-bar"
      hidden={hidden}
      style={hidden ? { display: "none" } : undefined}
    >
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
          <Link className="system-bar-link" to="/">
            Disk library
          </Link>
        )}
        <Link
          className="system-bar-link"
          to="/ranking"
          aria-current={current === "standings" ? "page" : undefined}
        >
          Standings
        </Link>
        <Link
          className="system-bar-link"
          to="/content"
          aria-current={current === "content" ? "page" : undefined}
        >
          My content
        </Link>
        <Link
          className="system-bar-link"
          to="/start"
          aria-current={current === "start" ? "page" : undefined}
        >
          Getting started
        </Link>
        <Link
          className="system-bar-link"
          to="/discussions"
          aria-current={current === "discussions" ? "page" : undefined}
        >
          Discussions
        </Link>
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
