/**
 * `GET /api/badges` -- the current player's cross-campaign badges. Read-only from the
 * caller's point of view, so it goes through `resolvePrincipal` (never mints, principal.ts)
 * like `/api/progress`: a logged-out visitor gets an empty list, not a new `players` row.
 *
 * The GET has a write side effect by design: it re-evaluates and upserts newly-earned
 * badges on every call (badges.ts). Badges are stored, not computed fresh (same posture as
 * achievements), so `unlocked_at` is durable and survives a player merge -- and this route
 * is the only place they're ever evaluated, rather than a trigger wired into every
 * gameplay write path.
 *
 * Also carries the "Personnel File" (records.ts) alongside the badges -- unlike badges,
 * records need no storage/staleness handling, so they're just recomputed on every call.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { resolvePrincipal } from "../principal.js";
import { evaluateBadges } from "../badges.js";
import { computeRecords } from "../records.js";
import type { ContentCell } from "../content-cell.js";

export function registerBadgeRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  const resolve = resolvePrincipal(pool);

  app.get("/api/badges", { preHandler: resolve }, async (request) => {
    const principal = request.principalOrNull;
    if (!principal) return { badges: [], records: null };
    const demo = cell.current();
    const coreCampaignIds = demo.core.map((campaign) => campaign.campaignId);
    const [badges, records] = await Promise.all([
      evaluateBadges(pool, demo, principal.playerId),
      computeRecords(pool, principal.playerId, coreCampaignIds),
    ]);
    return { badges, records };
  });
}
