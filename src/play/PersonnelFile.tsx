import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
import type { PersonnelRecords } from "./identity";

/**
 * `PERSONNEL FILE // PERMANENT RECORD` -- pure aggregates, always present once loaded
 * (no locked/unlocked state like badges). `favoriteDisk`/`rarestEnding`/`fastestEnding`
 * can be `null` (nothing to report yet) and simply omit their row rather than showing a
 * placeholder -- matches the "still present, dimmed" philosophy for stats that don't yet
 * apply, distinct from badges' "still present, locked". `findCampaignTitle` resolves a
 * campaignId to a display title from whichever catalog the caller already has; falls
 * back to the raw id if the campaign isn't found (a hidden or since-removed campaign).
 */
export function PersonnelFile({
  records,
  findCampaignTitle,
}: {
  records: PersonnelRecords | null;
  findCampaignTitle: (campaignId: string) => string;
}) {
  const { t } = useTranslation("community");
  const { number } = useLocale();
  if (!records) return null;

  return (
    <section className="personnel-file" aria-label={t("personnel")}>
      <p className="eyebrow">{t("permanent")}</p>
      <dl>
        <div>
          <dt>{t("longest")}</dt>
          <dd>{t("movesCount", { count: records.longestRun })}</dd>
        </div>
        <div>
          <dt>{t("streak")}</dt>
          <dd>{t("days", { count: records.longestStreak })}</dd>
        </div>
        <div>
          <dt>{t("mostDay")}</dt>
          <dd>{number(records.mostMovesInADay)}</dd>
        </div>
        {records.favoriteDisk && (
          <div>
            <dt>{t("favorite")}</dt>
            <dd>{findCampaignTitle(records.favoriteDisk.campaignId)}</dd>
          </div>
        )}
        <div>
          <dt>{t("mostRejected")}</dt>
          <dd>{number(records.mostRejectedMoves)}</dd>
        </div>
        {records.fastestEnding !== null && (
          <div>
            <dt>{t("fastest")}</dt>
            <dd>{t("movesCount", { count: records.fastestEnding })}</dd>
          </div>
        )}
        {records.rarestEnding && (
          <div>
            <dt>{t("rarest")}</dt>
            <dd>
              {findCampaignTitle(records.rarestEnding.campaignId)} —{" "}
              {t("discoverers", { count: records.rarestEnding.discoverers })}
            </dd>
          </div>
        )}
        <div>
          <dt>{t("completion")}</dt>
          <dd>
            {number(records.completionRate, {
              style: "percent",
              maximumFractionDigits: 0,
            })}
          </dd>
        </div>
        <div>
          <dt>{t("efficiency")}</dt>
          <dd>
            {number(records.attemptEfficiency, {
              style: "percent",
              maximumFractionDigits: 0,
            })}
          </dd>
        </div>
      </dl>
    </section>
  );
}
