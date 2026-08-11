import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ContentCell } from "./content-cell.js";

export function registerHealthRoute(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  app.get("/healthz", async (_request, reply) => {
    const dbOk = await pool
      .query("select 1")
      .then(() => true)
      .catch(() => false);

    const content = cell.status();
    // A refresh that has never succeeded is a startup-ordering impossibility --
    // `createContentCell`'s `ready()` is awaited before any route registers -- so a failure
    // here only ever means the *most recent* refresh failed and the previous catalog is
    // still what's serving. Degraded, not unhealthy: players are unaffected.
    const contentOk =
      content.lastFailureAt === undefined ||
      (content.lastSuccessAt !== undefined &&
        content.lastSuccessAt > content.lastFailureAt);

    if (!dbOk) {
      reply.code(503);
      return { ok: false };
    }
    if (!contentOk) {
      reply.code(200);
      return { ok: true, degraded: true, content };
    }
    return { ok: true, content };
  });
}
