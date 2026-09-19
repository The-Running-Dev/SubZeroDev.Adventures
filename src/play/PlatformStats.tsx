import { useLocale } from "../app/locale/useLocale";
import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import type { PlatformStats as PlatformStatsData } from "./identity";

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
  const { t } = useTranslation("playerExtras");
  const { number } = useLocale();
  const finishedPct = fill(stats.sessionsFinished, stats.sessions);
  const touchedPct = fill(stats.campaignsPlayed, catalogSize);

  return (
    <section className="platform-stats" aria-label={t("activity")}>
      <p className="eyebrow">{t("activityEyebrow")}</p>
      <dl>
        <div>
          <dt>{t("players")}</dt>
          <dd>{number(stats.players)}</dd>
        </div>
        <div>
          <dt>{t("runs")}</dt>
          <dd>{number(stats.sessions)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${finishedPct}%` } as CSSProperties}
        >
          <dt>{t("completed")}</dt>
          <dd>{number(stats.sessionsFinished)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${touchedPct}%` } as CSSProperties}
        >
          <dt>{t("touched")}</dt>
          <dd>
            {number(stats.campaignsPlayed)}
            <span className="stat-ceiling"> / {catalogSize}</span>
          </dd>
        </div>
        <div>
          <dt>{t("moves")}</dt>
          <dd>{number(stats.stepsTaken)}</dd>
        </div>
        <div>
          <dt>{t("achievements")}</dt>
          <dd>{number(stats.achievementsUnlocked)}</dd>
        </div>
        <div>
          <dt>{t("badges")}</dt>
          <dd>{number(stats.badgesUnlocked)}</dd>
        </div>
      </dl>
    </section>
  );
}
