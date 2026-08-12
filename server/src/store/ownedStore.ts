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
import type { SessionStore } from "@the-running-dev/game-engine";
import { saveOwner, sessionCampaignId, sessionOwner } from "../persistence.js";
import type { ServerDemo } from "../composition.js";

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
  if (owner !== undefined && owner !== playerId)
    throw new OwnershipError(operation);
}

export async function assertSaveOwned(
  pool: Pool,
  saveId: string,
  playerId: string,
  operation: string,
): Promise<void> {
  const owner = await saveOwner(pool, saveId);
  if (owner !== undefined && owner !== playerId)
    throw new OwnershipError(operation);
}

/**
 * Every id-keyed `SessionStore` operation checked against `playerId` before it reaches
 * the underlying store. `listCampaigns` passes straight through -- there is no existing id
 * to own yet. `createSession` and `getStrings` are the two operations this decorator does
 * more than check ownership for:
 *
 * - `createSession` checks `demo.accessibleCampaignIds(playerId)` before minting a session on
 *   a campaign this player cannot reach -- someone else's private or pending submission,
 *   specifically. A `campaignId` this player *can* reach, or one that isn't registered at all,
 *   passes straight through to the underlying store's own `unknown_campaign` -- same
 *   "don't preempt a real 404 with a 403" posture as `assertSessionOwned` below.
 * - `getStrings` narrows the engine's own whole-registry answer
 *   (`SessionStore.getStrings` has no per-campaign partition — see `composition.ts`'s
 *   `stringsFor`) to the one campaign this session is actually playing, via `sessionCampaignId`
 *   -- otherwise a session in a core campaign would read every private submission's narrative
 *   text off the same shared registry.
 */
export function ownedStore(
  store: SessionStore,
  pool: Pool,
  playerId: string,
  demo: ServerDemo,
): SessionStore {
  return {
    listCampaigns: () => store.listCampaigns(),
    async createSession(config) {
      const accessible = demo.accessibleCampaignIds(playerId);
      const registered = demo.all.some(
        (campaign) => campaign.campaignId === config.campaignId,
      );
      if (registered && !accessible.has(config.campaignId)) {
        throw new OwnershipError("createSession");
      }
      return store.createSession(config);
    },

    async getScene(sessionId) {
      await assertSessionOwned(pool, sessionId, playerId, "getScene");
      return store.getScene(sessionId);
    },
    async getView(sessionId) {
      await assertSessionOwned(pool, sessionId, playerId, "getView");
      return store.getView(sessionId);
    },
    async getStrings(sessionId) {
      await assertSessionOwned(pool, sessionId, playerId, "getStrings");
      const campaignId = await sessionCampaignId(pool, sessionId);
      // No row -- `assertSessionOwned` above already let this through as "no such session",
      // so the underlying call is what actually produces the `unknown_session` error.
      if (campaignId === undefined) return store.getStrings(sessionId);
      return demo.stringsFor([campaignId]);
    },
    async previewAction(sessionId, actionId, params) {
      await assertSessionOwned(pool, sessionId, playerId, "previewAction");
      return store.previewAction(sessionId, actionId, params);
    },
    async resumeSession(sessionId) {
      await assertSessionOwned(pool, sessionId, playerId, "resumeSession");
      return store.resumeSession(sessionId);
    },
    async submitAction(sessionId, actionId, params) {
      await assertSessionOwned(pool, sessionId, playerId, "submitAction");
      return store.submitAction(sessionId, actionId, params);
    },
    async saveGame(sessionId) {
      await assertSessionOwned(pool, sessionId, playerId, "saveGame");
      return store.saveGame(sessionId);
    },
    async loadGame(saveId) {
      await assertSaveOwned(pool, saveId, playerId, "loadGame");
      return store.loadGame(saveId);
    },
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by the `attachStore` preHandler (`routes/session.ts`) once `request.principal`
     *  exists. A route registered without that preHandler gets a `TypeError` on first use
     *  instead of silently reaching the raw, unchecked store. */
    store: SessionStore;
  }
}
