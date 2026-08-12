/**
 * Public/private player profiles (issue #19 follow-up). Three routes:
 *
 * - `GET /api/profile/settings` -- the caller's own visibility state. Read-only, so
 *   `resolvePrincipal` (never mints), same posture as `/api/progress`.
 * - `POST /api/profile/visibility` -- flips public/private, minting a `profile_slug`
 *   lazily the first time a player goes public. `requirePrincipal`: a write, and a
 *   guest can use it same as every other write route.
 * - `GET /api/profile/:slug` -- fully public, no `preHandler` at all (the
 *   `/api/campaigns`/`/api/stats` posture). Looks a player up by their *public* slug,
 *   never `player_id`, which stays opaque outside `/api/me` (api.test.ts's standing
 *   invariant). Reads stored badges rather than evaluating them -- a stranger's read
 *   must never write to someone else's row.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { requirePrincipal, resolvePrincipal } from "../principal.js";
import { computeRecords } from "../records.js";
import { maskDisplayName } from "../display-name.js";
import type { ContentCell } from "../content-cell.js";

function mintSlug(): string {
  return randomBytes(16).toString("base64url");
}

const UNIQUE_VIOLATION = "23505";

export function registerProfileRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  const resolve = resolvePrincipal(pool);
  const auth = requirePrincipal(pool);

  app.get("/api/profile/settings", { preHandler: resolve }, async (request) => {
    const principal = request.principalOrNull;
    if (!principal) return { public: false, slug: null };
    const { rows } = await pool.query<{
      profile_public: boolean;
      profile_slug: string | null;
    }>(
      `select profile_public, profile_slug from players where player_id = $1`,
      [principal.playerId],
    );
    return {
      public: rows[0]?.profile_public ?? false,
      slug: rows[0]?.profile_slug ?? null,
    };
  });

  app.post("/api/profile/visibility", { preHandler: auth }, async (request) => {
    const body = request.body as { public?: boolean };
    const isPublic = body.public === true;

    async function update(slugCandidate: string) {
      return pool.query<{
        profile_public: boolean;
        profile_slug: string | null;
      }>(
        `update players
              set profile_public = $2,
                  profile_slug = case when $2 then coalesce(profile_slug, $3) else profile_slug end
            where player_id = $1
          returning profile_public, profile_slug`,
        [request.principal.playerId, isPublic, slugCandidate],
      );
    }

    let result;
    try {
      result = await update(mintSlug());
    } catch (error) {
      // Practically impossible (128 bits of entropy) -- retry once with a fresh value
      // rather than failing the request outright.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      result = await update(mintSlug());
    }

    return {
      public: result.rows[0]!.profile_public,
      slug: result.rows[0]!.profile_slug,
    };
  });

  app.get("/api/profile/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const { rows: playerRows } = await pool.query<{
      player_id: string;
      display_name: string | null;
      created_at: string;
    }>(
      `select player_id, display_name, created_at
         from players where profile_slug = $1 and profile_public = true`,
      [slug],
    );
    const player = playerRows[0];
    if (!player) {
      reply.code(404);
      return { error: { operation: "profile", code: "not_found" } };
    }
    const playerId = player.player_id;
    const coreCampaignIds = cell
      .current()
      .core.map((campaign) => campaign.campaignId);

    const [statsResult, achievementsResult, badgesResult, records] =
      await Promise.all([
        // `campaigns`/`endings` scoped to core, matching `campaignsTotal` below
        // (`cell.current().catalog.length`, already core-only) -- otherwise a player with
        // private submissions could publicly show something like "12 of 9 stories
        // finished", counting campaigns the denominator was never counting in the first
        // place.
        pool.query<{
          total: number;
          finished: number;
          steps: number;
          campaigns: number;
          endings: number;
        }>(
          `select count(*)::int as total,
                  count(*) filter (where status = 'ended')::int as finished,
                  coalesce(sum(step_count), 0)::int as steps,
                  count(distinct campaign_id)
                    filter (where campaign_id = any($2))::int as campaigns,
                  count(distinct (campaign_id, ending_id))
                    filter (where ending_id is not null and campaign_id = any($2))::int
                    as endings
             from sessions where profile_id = $1`,
          [playerId, coreCampaignIds],
        ),
        pool.query<{ n: number }>(
          `select count(*)::int as n from achievements where player_id = $1`,
          [playerId],
        ),
        pool.query<{ badge_id: string; unlocked_at: Date }>(
          `select badge_id, unlocked_at from badges where player_id = $1 order by unlocked_at`,
          [playerId],
        ),
        computeRecords(pool, playerId, coreCampaignIds),
      ]);
    const stats = statsResult.rows[0]!;

    return {
      displayName: maskDisplayName(player.display_name),
      joinedAt: player.created_at,
      sessionsStarted: stats.total,
      sessionsFinished: stats.finished,
      campaignsPlayed: stats.campaigns,
      campaignsTotal: cell.current().catalog.length,
      stepsTaken: stats.steps,
      endingsFound: stats.endings,
      achievementsUnlocked: achievementsResult.rows[0]!.n,
      badges: badgesResult.rows.map((row) => ({
        badgeId: row.badge_id,
        unlockedAt: row.unlocked_at.toISOString(),
      })),
      records,
    };
  });
}
