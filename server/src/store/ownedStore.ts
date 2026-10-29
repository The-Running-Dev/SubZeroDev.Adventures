/**
 * The one ownership check (`persistence.ts`'s `sessionOwner`/`saveOwner` against the
 * caller's `playerId`), applied two ways rather than written twice:
 *
 * - `ownedStore` wraps the `SessionStore` every `routes/session.ts` handler calls through
 *   `request.store` -- a route that only ever holds the decorated store cannot reach
 *   another player's session or save no matter which operation it calls, so a route added
 *   later gets the check by construction rather than by remembering a preHandler.
 * - `assertSessionOwned` is exported directly for `routes/replay.ts`, which reads a raw
 *   `StoredSessionRecord` (blob, audience, replayCompatible) that `SessionStore`'s
 *   projection-only surface has no operation for, so it cannot go through `ownedStore`.
 *
 * Both paths throw the same `OwnershipError`, caught once in `routes/session.ts`'s shared
 * error handler (registered on the one Fastify instance both route modules share).
 */
import type { Pool } from "pg";
import {
  SessionStoreError,
  type SessionStore,
} from "@the-running-dev/game-engine";
import { saveOwner, sessionOwner, storedContentRow } from "../persistence.js";
import type { ServerDemo } from "../composition.js";
import {
  ContentRefusal,
  gateExisting,
  gateNewStart,
  lineageOf,
  runAdmitted,
  type Admission,
} from "../content/admission.js";
import { TOMBSTONE_LIVE } from "../content/deletion.js";

export class OwnershipError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`session store: ${operation} — forbidden`);
    this.name = "OwnershipError";
    this.operation = operation;
  }
}

/**
 * Every session and save this server has ever created carries a `profile_id`: the one
 * route that mints either (`POST /api/sessions`, and `POST /api/sessions/:id/branch`,
 * which copies its parent's `profileId`) sits behind `requirePrincipal`, which mints a
 * guest identity rather than ever leaving a request anonymous (`principal.ts`). So a row
 * that exists but carries no owner is not a legitimate unclaimed-by-a-guest state -- it
 * would mean authorization by knowledge of the id alone, which this guard exists to rule
 * out. `undefined` (no such row at all) is passed through instead of denied here, so a
 * bad id still reaches the store's own 404 rather than being preempted by a 403 that
 * implies something real is being withheld.
 */
export async function assertSessionOwned(
  pool: Pool,
  sessionId: string,
  playerId: string,
  operation: string,
): Promise<void> {
  const owner = await sessionOwner(pool, sessionId);
  if (owner === undefined)
    await answerTombstone(pool, "sessions", sessionId, playerId, operation);
  else if (owner !== playerId) throw new OwnershipError(operation);
}

export async function assertSaveOwned(
  pool: Pool,
  saveId: string,
  playerId: string,
  operation: string,
): Promise<void> {
  const owner = await saveOwner(pool, saveId);
  if (owner === undefined)
    await answerTombstone(pool, "saves", saveId, playerId, operation);
  else if (owner !== playerId) throw new OwnershipError(operation);
}

/**
 * A row that is gone may have been purged with its content (engine plan 54, D3 §6). For the
 * tombstone's window its owner -- which follows an account merge -- is told so, `410
 * campaign_deleted`; everyone else gets the `403` the live row gave them, so the deletion
 * discloses nothing new. No live tombstone: the store's own 404, as for an id never issued.
 */
async function answerTombstone(
  pool: Pool,
  table: "sessions" | "saves",
  id: string,
  playerId: string,
  operation: string,
): Promise<void> {
  const { rows } = await pool.query(
    table === "sessions"
      ? `select profile_id from session_tombstones where session_id = $1 and ${TOMBSTONE_LIVE}`
      : `select profile_id from save_tombstones where save_id = $1 and ${TOMBSTONE_LIVE}`,
    [id],
  );
  const tombstone = rows[0];
  if (!tombstone) return;
  if (tombstone.profile_id === playerId)
    throw new ContentRefusal(operation, "campaign_deleted");
  throw new OwnershipError(operation);
}

/**
 * Every id-keyed `SessionStore` operation checked against `playerId` before it reaches
 * the underlying store, and then against the content it would serve (engine plan 54, D4):
 *
 * - `createSession` is a new start. The gate (`content/admission.ts`'s `gateNewStart`) picks
 *   the version from the current publication -- 404 when the campaign is not in it, 403 when
 *   this player cannot reach it, 409 when its epoch cannot run here -- and the store runs
 *   under that admission, so the session is written on exactly that version or not at all.
 * - `branchSession` and `loadGame` derive a new session from an existing one, so they are
 *   gated as existing content and admitted on the versions the source names.
 * - Every other session operation serves an existing session's epoch: gated as existing
 *   content, so a revoked campaign answers `campaign_access_revoked` and an epoch this
 *   process cannot run answers 409. A withdrawn campaign's sessions continue (D4 §4).
 *
 * A write the current publication no longer admits by the time it commits -- a publication
 * or revocation landed between the gate and the write -- comes back as
 * `concurrent_modification`; the operation catches up, is gated again, and retried once.
 *
 * `getStrings` used to narrow the engine's whole-registry answer to the session's campaign.
 * It no longer needs to: every epoch the content archive holds is one campaign's registry
 * (`content/candidate.ts`'s `singleCampaignRegistry`), and the engine store answers from the
 * session's own epochs, so no other campaign's narrative text -- private submissions
 * included -- is ever in it.
 */
export function ownedStore(
  store: SessionStore,
  pool: Pool,
  playerId: string,
  demo: ServerDemo,
): SessionStore {
  const { runtime } = demo;

  /** Ownership, then the content gate, for an operation serving an existing session. A row
   *  that does not exist passes through to the store's own 404. */
  async function existingSession(
    sessionId: string,
    operation: string,
  ): Promise<void> {
    const row = await storedContentRow(pool, "sessions", sessionId);
    if (row === undefined)
      return answerTombstone(pool, "sessions", sessionId, playerId, operation);
    if (row.profileId !== playerId) throw new OwnershipError(operation);
    if (row.campaignVersion === null) return;
    await gateExisting(
      runtime,
      operation,
      { campaignId: row.campaignId, campaignVersion: row.campaignVersion },
      playerId,
      await runtime.check(),
    );
  }

  /** `run` under the admission `admit` decides, gated again and retried once if the fence
   *  refused it. `admit` is the gate: it throws the refusal, or returns the admission. */
  async function admitted<T>(
    admit: () => Promise<Admission>,
    run: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const admission = await admit();
      try {
        return await runAdmitted(admission, run);
      } catch (error) {
        if (attempt > 0 || !isConflict(error)) throw error;
        await runtime.catchUp();
      }
    }
  }

  /** A session derived from an existing session or save: `branchSession`, `loadGame`. */
  function derived<T>(
    table: "sessions" | "saves",
    id: string,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    return admitted(async () => {
      const row = await storedContentRow(pool, table, id, true);
      // No such row: a tombstone's answer, else the store's own 404, under an admission that
      // admits nothing.
      if (row === undefined) {
        await answerTombstone(pool, table, id, playerId, operation);
        return {
          kind: "derived",
          campaignId: "",
          versions: new Set(),
          playerId,
        };
      }
      if (row.profileId !== playerId) throw new OwnershipError(operation);
      const lineage = lineageOf(row.blob!);
      await gateExisting(
        runtime,
        operation,
        lineage,
        playerId,
        await runtime.check(),
      );
      return {
        kind: "derived",
        campaignId: lineage.campaignId,
        versions: lineage.versions,
        playerId,
      };
    }, run);
  }

  return {
    listCampaigns: () => store.listCampaigns(),
    // No id to own yet -- `profileId` here is always `request.principal.playerId`, never
    // client-supplied, so there is nothing for a caller to forge their way past.
    listSaves: (profileId) => store.listSaves(profileId),
    // Deleting serves no content, so a revoked or unsupported campaign's save can still go.
    async deleteSave(profileId, saveId, expectedSavedAt) {
      await assertSaveOwned(pool, saveId, playerId, "deleteSave");
      return store.deleteSave(profileId, saveId, expectedSavedAt);
    },
    branchSession: (sessionId, atActionCount) =>
      derived("sessions", sessionId, "branchSession", () =>
        store.branchSession(sessionId, atActionCount),
      ),
    createSession: (config) =>
      admitted(
        async () => ({
          kind: "new",
          campaignId: config.campaignId,
          campaignVersion: gateNewStart(
            runtime,
            "createSession",
            config.campaignId,
            playerId,
            await runtime.check(),
          ),
          playerId,
        }),
        () => store.createSession(config),
      ),

    async getScene(sessionId) {
      await existingSession(sessionId, "getScene");
      return store.getScene(sessionId);
    },
    async getView(sessionId) {
      await existingSession(sessionId, "getView");
      return store.getView(sessionId);
    },
    async getStrings(sessionId) {
      await existingSession(sessionId, "getStrings");
      // The engine store answers from the session's own epochs -- core and kind messages plus
      // those epochs' authored strings -- which is right for a session pinned to an epoch the
      // current publication no longer offers, too.
      return store.getStrings(sessionId);
    },
    async previewAction(sessionId, actionId, params) {
      await existingSession(sessionId, "previewAction");
      return store.previewAction(sessionId, actionId, params);
    },
    async resumeSession(sessionId) {
      await existingSession(sessionId, "resumeSession");
      return store.resumeSession(sessionId);
    },
    async submitAction(sessionId, actionId, params) {
      await existingSession(sessionId, "submitAction");
      return store.submitAction(sessionId, actionId, params);
    },
    async saveGame(sessionId) {
      await existingSession(sessionId, "saveGame");
      return store.saveGame(sessionId);
    },
    loadGame: (saveId) =>
      derived("saves", saveId, "loadGame", () => store.loadGame(saveId)),
  };
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof SessionStoreError &&
    error.code === "concurrent_modification"
  );
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by the `attachStore` preHandler (`routes/session.ts`) once `request.principal`
     *  exists. A route registered without that preHandler gets a `TypeError` on first use
     *  instead of silently reaching the raw, unchecked store. */
    store: SessionStore;
  }
}
