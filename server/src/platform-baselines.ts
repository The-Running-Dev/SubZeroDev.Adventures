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
 * visitors' alike. `publicProfileTotals` is a third case, and the only one read by an
 * unauthenticated request: it feeds `ranking.ts`'s public leaderboard, has no storage or
 * staleness question like `discovererCounts`, and is recomputed per request.
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

export interface PublicProfileTotal {
  /** Internal only -- `ranking.ts` strips this before anything reaches
   *  `GET /api/ranking`; only `currentLeaderPlayerId` (badges.ts's crown check) ever
   *  reads it. */
  readonly playerId: string;
  readonly profileSlug: string;
  readonly displayName: string | null;
  readonly createdAtMs: number;
  readonly badgeCount: number;
  readonly firstBadgeAtMs: number | null;
  readonly moves: number;
  readonly rejected: number;
  readonly endings: number;
}

interface PublicProfileTotalRow {
  player_id: string;
  profile_slug: string;
  display_name: string | null;
  created_at: Date;
  badge_count: number;
  first_badge_at: Date | null;
  moves: number;
  rejected: number;
  endings: number;
}

/**
 * One row per `profile_public = true` player with a minted slug, for `ranking.ts`'s
 * leaderboard. `badges` and `sessions` are both one-to-many against `players` --
 * pre-aggregated in their own CTEs before a single join, so joining them directly in one
 * `FROM` never fans out and inflates either sum. `excludedBadgeId` drops the crown from
 * `badge_count` so holding it can never raise the score that earned it in the first
 * place (`ranking.ts`'s self-reference guard) -- taken as a parameter rather than
 * importing `CROWN_BADGE_ID` here, so this module's only edge to `ranking.ts` stays the
 * existing one, not a new one back.
 *
 * Reads no `sessions` timestamp: `created_at`/`updated_at` there are TEXT (migration
 * 002), and this query's ordering inputs -- `players.created_at`, `badges.unlocked_at`
 * -- are both real `timestamptz` already, so there's nothing to cast or move into JS the
 * way `evaluateBadges` has to for its own date handling.
 */
export async function publicProfileTotals(
  pool: Pool,
  excludedBadgeId: string,
): Promise<readonly PublicProfileTotal[]> {
  const { rows } = await pool.query<PublicProfileTotalRow>(
    `with ranked_players as (
       select player_id, profile_slug, display_name, created_at
         from players
        where profile_public = true
          and profile_slug is not null
     ),
     badge_totals as (
       select b.player_id,
              count(*)::int      as badge_count,
              min(b.unlocked_at) as first_badge_at
         from badges b
         join ranked_players p on p.player_id = b.player_id
        where b.badge_id <> $1
        group by b.player_id
     ),
     session_totals as (
       select s.profile_id as player_id,
              coalesce(sum(s.step_count), 0)::int as moves,
              coalesce(sum(greatest(s.attempt_counter - s.step_count, 0)), 0)::int
                as rejected,
              count(distinct (s.campaign_id, s.ending_id))
                filter (where s.ending_id is not null)::int as endings
         from sessions s
         join ranked_players p on p.player_id = s.profile_id
        group by s.profile_id
     )
     select p.player_id,
            p.profile_slug,
            p.display_name,
            p.created_at,
            coalesce(b.badge_count, 0) as badge_count,
            b.first_badge_at,
            coalesce(t.moves, 0)       as moves,
            coalesce(t.rejected, 0)    as rejected,
            coalesce(t.endings, 0)     as endings
       from ranked_players p
       left join badge_totals   b on b.player_id = p.player_id
       left join session_totals t on t.player_id = p.player_id`,
    [excludedBadgeId],
  );
  return rows.map((row) => ({
    playerId: row.player_id,
    profileSlug: row.profile_slug,
    displayName: row.display_name,
    createdAtMs: row.created_at.getTime(),
    badgeCount: row.badge_count,
    firstBadgeAtMs: row.first_badge_at ? row.first_badge_at.getTime() : null,
    moves: row.moves,
    rejected: row.rejected,
    endings: row.endings,
  }));
}
