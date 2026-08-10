import type { CSSProperties } from "react";
import type { BrowserCampaign } from "./composition";
import type { Badge, CampaignProgress, Identity } from "./identity";
import { BADGE_DEFINITIONS, BADGE_ORDER } from "./badges";

const numberFormat = new Intl.NumberFormat();

function fill(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * The signed-in (or guest) player's own record: a summary derived entirely from the
 * `progress` map PlayApp.tsx already holds (no extra fetch), and a grid of every badge --
 * earned or not. Locked badges stay in the grid, dimmed rather than removed, with an
 * explicit `LOCKED` text stamp: the description is the aspiration, and the stamp is what
 * keeps locked/unlocked distinguishable once opacity is stripped out under
 * `forced-colors` or for a screen reader.
 */
export function PlayerHome({
  identity,
  progress,
  badges,
  catalog,
}: {
  identity: Identity;
  progress: ReadonlyMap<string, CampaignProgress>;
  badges: readonly Badge[];
  catalog: readonly BrowserCampaign[];
}) {
  const entries = [...progress.values()];
  const storiesFinished = entries.filter((e) => e.status === "ended").length;
  const movesLogged = entries.reduce((sum, e) => sum + e.stepCount, 0);
  const endingsFound = entries.reduce(
    (sum, e) => sum + e.endings.discovered.length,
    0,
  );
  const achievementsUnlocked = entries.reduce(
    (sum, e) => sum + e.achievements.length,
    0,
  );
  const unlockedByBadge = new Map(badges.map((b) => [b.badgeId, b]));

  const finishedPct = fill(storiesFinished, catalog.length);
  const badgePct = fill(unlockedByBadge.size, BADGE_ORDER.length);

  return (
    <section className="player-home" aria-labelledby="home-title">
      <p className="eyebrow">OPERATOR RECORD</p>
      <h2 id="home-title">{identity.displayName ?? "Guest operator"}</h2>
      {identity.kind === "guest" && (
        <p className="home-guest-note">
          Playing as a guest -- sign in to keep this record if you clear this
          browser.
        </p>
      )}
      <dl className="home-summary">
        <div>
          <dt>Stories started</dt>
          <dd>{numberFormat.format(progress.size)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${finishedPct}%` } as CSSProperties}
        >
          <dt>Stories finished</dt>
          <dd>
            {numberFormat.format(storiesFinished)}
            <span className="stat-ceiling"> / {catalog.length}</span>
          </dd>
        </div>
        <div>
          <dt>Moves logged</dt>
          <dd>{numberFormat.format(movesLogged)}</dd>
        </div>
        <div>
          <dt>Endings found</dt>
          <dd>{numberFormat.format(endingsFound)}</dd>
        </div>
        <div>
          <dt>Achievements</dt>
          <dd>{numberFormat.format(achievementsUnlocked)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${badgePct}%` } as CSSProperties}
        >
          <dt>Badges</dt>
          <dd>
            {numberFormat.format(unlockedByBadge.size)}
            <span className="stat-ceiling"> / {BADGE_ORDER.length}</span>
          </dd>
        </div>
      </dl>
      <ul className="badge-grid" aria-label="Badges">
        {BADGE_ORDER.map((id) => {
          const def = BADGE_DEFINITIONS[id]!;
          const earned = unlockedByBadge.get(id);
          return (
            <li key={id} className={earned ? "badge" : "badge badge-locked"}>
              <span className="badge-emblem" aria-hidden="true">
                {earned ? "◆" : "◇"}
              </span>
              <strong>{def.label}</strong>
              <span>{def.description}</span>
              <span className="badge-stamp">
                {earned
                  ? `UNLOCKED ${earned.unlockedAt.slice(0, 10)}`
                  : "LOCKED"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
