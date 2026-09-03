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
          formatVersion: 3,
          profileId,
          achievements: rows.map((row) => ({
            campaignId: row.campaign_id as string,
            achievementId: row.achievement_id as string,
          })),
          // Not yet persisted here -- see this function's own header. `listCampaigns`'s
          // `CampaignProgress.discovered` will read as 0 until a real store lands for
          // these; nothing else in this server currently reads either field back off a
          // loaded `PlayerProfile` (records.ts derives "discovered endings" from
          // `sessions.ending_id` directly, not through this port).
          terminals: [],
          kindData: [],
        },
        warnings: [],
      };
    },

    /**
     * `profile.terminals` and `profile.kindData` (engine 0.10.0, `PlayerProfile`
     * formatVersion 3 -- W98's terminal identity and W101/W102's kind profile chains) are
     * silently dropped here, same posture as `load` reporting them empty: this store still
     * only durably tracks achievements. Persisting the other two is a real, separate
     * schema decision (a `terminals` table shaped like `achievements`, and a `kind_data`
     * table keyed by `(player_id, kind_id)` for the opaque per-kind blob) -- not made here.
     */
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
