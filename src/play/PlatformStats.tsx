import type { CSSProperties } from "react";
import type { PlatformStats as PlatformStatsData } from "./identity";

const numberFormat = new Intl.NumberFormat();

function fill(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Public, platform-wide numbers -- rendered whenever `demo.apiUrl` is set and
 * `usePlatformStats` has resolved (PlayApp.tsx gates both; local mode has no backend to
 * ask). The two ratios that have an honest denominator (runs finished / started, stories
 * touched / cataloged) reuse `.stat-metered`, the same meter idiom `StatReadouts` drives
 * during play -- the bare counts have no ceiling, so they render as plain numbers instead.
 *
 * The standings link that used to close this panel now lives in the global header
 * (`.system-bar`, PlayApp.tsx), reachable from the shelf and mid-run alike rather than
 * only from the one panel that happens to sit above the disk grid.
 */
export function PlatformStats({
  stats,
  catalogSize,
}: {
  stats: PlatformStatsData;
  catalogSize: number;
}) {
  const finishedPct = fill(stats.sessionsFinished, stats.sessions);
  const touchedPct = fill(stats.campaignsPlayed, catalogSize);

  return (
    <section className="platform-stats" aria-label="System activity">
      <p className="eyebrow">SYSTEM ACTIVITY // ALL NODES</p>
      <dl>
        <div>
          <dt>Players on record</dt>
          <dd>{numberFormat.format(stats.players)}</dd>
        </div>
        <div>
          <dt>Runs started</dt>
          <dd>{numberFormat.format(stats.sessions)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${finishedPct}%` } as CSSProperties}
        >
          <dt>Runs completed</dt>
          <dd>{numberFormat.format(stats.sessionsFinished)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${touchedPct}%` } as CSSProperties}
        >
          <dt>Stories touched</dt>
          <dd>
            {numberFormat.format(stats.campaignsPlayed)}
            <span className="stat-ceiling"> / {catalogSize}</span>
          </dd>
        </div>
        <div>
          <dt>Moves logged</dt>
          <dd>{numberFormat.format(stats.stepsTaken)}</dd>
        </div>
        <div>
          <dt>Achievements</dt>
          <dd>{numberFormat.format(stats.achievementsUnlocked)}</dd>
        </div>
        <div>
          <dt>Badges</dt>
          <dd>{numberFormat.format(stats.badgesUnlocked)}</dd>
        </div>
      </dl>
    </section>
  );
}
