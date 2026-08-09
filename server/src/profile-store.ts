/**
 * `ProfileStore` over Postgres. Reference shape: `createInMemoryProfileStore`
 * (`engine/src/engine/src/core/session/profile-store.ts`) -- a `Map<profileId,
 * PlayerProfile>`. This is its durable equivalent: one row per unlocked achievement,
 * grouped by `player_id` on `load`.
 *
 * The session store calls `upsertAchievements` around a successful `submitAction` only
 * when `profiles` is supplied (`store.ts`) -- nothing here needs to be idempotent itself,
 * since that guard already is.
 */
import type { Pool } from "pg";
import type {
  PlayerProfile,
  ProfileLoadResult,
  ProfileSaveResult,
  ProfileStore,
} from "@the-running-dev/game-engine";

export function createPostgresProfileStore(pool: Pool): ProfileStore {
  return {
    async load(profileId: string): Promise<ProfileLoadResult> {
      const { rows } = await pool.query(
        `select campaign_id, achievement_id from achievements where player_id = $1`,
        [profileId],
      );
      return {
        profile: {
          formatVersion: 1,
          profileId,
          achievements: rows.map((row) => ({
            campaignId: row.campaign_id as string,
            achievementId: row.achievement_id as string,
          })),
        },
        warnings: [],
      };
    },

    async save(profile: PlayerProfile): Promise<ProfileSaveResult> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const achievement of profile.achievements) {
          await client.query(
            `insert into achievements (player_id, campaign_id, achievement_id)
             values ($1, $2, $3)
             on conflict (player_id, campaign_id, achievement_id) do nothing`,
            [
              profile.profileId,
              achievement.campaignId,
              achievement.achievementId,
            ],
          );
        }
        await client.query("commit");
        return { ok: true, warnings: [] };
      } catch {
        await client.query("rollback");
        return {
          ok: false,
          warnings: [
            { code: "profile_write_failed", profileId: profile.profileId },
          ],
        };
      } finally {
        client.release();
      }
    },
  };
}
