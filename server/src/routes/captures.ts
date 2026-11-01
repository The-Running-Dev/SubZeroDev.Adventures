/**
 * Session capture routes (engine spec 08 §8, docs/session-capture.md): taking a capture on a
 * player's report, the fault-capture consent setting, and reading and deleting captures.
 *
 * - Every route resolves an existing principal and never mints one: a request with no account
 *   has no session to report and no capture to read.
 * - A report carries its consent in the request (`consent: true`); without it nothing is
 *   captured. An admin capture is an admin acting on a player's report, and states the same.
 * - A capture is read by its owner or an admin, nobody else. The owner gets the whole fixture,
 *   seed included -- a deliberate departure from 08 §2.1, recorded in CLAUDE.md's decision log.
 * - No response body or log line here carries a fixture except `GET /api/captures/:id`, which
 *   is the read itself, and is never cached.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { SessionStoreError } from "@the-running-dev/game-engine";
import type { ContentCell } from "../content-cell.js";
import { guardPrincipal } from "../principal.js";
import { isAdmin } from "../roles.js";
import { gateCapture } from "../store/ownedStore.js";
import {
  CaptureStorageError,
  deleteCapture,
  deleteCapturesOf,
  faultCaptureConsent,
  listCaptures,
  readCapture,
  setFaultCaptureConsent,
  takeCapture,
} from "../captures/store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(
  reply: FastifyReply,
  status: number,
  operation: string,
  code: string,
) {
  return reply.code(status).send({ error: { operation, code } });
}

export function registerCaptureRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
  retentionDays: number,
): void {
  const signedIn = guardPrincipal(pool, () => true, {
    operation: "captures",
    code: "forbidden",
  });
  const admin = guardPrincipal(
    pool,
    (principal) => isAdmin(pool, principal.playerId),
    { operation: "admin", code: "forbidden" },
  );

  /** The capture itself, behind `gateCapture`. `playerId` null is an admin. */
  async function capture(
    reply: FastifyReply,
    sessionId: string,
    playerId: string | null,
  ) {
    const operation = "captureSession";
    if (!UUID.test(sessionId))
      return refuse(reply, 404, operation, "unknown_session");
    const demo = cell.current();
    const owner = await gateCapture(pool, demo, sessionId, playerId);
    if (owner === undefined)
      throw new SessionStoreError(operation, "unknown_session");
    try {
      const summary = await takeCapture(pool, demo.store, {
        sessionId,
        playerId: owner,
        trigger: "report",
        retentionDays,
      });
      return reply.code(201).send(summary);
    } catch (error) {
      if (!(error instanceof CaptureStorageError)) throw error;
      reply.log.error(
        { captureId: error.captureId, code: error.code },
        "session capture was not stored",
      );
      return refuse(reply, 503, operation, "storage_failure");
    }
  }

  app.post(
    "/api/sessions/:id/capture",
    { preHandler: signedIn },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { consent?: unknown } | undefined;
      if (body?.consent !== true)
        return refuse(reply, 400, "captureSession", "consent_required");
      return capture(reply, id, request.principal.playerId);
    },
  );

  app.get(
    "/api/captures/consent",
    { preHandler: signedIn },
    async (request) => {
      const consentedAt = await faultCaptureConsent(
        pool,
        request.principal.playerId,
      );
      return { faultCapture: consentedAt !== null, consentedAt };
    },
  );

  // POST, not PUT: `app.ts`'s CORS list carries no PUT, and this is the only route that would.
  app.post(
    "/api/captures/consent",
    { preHandler: signedIn },
    async (request, reply) => {
      const body = request.body as { faultCapture?: unknown } | undefined;
      if (typeof body?.faultCapture !== "boolean")
        return refuse(reply, 400, "setCaptureConsent", "invalid_body");
      const consentedAt = await setFaultCaptureConsent(
        pool,
        request.principal.playerId,
        body.faultCapture,
      );
      return { faultCapture: consentedAt !== null, consentedAt };
    },
  );

  app.get("/api/captures", { preHandler: signedIn }, async (request) => ({
    captures: await listCaptures(pool, request.principal.playerId),
  }));

  // Deletion on request: every capture of the caller's, expired or not.
  app.delete("/api/captures", { preHandler: signedIn }, async (request) => ({
    deleted: await deleteCapturesOf(pool, request.principal.playerId),
  }));

  /** The capture when the caller may reach it, else the refusal already sent. */
  async function reachable(
    reply: FastifyReply,
    captureId: string,
    playerId: string,
    operation: string,
  ) {
    const found = UUID.test(captureId)
      ? await readCapture(pool, captureId)
      : undefined;
    if (!found) {
      await refuse(reply, 404, operation, "unknown_capture");
      return undefined;
    }
    if (found.playerId !== playerId && !(await isAdmin(pool, playerId))) {
      await refuse(reply, 403, operation, "forbidden");
      return undefined;
    }
    return found;
  }

  app.get(
    "/api/captures/:id",
    { preHandler: signedIn },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await reachable(
        reply,
        id,
        request.principal.playerId,
        "readCapture",
      );
      if (!found) return reply;
      reply.header("cache-control", "no-store");
      return found;
    },
  );

  app.delete(
    "/api/captures/:id",
    { preHandler: signedIn },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await reachable(
        reply,
        id,
        request.principal.playerId,
        "deleteCapture",
      );
      if (!found) return reply;
      await deleteCapture(pool, id);
      return reply.code(204).send();
    },
  );

  app.get("/api/admin/captures", { preHandler: admin }, async () => ({
    captures: await listCaptures(pool, null),
  }));

  app.post(
    "/api/admin/captures",
    { preHandler: admin },
    async (request, reply) => {
      const body = request.body as
        { sessionId?: unknown; consent?: unknown } | undefined;
      if (typeof body?.sessionId !== "string")
        return refuse(reply, 400, "captureSession", "invalid_body");
      if (body.consent !== true)
        return refuse(reply, 400, "captureSession", "consent_required");
      return capture(reply, body.sessionId, null);
    },
  );
}
