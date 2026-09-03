/**
 * Replay routes: scene-by-scene playback and deterministic verification -- built on
 * `replay.ts`, which uses exported engine API only. Branching moved to
 * `routes/session.ts`'s `POST /api/sessions/:id/branch`, now that `SessionStore` has its
 * own `branchSession` (engine 0.10.0, W99) -- this file keeps only the two operations that
 * genuinely need the raw stored record outside that store's projection-only surface.
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
}
