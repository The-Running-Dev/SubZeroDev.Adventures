/**
 * Cross-player query infrastructure -- the one part of the badge/records system that
 * compares a player against everyone else's rows, not just their own small set.
 *
 * `endingMedianSteps` and `rejectedPercentileFor` are read exclusively by
 * `evaluateBadges` (badges.ts), which only ever runs for the owner's own
 * `GET /api/badges` -- never for a stranger viewing a public profile
 * (`routes/profile.ts` reads stored badges, it doesn't evaluate). `discovererCounts`
 * is different: it feeds the Rarest Ending record (`records.ts`), which has no
 * storage/staleness question and is recomputed on every profile view, owner's and
 * visitors' alike.
 *
 * None of these are cached or materialized. Full scans/aggregations across every
 * player's `sessions` rows are a different cost profile than the rest of this
 * codebase's per-player queries -- acceptable at this deployment's current scale (the
 * same judgment `routes/stats.ts` already makes about its own platform-wide counts); a
 * periodically-refreshed materialized view is the future fix if it stops being fine,
 * not something to pre-build.
 */
import type { Pool } from "pg";

function medianKey(campaignId: string, endingId: string): string {
  return `${campaignId}:${endingId}`;
}

/** Median `step_count` among every player's `ended` sessions, per (campaign, ending).
 *  Keyed `"<campaignId>:<endingId>"`. Feeds `scenic-route`/`sequence-breaker`. */
export async function endingMedianSteps(
  pool: Pool,
): Promise<ReadonlyMap<string, number>> {
  const { rows } = await pool.query<{
    campaign_id: string;
    ending_id: string;
    median_steps: string;
  }>(
    `select campaign_id, ending_id,
            percentile_cont(0.5) within group (order by step_count) as median_steps
       from sessions
      where status = 'ended' and ending_id is not null
      group by campaign_id, ending_id`,
  );
  return new Map(
    rows.map((row) => [
      medianKey(row.campaign_id, row.ending_id),
      Number(row.median_steps),
    ]),
  );
}

/**
 * This player's percent_rank (0-1) among every player's summed "extra attempts" proxy
 * (`greatest(attempt_counter - step_count, 0)`, the same dual-purposed-column caveat
 * `badges.ts` documents for `chaos-gremlin`/`zen-master`). `percent_rank()` must be
 * computed over the *whole* population before filtering to this one player -- filtering
 * to `profile_id = $1` in the same query as the window function would compute the rank
 * over a single already-filtered row, which is always 0. The `ranked` CTE exists
 * specifically to keep those two steps in the right order.
 */
export async function rejectedPercentileFor(
  pool: Pool,
  playerId: string,
): Promise<number> {
  const { rows } = await pool.query<{ pct: string }>(
    `with per_player as (
       select profile_id, sum(greatest(attempt_counter - step_count, 0)) as rejected
         from sessions
        where profile_id is not null
        group by profile_id
     ),
     ranked as (
       select profile_id, percent_rank() over (order by rejected) as pct
         from per_player
     )
     select pct from ranked where profile_id = $1`,
    [playerId],
  );
  return rows[0] ? Number(rows[0].pct) : 0;
}

/** Global discoverer count per (campaign, ending) -- how many distinct players have
 *  ever reached each ending. Keyed `"<campaignId>:<endingId>"`. Feeds the Rarest Ending
 *  record only; not a badge input. */
export async function discovererCounts(
  pool: Pool,
): Promise<ReadonlyMap<string, number>> {
  const { rows } = await pool.query<{
    campaign_id: string;
    ending_id: string;
    discoverers: number;
  }>(
    `select campaign_id, ending_id, count(distinct profile_id)::int as discoverers
       from sessions
      where ending_id is not null
      group by campaign_id, ending_id`,
  );
  return new Map(
    rows.map((row) => [
      medianKey(row.campaign_id, row.ending_id),
      row.discoverers,
    ]),
  );
}

/** Total registered players -- gates `top-1-percent` so it isn't trivially true on a
 *  tiny userbase. */
export async function totalPlayerCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from players`,
  );
  return rows[0]!.n;
}
