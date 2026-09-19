import { useTranslation } from "react-i18next";
import { Link } from "react-router";
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
import { useState } from "react";
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
  const { t } = useTranslation("onboarding");
  const paths = PATHS.map((p) => ({
    ...p,
    title: t(`paths.${p.id}.title`),
    meta: t(`paths.${p.id}.meta`),
    time: t(`paths.${p.id}.time`),
    walk: p.walk.map((w, i) => ({
      ...w,
      title: t(`paths.${p.id}.walk.${i}.title`),
      body: t(`paths.${p.id}.walk.${i}.body`),
      checks: w.checks.map((c, j) => ({
        ...c,
        label: t(`paths.${p.id}.walk.${i}.checks.${j}`),
      })),
    })),
  }));
  const branch = useBranch(paths);
  const [authoring, setAuthoring] = useState(false);

  function pick(id: string): void {
    if (id === AUTHOR_PATH_ID) {
      setAuthoring(true);
      return;
    }
    branch.pick(id);
  }

  return (
    <>
      <section className="gs-page" aria-labelledby="start-title">
        {authoring ? (
          <Wizard apiUrl={apiUrl} onExit={() => setAuthoring(false)} />
        ) : (
          <div className="gs-dialog">
            <div className="gs-dialog-title">{t("setup")}</div>

            {branch.onLanding ? (
              <div className="gs-dialog-body">
                <div className="gs-walk-body">
                  <h1 id="start-title" className="gs-shadow-title">
                    {t("title")}
                  </h1>
                  <p className="gs-prose">{t("intro")}</p>
                </div>

                <div className="gs-menu">
                  {paths.map((path) =>
                    // A path with an `href` navigates rather than advancing the branch
                    // machine, so it is a real link -- middle-clickable, copyable, and
                    // announced as a link -- not a button that calls `location.assign`.
                    path.href ? (
                      <Link
                        key={path.id}
                        className="gs-menu-row"
                        to={path.href}
                      >
                        <MenuRow path={path} />
                      </Link>
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
                    <span className="gs-eyebrow gs-amber">{t("running")}</span>
                    <ul className="gs-checks">
                      {BOOT_LINES.map((line, i) => (
                        <li key={line.label} className="gs-check gs-check-done">
                          <span aria-hidden="true">{CHECK_MARK.done}</span>{" "}
                          {t(`boot.${i}.label`)} — {t(`boot.${i}.value`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="gs-col">
                    <span className="gs-eyebrow gs-amber">{t("already")}</span>
                    <p className="gs-dim">{t("accountNote")}</p>
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
                      {t("progress", {
                        step: branch.step,
                        total: branch.total,
                        percent: branch.percent,
                      })}
                    </span>
                  </div>

                  <div className="gs-blockbar" aria-hidden="true">
                    {blockBar(branch.step, branch.total)}
                  </div>
                  <progress
                    className="visually-hidden"
                    aria-label={t("progress", {
                      step: branch.step,
                      total: branch.total,
                      percent: branch.percent,
                    })}
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
                      {t("finished")} <Link to="/">{t("openLibrary")}</Link>{" "}
                      {t("whenReady")}
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
                {t("menu")}
              </button>
              <div className="gs-actions">
                <button
                  type="button"
                  className="gs-legend-btn"
                  onClick={branch.back}
                  disabled={branch.onLanding}
                >
                  {t("back")}
                </button>
                <button
                  type="button"
                  className="gs-legend-btn"
                  onClick={branch.next}
                  disabled={branch.onLanding || branch.isLast}
                >
                  {t("next")}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
