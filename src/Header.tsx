import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import { LanguageSelector } from "./components/LanguageSelector";
import "./styles/app.css";
import { Link, useLocation } from "react-router";
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
  const { t } = useTranslation("shell");
  const { pathname } = useLocation();
  const more = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (more.current) more.current.open = false;
  }, [pathname]);
  if (hidden)
    return (
      <div className="onboarding-language">
        <LanguageSelector />
      </div>
    );
  const playing = current === "playing";
  return (
    <header
      className={`system-bar app-header${playing ? " app-header--playing" : ""}`}
    >
      <Link className="app-brand" to="/" aria-label={t("home")}>
        S0<span>ADVENTURES</span>
      </Link>
      <nav className="system-bar-nav" aria-label={t("primary")}>
        {onSelectShelf ? (
          <button
            className="system-bar-link"
            aria-current={current === "shelf" ? "page" : undefined}
            onClick={onSelectShelf}
          >
            {t("library")}
          </button>
        ) : (
          <Link
            className="system-bar-link"
            to="/"
            aria-current={current === "shelf" ? "page" : undefined}
          >
            {t("library")}
          </Link>
        )}
        <Link
          className="system-bar-link"
          to="/ranking"
          aria-current={current === "standings" ? "page" : undefined}
        >
          {t("standings")}
        </Link>
        <Link
          className="system-bar-link"
          to="/discussions"
          aria-current={current === "discussions" ? "page" : undefined}
        >
          {t("community")}
        </Link>
        <details
          className="nav-more"
          ref={more}
          onKeyDown={(event) => {
            if (event.key === "Escape" && more.current) {
              more.current.open = false;
              more.current.querySelector("summary")?.focus();
            }
          }}
        >
          <summary className="system-bar-link">{t("more")}</summary>
          <div className="nav-more-panel">
            <Link
              className="system-bar-link"
              to="/profile"
              aria-current={current === "profile" ? "page" : undefined}
            >
              {t("me")}
            </Link>

            <Link
              className="system-bar-link"
              to="/content"
              aria-current={current === "content" ? "page" : undefined}
            >
              {t("content")}
            </Link>
            <Link
              className="system-bar-link"
              to="/start"
              aria-current={current === "start" ? "page" : undefined}
            >
              {t("start")}
            </Link>
          </div>
        </details>
      </nav>
      {playing && playingTitle && (
        <span className="system-bar-current-story" aria-current="page">
          {playingTitle}
        </span>
      )}
      <div className="app-preferences">
        {children}
        <ThemeSelector theme={theme} onChange={onThemeChange} />
        <LanguageSelector />
      </div>
    </header>
  );
}
