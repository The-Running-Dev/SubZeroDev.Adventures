/**
 * The ten `SessionStore` operations over HTTP, mirroring the upstream MCP server's
 * `createMcpTools` (`engine/src/engine/src/mcp/server.ts`) -- every handler a direct
 * delegation, no game logic in the adapter. Plus `/api/campaigns`, `/api/me`,
 * `/api/auth/logout`, and `/api/saves`, which the store contract has no operation for.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  SessionStoreError,
  type ActionParams,
  type SessionStore,
} from "@the-running-dev/game-engine";
import type { ServerDemo } from "../composition.js";
import { requirePlayer, resolvePlayer, logout } from "../auth.js";
import { listSavesForPlayer, saveOwner, sessionOwner } from "../persistence.js";

const ERROR_STATUS: Record<string, number> = {
  unknown_session: 404,
  unknown_save: 404,
  unknown_campaign: 404,
  storage_failure: 503,
  invalid_state: 409,
  unknown_kind: 409,
  save_requires_migration: 409,
  migration_failed: 409,
};

function statusFor(code: string): number {
  return ERROR_STATUS[code] ?? 400;
}

/**
 * Authorization is the server's job, not the engine's -- `SessionStore.getScene(id)`
 * would succeed for anyone holding the id. Runs before any store delegation, on every
 * route that references an existing `:id`.
 */
function ownershipGuard(pool: Pool, kind: "session" | "save") {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const params = request.params as { id?: string; saveId?: string };
    const id = kind === "session" ? params.id : params.saveId;
    if (!id) return;
    const owner =
      kind === "session"
        ? await sessionOwner(pool, id)
        : await saveOwner(pool, id);
    if (owner !== null && owner !== request.player.playerId) {
      await reply
        .code(403)
        .send({ error: { operation: kind, code: "forbidden" } });
    }
  };
}

export function registerSessionRoutes(
  app: FastifyInstance,
  pool: Pool,
  demo: ServerDemo,
): void {
  const store: SessionStore = demo.store;
  const auth = requirePlayer(pool);
  // Read-only: resolves an existing session but never mints a guest row, so a bare GET
  // from a crawler or a logged-out browser doesn't grow the `players` table.
  const resolve = resolvePlayer(pool);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SessionStoreError) {
      reply.code(statusFor(error.code));
      return reply.send({
        error: { operation: error.operation, code: error.code },
      });
    }
    // A framework-level error (malformed JSON, an empty body Fastify's parser rejects,
    // etc.) already carries its own `statusCode` -- respecting it here rather than always
    // answering 500 is what keeps a client error a 4xx instead of masquerading as a
    // server fault.
    const withStatus = error as { statusCode?: unknown };
    const status =
      typeof withStatus.statusCode === "number" ? withStatus.statusCode : 500;
    request.log.error(error);
    reply.code(status);
    return reply.send({
      error: { operation: "unknown", code: "internal_error" },
    });
  });

  // Unfiltered -- a hidden campaign is reachable via a direct `?campaign=` link
  // (composition.ts), and `BrowserDemo.findCampaign` is synchronous, so the full catalog
  // including hidden entries has to be prefetched here rather than resolved per lookup.
  // `summaries` backs `SessionStore.listCampaigns()`, which the contract requires to be
  // synchronous too (04-core.md) -- the browser's `RemoteSessionStore` cannot fetch it
  // lazily, so it rides along in the same response `createRemoteDemo` already awaits.
  app.get("/api/campaigns", async () => ({
    campaigns: demo.all,
    summaries: store.listCampaigns(),
  }));

  app.get("/api/me", { preHandler: resolve }, async (request) => {
    const player = request.playerOrNull;
    if (!player)
      return { playerId: null, kind: "anonymous", displayName: null };
    return {
      playerId: player.playerId,
      kind: player.kind,
      displayName: player.displayName,
    };
  });

  // Logout still needs `auth` (not `resolve`) -- there is nothing useful to log out of an
  // anonymous request, and requiring a real cookie here keeps the route's contract simple.
  app.post("/api/auth/logout", { preHandler: auth }, async (request, reply) => {
    await logout(pool, request, reply);
    return { ok: true };
  });

  app.get("/api/saves", { preHandler: resolve }, async (request) => ({
    saves: request.playerOrNull
      ? await listSavesForPlayer(pool, request.playerOrNull.playerId)
      : [],
  }));

  app.post("/api/sessions", { preHandler: auth }, async (request) => {
    const body = request.body as { campaignId: string; seed?: string };
    return store.createSession({
      campaignId: body.campaignId,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      audience: "player",
      profileId: request.player.playerId,
    });
  });

  app.post(
    "/api/sessions/:id/resume",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => {
      const { id } = request.params as { id: string };
      const scene = await store.resumeSession(id);
      return { sessionId: id, scene };
    },
  );

  app.get(
    "/api/sessions/:id/scene",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => store.getScene((request.params as { id: string }).id),
  );

  app.get(
    "/api/sessions/:id/view",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => store.getView((request.params as { id: string }).id),
  );

  app.get(
    "/api/sessions/:id/strings",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => store.getStrings((request.params as { id: string }).id),
  );

  app.post(
    "/api/sessions/:id/actions/preview",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { actionId: string; params?: ActionParams };
      return store.previewAction(id, body.actionId, body.params);
    },
  );

  app.post(
    "/api/sessions/:id/actions",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { actionId: string; params?: ActionParams };
      return store.submitAction(id, body.actionId, body.params);
    },
  );

  app.post(
    "/api/sessions/:id/save",
    { preHandler: [auth, ownershipGuard(pool, "session")] },
    async (request) => store.saveGame((request.params as { id: string }).id),
  );

  app.post(
    "/api/saves/:saveId/load",
    { preHandler: [auth, ownershipGuard(pool, "save")] },
    async (request) =>
      store.loadGame((request.params as { saveId: string }).saveId),
  );
}
