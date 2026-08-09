import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export function registerHealthRoute(app: FastifyInstance, pool: Pool): void {
  app.get("/healthz", async (_request, reply) => {
    try {
      await pool.query("select 1");
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });
}
