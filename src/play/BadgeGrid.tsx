import type { Badge } from "./identity";
import { BADGE_DEFINITIONS, BADGE_ORDER } from "./badges";

/** Every known badge, earned or not -- iterates `BADGE_ORDER`, not `badges`, so a
 *  locked badge stays in the grid (dimmed, never hidden) and an unrecognized id in
 *  `badges` (older client, newer server, or vice versa) simply contributes no tile
 *  instead of crashing. Shared between `PlayerHome` (own view) and `PublicProfile`
 *  (visitor view) -- identical rendering either way. */
export function BadgeGrid({ badges }: { badges: readonly Badge[] }) {
  const unlockedByBadge = new Map(badges.map((b) => [b.badgeId, b]));

  return (
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
              {earned ? `UNLOCKED ${earned.unlockedAt.slice(0, 10)}` : "LOCKED"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
