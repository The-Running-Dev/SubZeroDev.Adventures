/**
 * `/start` -- the getting-started page.
 *
 * Built from the design bundle's turn-2 direction 2b (the setup-dialog chrome: a double-ruled
 * dialog, a numbered menu, a block progress bar, an F-key legend along the bottom). Two
 * deliberate departures from that bundle:
 *
 *  - **It is not the mockup's DOS Blue.** Every colour here comes from `themes.css`, so the
 *    page renders in whichever of the four display modes the visitor has chosen, exactly as
 *    the rest of the site does. The bundle drew each direction in one fixed palette because
 *    it had no theme system to draw against; this repository has one, and a page pinned to a
 *    single palette would be the only such page on the site.
 *  - **The authoring door is not locked.** The mockup gates "write a campaign" behind
 *    "finish a run first". That was written before the wizard existed, and gating the feature
 *    on progress nothing currently records would mean inventing the tracking to gate it with.
 *
 * This page does not replace the hidden `getting-started` campaign that auto-starts on a
 * visitor's first-ever load (`src/play/composition.ts`). They answer different questions --
 * that one is played, this one is read -- and the campaign is unchanged by this file.
 */
import { useEffect, useState } from "react";
import { Header } from "../Header";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
  type ThemeId,
} from "../theme";
import { blockBar, useBranch } from "./branch";
import {
  AUTHOR_PATH_ID,
  BOOT_LINES,
  CHECK_MARK,
  PATHS,
  type StartPath,
} from "./content";
import { Wizard } from "./Wizard";

/** One menu row's contents, shared by the button and link forms above.
 *
 *  The explicit spaces are the accessible name: adjacent JSX elements concatenate with
 *  nothing between them, so without them this reads as
 *  "A)Play a campaignnothing to install~5 min". */
function MenuRow({ path }: { readonly path: StartPath }) {
  return (
    <>
      <span className="gs-menu-key gs-amber">{path.key})</span>{" "}
      <span className="gs-menu-label">{path.title}</span>{" "}
      <span className="gs-dim">{path.meta}</span>{" "}
      <span className="gs-menu-time">{path.time}</span>
    </>
  );
}

export function StartPage({ apiUrl }: { readonly apiUrl?: string }) {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);
  function changeTheme(id: ThemeId): void {
    setTheme(id);
    applyTheme(id);
    storeTheme(id);
  }

  const branch = useBranch(PATHS);
  const [authoring, setAuthoring] = useState(false);

  function pick(id: string): void {
    if (id === AUTHOR_PATH_ID) {
      setAuthoring(true);
      return;
    }
    branch.pick(id);
  }

  return (
    <main className="play-main">
      <Header current="start" theme={theme} onThemeChange={changeTheme} />

      <section className="gs-page" aria-labelledby="start-title">
        {authoring ? (
          <Wizard apiUrl={apiUrl} onExit={() => setAuthoring(false)} />
        ) : (
          <div className="gs-dialog">
            <div className="gs-dialog-title">SUBZERODEV ADVENTURES — SETUP</div>

            {branch.onLanding ? (
              <div className="gs-dialog-body">
                <div className="gs-walk-body">
                  <h1 id="start-title" className="gs-shadow-title">
                    What are you here to do?
                  </h1>
                  <p className="gs-prose">
                    Pick an option. Nothing here is a commitment — every path is
                    a few minutes long, and you can come back and take a
                    different one.
                  </p>
                </div>

                <div className="gs-menu">
                  {PATHS.map((path) =>
                    // A path with an `href` navigates rather than advancing the branch
                    // machine, so it is a real link -- middle-clickable, copyable, and
                    // announced as a link -- not a button that calls `location.assign`.
                    path.href ? (
                      <a key={path.id} className="gs-menu-row" href={path.href}>
                        <MenuRow path={path} />
                      </a>
                    ) : (
                      <button
                        key={path.id}
                        type="button"
                        className="gs-menu-row"
                        onClick={() => pick(path.id)}
                      >
                        <MenuRow path={path} />
                      </button>
                    ),
                  )}
                </div>

                <div className="gs-columns">
                  <div className="gs-col">
                    <span className="gs-eyebrow gs-amber">WHAT IS RUNNING</span>
                    <ul className="gs-checks">
                      {BOOT_LINES.map((line) => (
                        <li key={line.label} className="gs-check gs-check-done">
                          <span aria-hidden="true">{CHECK_MARK.done}</span>{" "}
                          {line.label} — {line.value}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="gs-col">
                    <span className="gs-eyebrow gs-amber">ALREADY HERE</span>
                    <p className="gs-dim">
                      The disk library needs no account. Standings, saved runs
                      across devices, and submitting your own campaign are what
                      an account adds.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="gs-dialog-body">
                <div className="gs-walk">
                  <div className="gs-walk-head">
                    <span className="gs-accent">
                      {branch.selected?.key}) {branch.selected?.title}
                    </span>
                    <span className="gs-dim">
                      STEP {branch.step} / {branch.total} · {branch.percent}%
                    </span>
                  </div>

                  <div className="gs-blockbar" aria-hidden="true">
                    {blockBar(branch.step, branch.total)}
                  </div>
                  <progress
                    className="visually-hidden"
                    value={branch.step}
                    max={branch.total}
                  />

                  <div className="gs-walk-body">
                    <h1 id="start-title" className="gs-walk-title">
                      {branch.screen?.title}
                    </h1>
                    <p className="gs-prose">{branch.screen?.body}</p>
                  </div>

                  <ul className="gs-checks">
                    {branch.screen?.checks.map((check) => (
                      <li
                        key={check.label}
                        className={`gs-check gs-check-${check.state}`}
                      >
                        <span aria-hidden="true">
                          {CHECK_MARK[check.state]}
                        </span>{" "}
                        {check.label}
                      </li>
                    ))}
                  </ul>

                  {branch.isLast && (
                    <p className="gs-note">
                      That is the whole path.{" "}
                      <a href="/">Open the disk library</a> when you want to
                      start.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="gs-legend">
              <button
                type="button"
                className="gs-legend-btn"
                onClick={branch.restart}
                disabled={branch.onLanding}
              >
                F3 MENU
              </button>
              <div className="gs-actions">
                <button
                  type="button"
                  className="gs-legend-btn"
                  onClick={branch.back}
                  disabled={branch.onLanding}
                >
                  ESC BACK
                </button>
                <button
                  type="button"
                  className="gs-legend-btn"
                  onClick={branch.next}
                  disabled={branch.onLanding || branch.isLast}
                >
                  ENTER CONTINUE
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
