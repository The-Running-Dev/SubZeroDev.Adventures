/**
 * `GET /api/progress` — per-campaign progress for the current player, built entirely off
 * the denormalized `sessions` columns `persistence.ts` writes on every put (005 migration)
 * plus the existing `achievements` table. Read-only, so it goes through `resolvePrincipal`
 * (never mints, `principal.ts`) rather than `requirePrincipal` — a logged-out visitor just
 * gets an empty list, not a new `players` row.
 *
 * Spoiler-safe by construction: `endings.discovered` is built only from `ending_id`s this
 * player's own sessions actually produced, never from the campaign's full ending set —
 * `endings.total` is the only thing that comes from the campaign content
 * (`endingCountOf`, shared/campaign-registry.ts).
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { resolvePrincipal } from "../principal.js";
import type { ContentCell } from "../content-cell.js";

export function registerProgressRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  const resolve = resolvePrincipal(pool);

  app.get("/api/progress", { preHandler: resolve }, async (request) => {
    const principal = request.principalOrNull;
    if (!principal) return { progress: [] };
    const demo = cell.current();

    // `latest` picks the most-recently-touched session per campaign for status/step
    // count -- a player can have several sessions per campaign (retries, branches), and
    // the current one is what "how far am I" should reflect. `agg` separately sums across
    // every session in that campaign, since endings reached and attempt count are
    // properties of the whole history, not just the latest attempt.
    const { rows: sessionRows } = await pool.query(
      `with latest as (
         select distinct on (campaign_id) campaign_id, status, step_count, updated_at as last_played_at
         from sessions where profile_id = $1
         order by campaign_id, updated_at desc
       ),
       agg as (
         select campaign_id, count(*)::int as session_count, min(created_at) as first_played_at,
           array_agg(distinct ending_id) filter (where ending_id is not null) as ending_ids
         from sessions where profile_id = $1
         group by campaign_id
       )
       select l.campaign_id, l.status, l.step_count, l.last_played_at, a.session_count, a.first_played_at, a.ending_ids
       from latest l join agg a using (campaign_id)`,
      [principal.playerId],
    );

    const { rows: achievementRows } = await pool.query(
      `select campaign_id, array_agg(achievement_id) as achievement_ids
       from achievements where player_id = $1
       group by campaign_id`,
      [principal.playerId],
    );
    const achievementsByCampaign = new Map<string, string[]>(
      achievementRows.map((row) => [
        row.campaign_id as string,
        row.achievement_ids as string[],
      ]),
    );

    const progress = sessionRows.map((row) => {
      const campaignId = row.campaign_id as string;
      const total = demo.findCampaign(campaignId)?.endingCount ?? 0;
      return {
        campaignId,
        status: row.status as string,
        stepCount: row.step_count as number,
        sessionCount: row.session_count as number,
        // Wall-clock span, not engaged playtime -- GameState structurally carries no
        // timestamps (core/kernel/types.ts), so "first created -> last touched" is the
        // honest signal available, not a measure of time actually spent playing.
        firstPlayedAt: row.first_played_at as string,
        lastPlayedAt: row.last_played_at as string,
        endings: {
          discovered: (row.ending_ids as string[] | null) ?? [],
          total,
        },
        achievements: achievementsByCampaign.get(campaignId) ?? [],
      };
    });

    return { progress };
  });
}
