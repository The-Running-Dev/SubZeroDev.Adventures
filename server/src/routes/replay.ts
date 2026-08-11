/**
 * Replay routes: scene-by-scene playback, deterministic verification, and branching --
 * built on `replay.ts`, which uses exported engine API only.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  SessionStoreError,
  type StoredSessionRecord,
} from "@the-running-dev/game-engine";
import { KINDS } from "../../../shared/campaign-registry.js";
import type { ContentCell } from "../content-cell.js";
import { requirePrincipal } from "../principal.js";
import { createPostgresPersistence } from "../persistence.js";
import { assertSessionOwned } from "../store/ownedStore.js";
import { replay, verifyReplay } from "../replay.js";

/**
 * Reads the raw stored record (blob, audience, replayCompatible) replay needs -- outside
 * `SessionStore`'s projection-only surface, so this cannot go through `ownedStore`.
 * Shares `store/ownedStore.ts`'s `assertSessionOwned` rather than reimplementing the
 * owner check, so there remains exactly one ownership comparison in the server, not two.
 */
async function loadSessionRow(
  pool: Pool,
  sessionId: string,
  playerId: string,
  operation: string,
): Promise<StoredSessionRecord> {
  await assertSessionOwned(pool, sessionId, playerId, operation);
  const persistence = createPostgresPersistence(pool, KINDS);
  const record = await persistence.sessions.get(sessionId);
  if (!record) throw new SessionStoreError(operation, "unknown_session");
  return record;
}

export function registerReplayRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  const auth = requirePrincipal(pool);

  app.get("/api/sessions/:id/replay", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const record = await loadSessionRow(
      pool,
      id,
      request.principal.playerId,
      "replay",
    );
    const demo = cell.current();
    const result = replay(demo.engine, demo.createReplayEngine, record.blob);
    return { sessionId: id, steps: result.steps };
  });

  app.post(
    "/api/sessions/:id/replay/verify",
    { preHandler: auth },
    async (request) => {
      const { id } = request.params as { id: string };
      const record = await loadSessionRow(
        pool,
        id,
        request.principal.playerId,
        "replay",
      );
      const demo = cell.current();
      return verifyReplay(
        demo.engine,
        demo.createReplayEngine,
        record.blob,
        record.replayCompatible,
      );
    },
  );

  /**
   * `branch` writes straight to `persistence.sessions.put` instead of through
   * `SessionStore` -- the ten-operation contract has no `branchSession`, so there is
   * nothing on the store to call. This is a known, deliberate deviation, not an
   * oversight: the fix is a new engine operation (`branchSession(sessionId, atSeq) ->
   * SessionHandle`, following the `previewAction` precedent), proposed upstream at
   * The-Running-Dev/SubZeroDev.GameEngine#274, not client-side code working around the
   * missing one. Until that lands, `newSessionId` is still minted through
   * `demo.recordIds` -- the same `RecordIdSource` the store itself uses -- so a branched
   * session at least carries the same unguessable-id property every other session gets,
   * even while the write path stays local.
   */
  app.post(
    "/api/sessions/:id/branch",
    { preHandler: auth },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { atSeq: number };
      const record = await loadSessionRow(
        pool,
        id,
        request.principal.playerId,
        "branch",
      );
      const demo = cell.current();
      const result = replay(
        demo.engine,
        demo.createReplayEngine,
        record.blob,
        body.atSeq,
      );

      const now = new Date().toISOString();
      const newSessionId = demo.recordIds.newSessionId();
      const persistence = createPostgresPersistence(pool, KINDS);
      const branched: StoredSessionRecord = {
        sessionId: newSessionId,
        blob: result.finalBlob,
        audience: record.audience,
        attemptCounter: body.atSeq,
        replayCompatible: record.replayCompatible,
        createdAt: now,
        updatedAt: now,
        ...(record.profileId ? { profileId: record.profileId } : {}),
      };
      await persistence.sessions.put(branched);

      const scene =
        result.steps.length > 0
          ? result.steps[result.steps.length - 1]!.scene
          : demo.engine.scene(demo.engine.deserialize(result.finalBlob).value!);
      return { sessionId: newSessionId, scene };
    },
  );
}
