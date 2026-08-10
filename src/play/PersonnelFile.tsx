import type { PersonnelRecords } from "./identity";

const numberFormat = new Intl.NumberFormat();
const percentFormat = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
});

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
  if (!records) return null;

  return (
    <section className="personnel-file" aria-label="Personnel file">
      <p className="eyebrow">PERSONNEL FILE // PERMANENT RECORD</p>
      <dl>
        <div>
          <dt>Longest Run</dt>
          <dd>{numberFormat.format(records.longestRun)} moves</dd>
        </div>
        <div>
          <dt>Longest Streak</dt>
          <dd>
            {numberFormat.format(records.longestStreak)}{" "}
            {records.longestStreak === 1 ? "day" : "days"}
          </dd>
        </div>
        <div>
          <dt>Most Moves / Day</dt>
          <dd>{numberFormat.format(records.mostMovesInADay)}</dd>
        </div>
        {records.favoriteDisk && (
          <div>
            <dt>Favorite Disk</dt>
            <dd>{findCampaignTitle(records.favoriteDisk.campaignId)}</dd>
          </div>
        )}
        <div>
          <dt>Most Rejected Moves</dt>
          <dd>{numberFormat.format(records.mostRejectedMoves)}</dd>
        </div>
        {records.fastestEnding !== null && (
          <div>
            <dt>Fastest Ending</dt>
            <dd>{numberFormat.format(records.fastestEnding)} moves</dd>
          </div>
        )}
        {records.rarestEnding && (
          <div>
            <dt>Rarest Ending</dt>
            <dd>
              {findCampaignTitle(records.rarestEnding.campaignId)} —{" "}
              {numberFormat.format(records.rarestEnding.discoverers)}{" "}
              {records.rarestEnding.discoverers === 1
                ? "operator has"
                : "operators have"}{" "}
              found it
            </dd>
          </div>
        )}
        <div>
          <dt>Completion Rate</dt>
          <dd>{percentFormat.format(records.completionRate)}</dd>
        </div>
        <div>
          <dt>Attempt Efficiency</dt>
          <dd>{percentFormat.format(records.attemptEfficiency)}</dd>
        </div>
      </dl>
    </section>
  );
}
