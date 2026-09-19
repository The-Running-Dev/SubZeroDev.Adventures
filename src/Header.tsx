import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
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
   *  `"playing"`. A sibling of the nav rather than an item inside it: the primary
   *  destinations are a fixed set of short labels, and a story title is the one thing
   *  here with no length bound. Hidden outright below 768px (`play.css`), where the
   *  cabinet marquee's own `<h1>` names the loaded story a row further down. */
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
 * "Disk library", "Standings" and "Community" are the primary destinations; "Me", "My
 * content" and "Getting started" sit behind a "More" disclosure, which marks itself
 * `aria-current` when the page is one of its own (the real `aria-current="page"` link is
 * unreachable while the panel is closed -- see the `<summary>` below). The account menu
 * (when present), the display-mode select and the language select sit in
 * `.app-preferences`, on their own row.
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
  /* `<details>` owns its own `open`, so this mirrors it rather than driving it -- the
     `toggle` event fires for a real click and for the imperative closes below alike. */
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => {
    if (more.current) more.current.open = false;
    setMoreOpen(false);
  }, []);
  useEffect(() => {
    closeMore();
  }, [pathname, closeMore]);
  /* Dismiss on an outside click, the same way the account menu beside it does
     (`AccountPanel.tsx`) -- two adjacent disclosures that closed differently would read
     as one of them being broken. */
  useEffect(() => {
    if (!moreOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!more.current?.contains(event.target as Node)) closeMore();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [moreOpen, closeMore]);
  if (hidden)
    return (
      <div className="onboarding-language">
        <LanguageSelector />
      </div>
    );
  const playing = current === "playing";
  const moreCurrent =
    current === "profile" || current === "content" || current === "start";
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
          onToggle={(event) => setMoreOpen(event.currentTarget.open)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && more.current) {
              const summary = more.current.querySelector("summary");
              closeMore();
              summary?.focus();
            }
          }}
        >
          {/* A closed `<details>` is `content-visibility: hidden`, so the
              `aria-current="page"` link inside the panel is painted by nothing and
              reaches no accessibility tree. Without this the three destinations behind
              "More" are the only pages on the site with no navigation state at all. */}
          <summary
            className="system-bar-link"
            aria-current={moreCurrent ? "true" : undefined}
          >
            {t("more")}
          </summary>
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
