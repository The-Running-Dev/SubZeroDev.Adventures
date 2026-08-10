/**
 * `GET /api/stats` -- platform-wide aggregates, deliberately public and unauthenticated:
 * these are the numbers the landing page shows before anyone signs in, so this goes
 * through no principal resolution at all (the `/api/campaigns` posture,
 * routes/session.ts), which also means a bare GET here can never mint a `players` row.
 *
 * Nothing is cached or materialized. At this deployment's scale these are a handful of
 * sequential scans over small tables; if `sessions` ever grows past the point where that
 * matters, the fix is a periodically-refreshed materialized view, not per-request
 * memoization.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export function registerStatsRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/api/stats", async () => {
    const [players, sessions, achievements, badges] = await Promise.all([
      pool.query<{ n: number }>(`select count(*)::int as n from players`),
      pool.query<{
        total: number;
        finished: number;
        steps: number;
        campaigns: number;
      }>(
        `select count(*)::int as total,
                count(*) filter (where status = 'ended')::int as finished,
                coalesce(sum(step_count), 0)::int as steps,
                count(distinct campaign_id)::int as campaigns
           from sessions`,
      ),
      pool.query<{ n: number }>(`select count(*)::int as n from achievements`),
      pool.query<{ n: number }>(`select count(*)::int as n from badges`),
    ]);

    return {
      players: players.rows[0].n,
      sessions: sessions.rows[0].total,
      sessionsFinished: sessions.rows[0].finished,
      campaignsPlayed: sessions.rows[0].campaigns,
      stepsTaken: sessions.rows[0].steps,
      achievementsUnlocked: achievements.rows[0].n,
      badgesUnlocked: badges.rows[0].n,
    };
  });
}
