import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ContentCell } from "../content-cell.js";
import { resolvePrincipal } from "../principal.js";
import { OfflineError, ownedOfflineStore } from "../offline/store.js";
export function registerOfflineRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
) {
  const resolve = resolvePrincipal(pool);
  async function execute<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OfflineError) return { offlineError: error };
      throw error;
    }
  }
  app.post(
    "/api/offline/download/:campaignId",
    { preHandler: resolve },
    async (request, reply) => {
      const { campaignId } = request.params as { campaignId: string };
      const { sessionId } = (request.body ?? {}) as { sessionId?: string };
      const result = await execute(() =>
        ownedOfflineStore(
          pool,
          cell.current(),
          request.principalOrNull ?? null,
        ).download(campaignId, sessionId),
      );
      reply.header("Cache-Control", "no-store");
      if ("offlineError" in result)
        return reply
          .code(result.offlineError.status)
          .send({ error: { code: result.offlineError.code } });
      return result;
    },
  );
  app.post(
    "/api/offline/sync",
    { preHandler: resolve, bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const result = await execute(() =>
        ownedOfflineStore(
          pool,
          cell.current(),
          request.principalOrNull ?? null,
        ).sync(request.body),
      );
      reply.header("Cache-Control", "no-store");
      if ("offlineError" in result)
        return reply
          .code(result.offlineError.status)
          .send({ error: { code: result.offlineError.code } });
      return result;
    },
  );
  app.get(
    "/api/offline/archive",
    { preHandler: resolve },
    async (request, reply) => {
      const result = await execute(() =>
        ownedOfflineStore(
          pool,
          cell.current(),
          request.principalOrNull ?? null,
        ).archive(),
      );
      reply.header("Cache-Control", "no-store");
      if ("offlineError" in result)
        return reply
          .code(result.offlineError.status)
          .send({ error: { code: result.offlineError.code } });
      return result;
    },
  );
}
