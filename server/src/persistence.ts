/**
 * `SessionPersistence` over Postgres — the same five-method port
 * `localPersistence()` fills with `localStorage` in the browser
 * (`src/play/composition.ts`), so `createInMemorySessionStore` (which treats persistence
 * as a write-through cache, reading on miss) needs no changes to run against this.
 */
import type { Pool } from "pg";
import type {
  KindRegistry,
  SessionPersistence,
  StoredSaveRecord,
  StoredSessionRecord,
} from "@the-running-dev/game-engine";

/**
 * Reads the four columns `/api/progress` (routes/progress.ts) queries across every
 * session without deserializing each blob through the engine -- `blob` is
 * `canonicalStringify(GameState)` (002_sessions_and_saves.sql), so `campaignId`,
 * `status`, and `actionLog.length` sit at fixed top-level paths. `endingId` is the one
 * field that isn't: it's the kind's own `outcome(kindState)`
 * (core/kernel/types.ts's "cross-version-stable terminal identity"), so it takes the
 * registry to resolve which kind owns this session and calls through to it. Only
 * `storyGraphKind`'s outcome shape (`{endingId}`) is recognized here -- a future kind
 * with a differently-shaped outcome simply reports no ending, rather than this code
 * guessing at its fields.
 */
function deriveProgressColumns(
  kinds: KindRegistry,
  blob: string,
): {
  campaignId: string;
  status: string;
  stepCount: number;
  endingId: string | null;
} {
  const state = JSON.parse(blob) as {
    campaignId: string;
    status: string;
    kindId: string;
    kindState: unknown;
    actionLog: unknown[];
  };
  const stepCount = Array.isArray(state.actionLog) ? state.actionLog.length : 0;

  let endingId: string | null = null;
  if (state.status === "ended") {
    const kind = kinds[state.kindId as keyof KindRegistry];
    const outcome = kind?.outcome(state.kindState);
    if (
      outcome !== null &&
      typeof outcome === "object" &&
      "endingId" in outcome &&
      typeof (outcome as { endingId: unknown }).endingId === "string"
    ) {
      endingId = (outcome as { endingId: string }).endingId;
    }
  }

  return {
    campaignId: state.campaignId,
    status: state.status,
    stepCount,
    endingId,
  };
}

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

export function createPostgresPersistence(
  pool: Pool,
  kinds: KindRegistry,
): SessionPersistence {
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
      /**
       * Compare-and-swap on `attempt_counter`, not a new column -- `submitAction`
       * (`engine/…/core/session/store.ts`) already increments it by exactly 1 on every
       * write to an *existing* row (`createSession`/`loadGame` only ever `put` a brand
       * new `sessionId`, never a conflicting one), so it's already the version number
       * this needs. `on conflict … do update … where` is the standard optimistic-lock
       * shape: a real insert (new id) is unaffected by the `where`, a legitimate
       * sequential update matches it and applies, and a write that lost the race --
       * two tabs, or two store instances behind a future second replica, both starting
       * from the same `attempt_counter` -- fails to match and is silently *not* applied
       * (0 rows affected), which the check below turns into a thrown rejection rather
       * than a merge. That rejection crosses `writeSession`'s `catch { throw
       * SessionStoreError("session","storage_failure") }` in the engine (out of this
       * repo's control), so it surfaces to the client as a 503 -- indistinguishable from
       * a genuine storage outage, but still the one signal that means "re-read and
       * retry" rather than a silently applied lost update.
       *
       * No backfill risk: `attempt_counter` is an existing, already-populated, `not
       * null` column, so this enforces from the moment it deploys -- there is no new
       * column that could be null on rows written before this change.
       */
      async put(record) {
        const progress = deriveProgressColumns(kinds, record.blob);
        const { rowCount } = await pool.query(
          `insert into sessions (session_id, blob, audience, attempt_counter, replay_compatible, profile_id, created_at, updated_at, campaign_id, status, ending_id, step_count)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (session_id) do update set
             blob = excluded.blob,
             audience = excluded.audience,
             attempt_counter = excluded.attempt_counter,
             replay_compatible = excluded.replay_compatible,
             profile_id = excluded.profile_id,
             updated_at = excluded.updated_at,
             campaign_id = excluded.campaign_id,
             status = excluded.status,
             ending_id = excluded.ending_id,
             step_count = excluded.step_count
           where sessions.attempt_counter = excluded.attempt_counter - 1`,
          [
            record.sessionId,
            record.blob,
            record.audience,
            record.attemptCounter,
            record.replayCompatible,
            record.profileId ?? null,
            record.createdAt,
            record.updatedAt,
            progress.campaignId,
            progress.status,
            progress.endingId,
            progress.stepCount,
          ],
        );
        if (rowCount === 0) {
          throw new Error(
            `session store: concurrent write conflict for session "${record.sessionId}" at attempt ${record.attemptCounter}`,
          );
        }
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

/**
 * Ownership check backing the authorization `preHandler` — the store itself has no
 * concept of a caller (`getScene(sessionId)` would succeed for anyone holding the id), so
 * this is the server's own gate, run before any store delegation.
 *
 * Returns `undefined` for a row that does not exist at all, distinct from `null` for a
 * row that exists but carries no `profile_id` — the caller (`store/ownedStore.ts`) needs
 * to tell those apart: a missing id should still surface as the store's own 404
 * (`unknown_session`/`unknown_save`), not get preempted by a 403 that implies something
 * real is being withheld.
 */
export async function sessionOwner(
  pool: Pool,
  sessionId: string,
): Promise<string | null | undefined> {
  const { rows } = await pool.query(
    `select profile_id from sessions where session_id = $1`,
    [sessionId],
  );
  return rows[0] ? (rows[0].profile_id ?? null) : undefined;
}

export async function saveOwner(
  pool: Pool,
  saveId: string,
): Promise<string | null | undefined> {
  const { rows } = await pool.query(
    `select profile_id from saves where save_id = $1`,
    [saveId],
  );
  return rows[0] ? (rows[0].profile_id ?? null) : undefined;
}
