import { useTranslation } from "react-i18next";
import { StatReadouts, type Stat } from "./StatReadouts";
import type { PlayState } from "../../play/browser-client";
import type { BrowserCampaign } from "../../play/composition";

function viewOf(state: PlayState) {
  const view = state.view.kindView as {
    stats?: Stat[];
    unlockedAchievements?: string[];
    turn?: number;
  };
  return {
    stats: view.stats ?? [],
    achievements: view.unlockedAchievements ?? [],
    turn: view.turn,
  };
}

export interface JourneyEntry {
  readonly excerpt: string;
  readonly choice?: string;
}

export function StatusConsole({
  state,
  selected,
  journey,
}: {
  state: PlayState;
  selected?: BrowserCampaign;
  journey: readonly JourneyEntry[];
}) {
  const { t } = useTranslation("play");
  return (
    <aside className="status-console" aria-labelledby="console-title">
      <div className="console-heading">
        <p className="eyebrow">{t("memory")}</p>
        <h2 id="console-title">{t("status")}</h2>
        {viewOf(state).turn !== undefined && (
          <p className="turn-readout">
            {t("turn", { count: viewOf(state).turn })}
          </p>
        )}
      </div>
      {viewOf(state).stats.length ? (
        <StatReadouts
          stats={viewOf(state).stats}
          strings={state.strings}
          bounds={selected?.statBounds ?? {}}
        />
      ) : (
        <p className="console-empty">{t("noStats")}</p>
      )}
      {viewOf(state).achievements.length > 0 && (
        <p className="achievement-note">
          <span aria-hidden="true">◆ </span>
          {t("achievementStamps", { count: viewOf(state).achievements.length })}
        </p>
      )}
      {/*
       * Open by default: this is the run's own history, it fills the
       * console's otherwise-dead lower half on desktop, and behind a
       * collapsed `[+]` most players never find it. `open` is set
       * once, not controlled -- React only rewrites the attribute
       * when the prop value changes, so closing it stays closed.
       */}
      <details className="journey-log" open>
        <summary>
          {t("travelLog")}
          <span className="journey-count">
            {t("pages", { count: journey.length })}
          </span>
        </summary>
        <ol>
          {journey.map((entry, index) => (
            <li
              key={`${index}-${entry.excerpt}`}
              aria-current={index === journey.length - 1 ? "step" : undefined}
            >
              {entry.choice && (
                <strong>{t("youChose", { choice: entry.choice })} </strong>
              )}
              <span>{entry.excerpt}</span>
              {index === journey.length - 1 && <em> {t("currentPage")}</em>}
            </li>
          ))}
        </ol>
        {journey.length > 1 && (
          <p className="journey-origin">
            {t("cameFrom", { excerpt: journey[journey.length - 2]?.excerpt })}
          </p>
        )}
      </details>
      <p className="console-footnote">{t("memoryNote")}</p>
      {selected?.sources && (
        <div className="source-links">
          <h3>{t("credits")}</h3>
          {selected.sources.map((source) => (
            <a key={source.href} href={source.href}>
              {source.label}
            </a>
          ))}
        </div>
      )}
    </aside>
  );
}
