/**
 * `GET /api/ranking` -- the public leaderboard. Fully public, same posture as
 * `routes/stats.ts` and `GET /api/profile/:slug`: no `preHandler` at all, so a bare GET
 * can never mint a `players` row and never writes anything. All of the actual work --
 * the query, the ordering, the crown -- lives in `ranking.ts`; this route is just the
 * HTTP shape around `computeLeaderboard`.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { computeLeaderboard } from "../ranking.js";
import type { ContentCell } from "../content-cell.js";

export function registerRankingRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  app.get("/api/ranking", async () => {
    const excludedCampaignIds = Array.from(cell.current().provenance.keys());
    const { entries, totalRanked } = await computeLeaderboard(
      pool,
      excludedCampaignIds,
    );
    return { entries, totalRanked };
  });
}
