/**
 * Replay routes: scene-by-scene playback, deterministic verification, and branching --
 * built on `replay.ts`, which uses exported engine API only.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  SessionStoreError,
  type StoredSessionRecord,
} from "@the-running-dev/game-engine";
import { KINDS } from "../../../shared/campaign-registry.js";
import type { ServerDemo } from "../composition.js";
import { requirePlayer } from "../auth.js";
import { createPostgresPersistence, sessionOwner } from "../persistence.js";
import { replay, verifyReplay } from "../replay.js";

function ownershipGuard(pool: Pool) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { id } = request.params as { id: string };
    const owner = await sessionOwner(pool, id);
    if (owner !== null && owner !== request.player.playerId) {
      await reply
        .code(403)
        .send({ error: { operation: "session", code: "forbidden" } });
    }
  };
}

async function loadSessionRow(
  pool: Pool,
  sessionId: string,
): Promise<StoredSessionRecord> {
  const persistence = createPostgresPersistence(pool, KINDS);
  const record = await persistence.sessions.get(sessionId);
  if (!record) throw new SessionStoreError("replay", "unknown_session");
  return record;
}

export function registerReplayRoutes(
  app: FastifyInstance,
  pool: Pool,
  demo: ServerDemo,
): void {
  const auth = requirePlayer(pool);
  const owned = ownershipGuard(pool);

  app.get(
    "/api/sessions/:id/replay",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const record = await loadSessionRow(pool, id);
      const result = replay(demo.engine, demo.createReplayEngine, record.blob);
      return { sessionId: id, steps: result.steps };
    },
  );

  app.post(
    "/api/sessions/:id/replay/verify",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const record = await loadSessionRow(pool, id);
      return verifyReplay(
        demo.engine,
        demo.createReplayEngine,
        record.blob,
        record.replayCompatible,
      );
    },
  );

  app.post(
    "/api/sessions/:id/branch",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { atSeq: number };
      const record = await loadSessionRow(pool, id);
      const result = replay(
        demo.engine,
        demo.createReplayEngine,
        record.blob,
        body.atSeq,
      );

      const now = new Date().toISOString();
      const newSessionId = randomUUID();
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
