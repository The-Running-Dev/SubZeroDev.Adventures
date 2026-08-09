/**
 * `SessionPersistence` over Postgres — the same five-method port
 * `localPersistence()` fills with `localStorage` in the browser
 * (`src/play/composition.ts`), so `createInMemorySessionStore` (which treats persistence
 * as a write-through cache, reading on miss) needs no changes to run against this.
 */
import type { Pool } from "pg";
import type {
  SessionPersistence,
  StoredSaveRecord,
  StoredSessionRecord,
} from "@the-running-dev/game-engine";

function toSessionRecord(row: {
  session_id: string;
  blob: string;
  audience: string;
  attempt_counter: number;
  replay_compatible: boolean;
  profile_id: string | null;
  created_at: string;
  updated_at: string;
}): StoredSessionRecord {
  return {
    sessionId: row.session_id,
    blob: row.blob,
    audience: row.audience as StoredSessionRecord["audience"],
    attemptCounter: row.attempt_counter,
    replayCompatible: row.replay_compatible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
  };
}

function toSaveRecord(row: {
  save_id: string;
  campaign_id: string;
  blob: string;
  saved_at_seq: number;
  audience: string;
  profile_id: string | null;
}): StoredSaveRecord {
  return {
    saveId: row.save_id,
    campaignId: row.campaign_id,
    blob: row.blob,
    savedAtSeq: row.saved_at_seq,
    audience: row.audience as StoredSaveRecord["audience"],
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
  };
}

export function createPostgresPersistence(pool: Pool): SessionPersistence {
  return {
    sessions: {
      async get(sessionId) {
        const { rows } = await pool.query(
          `select session_id, blob, audience, attempt_counter, replay_compatible, profile_id, created_at, updated_at
           from sessions where session_id = $1`,
          [sessionId],
        );
        return rows[0] ? toSessionRecord(rows[0]) : undefined;
      },
      async put(record) {
        await pool.query(
          `insert into sessions (session_id, blob, audience, attempt_counter, replay_compatible, profile_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (session_id) do update set
             blob = excluded.blob,
             audience = excluded.audience,
             attempt_counter = excluded.attempt_counter,
             replay_compatible = excluded.replay_compatible,
             profile_id = excluded.profile_id,
             updated_at = excluded.updated_at`,
          [
            record.sessionId,
            record.blob,
            record.audience,
            record.attemptCounter,
            record.replayCompatible,
            record.profileId ?? null,
            record.createdAt,
            record.updatedAt,
          ],
        );
      },
    },
    saves: {
      async get(saveId) {
        const { rows } = await pool.query(
          `select save_id, campaign_id, blob, saved_at_seq, audience, profile_id
           from saves where save_id = $1`,
          [saveId],
        );
        return rows[0] ? toSaveRecord(rows[0]) : undefined;
      },
      async put(record) {
        await pool.query(
          `insert into saves (save_id, campaign_id, blob, saved_at_seq, audience, profile_id)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (save_id) do update set
             campaign_id = excluded.campaign_id,
             blob = excluded.blob,
             saved_at_seq = excluded.saved_at_seq,
             audience = excluded.audience,
             profile_id = excluded.profile_id`,
          [
            record.saveId,
            record.campaignId,
            record.blob,
            record.savedAtSeq,
            record.audience,
            record.profileId ?? null,
          ],
        );
      },
      async delete(saveId) {
        await pool.query(`delete from saves where save_id = $1`, [saveId]);
      },
    },
  };
}

/** The per-player resume query the `SessionStore` contract deliberately has no operation
 *  for (04-core.md §7's ten operations are session-id-keyed, not player-keyed) — the same
 *  gap `campaignSaveIndexKey` fills client-side in `localPersistence()`. Most recent save
 *  per campaign, newest first. */
export async function listSavesForPlayer(
  pool: Pool,
  profileId: string,
): Promise<{ saveId: string; campaignId: string; savedAtSeq: number }[]> {
  const { rows } = await pool.query(
    `select distinct on (campaign_id) save_id, campaign_id, saved_at_seq
     from saves
     where profile_id = $1
     order by campaign_id, saved_at_seq desc`,
    [profileId],
  );
  return rows.map((row) => ({
    saveId: row.save_id as string,
    campaignId: row.campaign_id as string,
    savedAtSeq: row.saved_at_seq as number,
  }));
}

/** Ownership check backing the authorization `preHandler` — the store itself has no
 *  concept of a caller (`getScene(sessionId)` would succeed for anyone holding the id), so
 *  this is the server's own gate, run before any store delegation. */
export async function sessionOwner(
  pool: Pool,
  sessionId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    `select profile_id from sessions where session_id = $1`,
    [sessionId],
  );
  return rows[0]?.profile_id ?? null;
}

export async function saveOwner(
  pool: Pool,
  saveId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    `select profile_id from saves where save_id = $1`,
    [saveId],
  );
  return rows[0]?.profile_id ?? null;
}
