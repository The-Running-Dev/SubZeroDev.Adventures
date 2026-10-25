/**
 * `SessionPersistence` over Postgres — the same five-method port
 * `localPersistence()` fills with `localStorage` in the browser
 * (`src/play/composition.ts`), so `createInMemorySessionStore` (which treats persistence
 * as a write-through cache, reading on miss) needs no changes to run against this.
 */
import type { Pool } from "pg";
import {
  SESSION_PERSISTENCE_CONFLICT,
  type KindRegistry,
  type SessionPersistence,
  type StoredSaveRecord,
  type StoredSessionRecord,
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
  revision: number;
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
    revision: row.revision,
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
  saved_at: string;
  saved_at_seq: number;
  audience: string;
  profile_id: string | null;
}): StoredSaveRecord {
  return {
    saveId: row.save_id,
    campaignId: row.campaign_id,
    blob: row.blob,
    savedAt: row.saved_at,
    savedAtSeq: row.saved_at_seq,
    audience: row.audience as StoredSaveRecord["audience"],
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
  };
}

/** Last, largest and summed UTF-8 size of the session blobs one direction has carried. */
export interface BlobBytes {
  last: number;
  max: number;
  total: number;
}

/**
 * What the session half of this adapter has done since the process started -- the only view
 * an operator has of the engine store's in-process cache, which reports nothing about itself
 * (engine `design/90-decisions.md`'s register, "The session store reports nothing about its
 * own memory").
 *
 * `cacheMisses` is every `sessions.get`: `createInMemorySessionStore` reads persistence only
 * when a session is not cached, so a rising count under steady traffic means
 * `sessionCacheLimit` is evicting sessions that are still being played. A miss for an id that
 * does not exist counts too -- the store asked. `writes` is accepted `sessions.put` calls; a
 * lost compare-and-swap is not one.
 *
 * Process-wide, not per adapter: `app.ts` creates one and hands it to every
 * `createServerDemo`, because a content refresh builds a new adapter each time and the
 * counts would otherwise reset with it.
 */
export interface SessionPersistenceCounters {
  cacheMisses: number;
  writes: number;
  readBlobBytes: BlobBytes;
  writtenBlobBytes: BlobBytes;
}

export function createSessionPersistenceCounters(): SessionPersistenceCounters {
  return {
    cacheMisses: 0,
    writes: 0,
    readBlobBytes: { last: 0, max: 0, total: 0 },
    writtenBlobBytes: { last: 0, max: 0, total: 0 },
  };
}

function recordBlob(bytes: BlobBytes, blob: string): void {
  const size = Buffer.byteLength(blob, "utf8");
  bytes.last = size;
  bytes.max = Math.max(bytes.max, size);
  bytes.total += size;
}

export function createPostgresPersistence(
  pool: Pool,
  kinds: KindRegistry,
  counters: SessionPersistenceCounters = createSessionPersistenceCounters(),
): SessionPersistence {
  return {
    sessions: {
      async get(sessionId) {
        counters.cacheMisses += 1;
        const { rows } = await pool.query(
          `select session_id, blob, audience, attempt_counter, revision, replay_compatible, profile_id, created_at, updated_at
           from sessions where session_id = $1`,
          [sessionId],
        );
        if (!rows[0]) return undefined;
        recordBlob(counters.readBlobBytes, rows[0].blob as string);
        return toSessionRecord(rows[0]);
      },
      /**
       * Compare-and-swap on `revision` (engine `StoredSessionRecord.revision`, 04-core §7.2):
       * `0` when first written, `+1` on every accepted write, never moved by a rejection or a
       * preview. `attempt_counter` is not a version -- a rejected submission advances it
       * without a write, so comparing it refused the next valid action after any rejection.
       * `on conflict … do update … where` is the optimistic-lock shape: a real insert (new
       * id) is unaffected by the `where`, a sequential update matches it and applies, and a
       * write that lost the race -- two tabs, or two store instances behind a second replica,
       * both starting from the same revision -- matches nothing (0 rows affected).
       *
       * That loss throws an error branded `SESSION_PERSISTENCE_CONFLICT`, the one failure the
       * engine lets a host classify: it reports `concurrent_modification` (409) instead of
       * `storage_failure`, and evicts its stale cached record so a retry re-reads this row.
       */
      async put(record) {
        const progress = deriveProgressColumns(kinds, record.blob);
        const { rowCount } = await pool.query(
          `insert into sessions (session_id, blob, audience, attempt_counter, revision, replay_compatible, profile_id, created_at, updated_at, campaign_id, status, ending_id, step_count)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (session_id) do update set
             blob = excluded.blob,
             audience = excluded.audience,
             attempt_counter = excluded.attempt_counter,
             revision = excluded.revision,
             replay_compatible = excluded.replay_compatible,
             profile_id = excluded.profile_id,
             updated_at = excluded.updated_at,
             campaign_id = excluded.campaign_id,
             status = excluded.status,
             ending_id = excluded.ending_id,
             step_count = excluded.step_count
           where sessions.revision = excluded.revision - 1`,
          [
            record.sessionId,
            record.blob,
            record.audience,
            record.attemptCounter,
            record.revision,
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
          const conflict = new Error(
            `session store: concurrent write conflict for session "${record.sessionId}" at revision ${record.revision}`,
          );
          conflict.name = SESSION_PERSISTENCE_CONFLICT;
          throw conflict;
        }
        counters.writes += 1;
        recordBlob(counters.writtenBlobBytes, record.blob);
      },
    },
    saves: {
      async get(saveId) {
        const { rows } = await pool.query(
          `select save_id, campaign_id, blob, saved_at, saved_at_seq, audience, profile_id
           from saves where save_id = $1`,
          [saveId],
        );
        return rows[0] ? toSaveRecord(rows[0]) : undefined;
      },
      async put(record) {
        await pool.query(
          `insert into saves (save_id, campaign_id, blob, saved_at, saved_at_seq, audience, profile_id)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (save_id) do update set
             campaign_id = excluded.campaign_id,
             blob = excluded.blob,
             saved_at = excluded.saved_at,
             saved_at_seq = excluded.saved_at_seq,
             audience = excluded.audience,
             profile_id = excluded.profile_id`,
          [
            record.saveId,
            record.campaignId,
            record.blob,
            record.savedAt,
            record.savedAtSeq,
            record.audience,
            record.profileId ?? null,
          ],
        );
      },
      /** §7.4: conditional -- only when `saved_at` still matches what the caller last read,
       *  the same optimistic-lock shape `sessions.put`'s `revision` compare-and-swap
       *  uses. 0 rows affected (already deleted, or raced by another write) is silent here,
       *  same as it always was for this method -- the engine's own `deleteSave` is what
       *  turns that into `concurrent_modification` for the caller, by re-reading the save
       *  first and comparing `expectedSavedAt` before ever calling this. */
      async delete(saveId, expectedSavedAt) {
        await pool.query(
          `delete from saves where save_id = $1 and saved_at = $2`,
          [saveId, expectedSavedAt],
        );
      },
      /** §7.4. Every record this adapter holds for one profile -- the engine's own
       *  `listSaves` does the `savedAt` descending / `saveId` ascending sort, so this
       *  returns rows in any order. */
      async listByProfile(profileId) {
        const { rows } = await pool.query(
          `select save_id, campaign_id, blob, saved_at, saved_at_seq, audience, profile_id
           from saves where profile_id = $1`,
          [profileId],
        );
        return rows.map(toSaveRecord);
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

/** A session's campaign id, or `undefined` if the session doesn't exist -- `store/ownedStore.ts`'s
 *  `getStrings` override reads this to know which campaign's strings a session may see,
 *  since the engine's own `getStrings` has no per-campaign partition to narrow by. */
export async function sessionCampaignId(
  pool: Pool,
  sessionId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select campaign_id from sessions where session_id = $1`,
    [sessionId],
  );
  return rows[0]?.campaign_id as string | undefined;
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
