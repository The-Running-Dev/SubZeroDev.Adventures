import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
import type { Badge } from "./identity";
import { BADGE_DEFINITIONS, BADGE_ORDER } from "./badges";

/** Every known badge, earned or not -- iterates `BADGE_ORDER`, not `badges`, so a
 *  locked badge stays in the grid (dimmed, never hidden) and an unrecognized id in
 *  `badges` (older client, newer server, or vice versa) simply contributes no tile
 *  instead of crashing. Shared between `PlayerHome` (own view) and `PublicProfile`
 *  (visitor view) -- identical rendering either way. */
export function BadgeGrid({ badges }: { badges: readonly Badge[] }) {
  const { t } = useTranslation("badges");
  const { date } = useLocale();
  const unlockedByBadge = new Map(badges.map((b) => [b.badgeId, b]));

  return (
    <ul className="badge-grid" aria-label={t("title")}>
      {BADGE_ORDER.map((id) => {
        const def = BADGE_DEFINITIONS[id]!;
        const earned = unlockedByBadge.get(id);
        return (
          <li key={id} className={earned ? "badge" : "badge badge-locked"}>
            <span className="badge-emblem" aria-hidden="true">
              {earned ? "◆" : "◇"}
            </span>
            <strong>{t(`${id}.label`, { defaultValue: def.label })}</strong>
            <span>
              {t(`${id}.description`, { defaultValue: def.description })}
            </span>
            <span className="badge-stamp">
              {earned
                ? t("unlocked", {
                    date: date(earned.unlockedAt, {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    }),
                  })
                : t("locked")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
