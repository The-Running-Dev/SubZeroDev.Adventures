import { useState, useRef, useEffect, type CSSProperties } from "react";
import type { PlayState } from "../../play/browser-client";
import type { StatBounds } from "../../play/composition";
export interface Stat {
  readonly var: string;
  readonly labelKey: string;
  readonly value: string | number | boolean;
}

const NO_STATS: ReadonlySet<string> = new Set();
/**
 * Long enough to notice on a glance back at the panel, short enough that a stat
 * which moved two turns ago is not still lit. Kept in step with the
 * `.stat-changed` animation duration in play.css.
 */
const STAT_HIGHLIGHT_MS = 1100;

/**
 * Which stats changed on the turn just committed.
 *
 * A stat moving is this game's main feedback signal, and the projection reports
 * only the *new* value -- after a turn, "3" is indistinguishable from "3 again"
 * without remembering what the previous turn showed. Comparing against the
 * previously rendered values is what makes the change visible at all.
 *
 * Nothing is highlighted on a run's first render (every stat is new, not
 * changed), which is what keeps a freshly loaded story from flashing all eight
 * readouts at once. State lives in a signature string rather than the `stats`
 * array because `viewOf` builds a fresh array every render -- depending on the
 * array itself would re-run this on every render, not on every actual change.
 */
function useChangedStats(stats: readonly Stat[]): ReadonlySet<string> {
  /*
   * JSON rather than a delimiter-joined string: an `enum` stat's value is
   * authored content, so there is no separator this could assume it is free of.
   */
  const signature = JSON.stringify(
    Object.fromEntries(stats.map((stat) => [stat.var, String(stat.value)])),
  );
  const previous = useRef<string | undefined>(undefined);
  const [changed, setChanged] = useState<ReadonlySet<string>>(NO_STATS);

  useEffect(() => {
    const before = previous.current;
    previous.current = signature;
    if (before === undefined || before === signature) return;

    const past = JSON.parse(before) as Record<string, string>;
    const now = JSON.parse(signature) as Record<string, string>;
    const moved = new Set(
      Object.keys(now).filter(
        (name) => past[name] !== undefined && past[name] !== now[name],
      ),
    );
    if (moved.size === 0) return;

    setChanged(moved);
    const timer = setTimeout(() => setChanged(NO_STATS), STAT_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  return changed;
}

/**
 * The player-visible stats.
 *
 * A bounded int renders as `value / max` over a meter rather than a bare
 * number: the campaign declares the range (`predictions_correct` is 0-26, i.e.
 * a score out of 26), and without the denominator the panel shows a count with
 * nothing to read it against. Bounds come from the campaign this client already
 * fetched, since the projection deliberately carries the value alone.
 *
 * A stat still sitting at its floor is dimmed rather than hidden -- the set of
 * stats is itself a hint about what the story measures, so dropping the
 * untouched ones would hide the shape of the run, but leaving them at full
 * strength is what makes an all-zero panel read as noise.
 */
export function StatReadouts({
  stats,
  strings,
  bounds,
}: {
  stats: readonly Stat[];
  strings: PlayState["strings"];
  bounds: Readonly<Record<string, StatBounds>>;
}) {
  const changed = useChangedStats(stats);
  return (
    <dl className="stat-readouts">
      {stats.map((stat) => {
        const range = bounds[stat.var];
        const floor = range?.min ?? 0;
        const ceiling = range?.max;
        const numeric = typeof stat.value === "number";
        const metered = numeric && ceiling !== undefined && ceiling > floor;
        const className = [
          numeric && stat.value === floor ? "stat-idle" : "",
          metered ? "stat-metered" : "",
          changed.has(stat.var) ? "stat-changed" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={stat.var}
            {...(className ? { className } : {})}
            {...(metered
              ? {
                  style: {
                    "--stat-fill": `${Math.round(
                      (((stat.value as number) - floor) / (ceiling! - floor)) *
                        100,
                    )}%`,
                  } as CSSProperties,
                }
              : {})}
          >
            <dt>{strings[stat.labelKey]}</dt>
            <dd>
              {String(stat.value)}
              {ceiling !== undefined && (
                <span className="stat-ceiling"> / {ceiling}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
