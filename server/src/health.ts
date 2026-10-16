import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ContentCell } from "./content-cell.js";

/** How long `select 1` gets before the database counts as not answering. `pg` sets no
 *  connect or query timeout of its own, so a database that has stopped responding --
 *  rather than refusing -- would otherwise hang the probe until the caller gave up. Kept
 *  under the edge's own 5-second readiness budget so the edge hears a 503 from here, not
 *  a timeout of its own making. */
export const DATABASE_PROBE_TIMEOUT_MS = 2_000;

/** Whether Postgres answers within the timeout. Shared by `/readyz` and `/healthz` so the
 *  two can never disagree about what "the database is up" means. */
function databaseAnswers(pool: Pool, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const answered = pool
    .query("select 1")
    .then(() => true)
    .catch(() => false);
  return Promise.race([answered, timedOut]).finally(() => clearTimeout(timer));
}

export function registerHealthRoute(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
  databaseTimeoutMs: number = DATABASE_PROBE_TIMEOUT_MS,
): void {
  // Liveness: is this process able to answer at all. It declares no external dependency
  // -- not Postgres, not the content source -- because an orchestrator restarts whatever
  // fails liveness, and restarting the API cannot bring a stopped database back. A
  // liveness probe that touched Postgres would turn a database outage into a restart loop
  // (Platform's invariant 42, which its edge holds itself to; issue #9, stage 3).
  app.get("/livez", async () => ({ ok: true }));

  // Readiness: should traffic be sent here. Postgres is the one dependency every route
  // needs, so it is the one this checks. Content is not: `ready()` is awaited before any
  // route registers, so a catalog always exists by the time this answers, and a failed
  // *refresh* leaves the previous catalog serving -- degraded, which `/healthz` reports,
  // not unready. The body says nothing beyond `ok`: the edge's readiness check reads the
  // status code and nothing else, and this route is unauthenticated.
  app.get("/readyz", async (_request, reply) => {
    if (!(await databaseAnswers(pool, databaseTimeoutMs))) {
      reply.code(503);
      return { ok: false };
    }
    return { ok: true };
  });

  // The original combined probe, kept as it was: the readiness answer plus the content
  // status an operator reads. Existing monitors point here.
  app.get("/healthz", async (_request, reply) => {
    const dbOk = await databaseAnswers(pool, databaseTimeoutMs);

    const status = cell.status();
    // A refresh that has never succeeded is a startup-ordering impossibility --
    // `createContentCell`'s `ready()` is awaited before any route registers -- so a failure
    // here only ever means the *most recent* refresh failed and the previous catalog is
    // still what's serving. Degraded, not unhealthy: players are unaffected.
    const contentOk =
      status.lastFailureAt === undefined ||
      (status.lastSuccessAt !== undefined &&
        status.lastSuccessAt > status.lastFailureAt);

    // Core fields only -- this route is unauthenticated. `campaignCount`/`contentDigest`
    // move on any private submission's change, which would make them a public "did a
    // private submission just appear/change" side channel; `coreCampaignCount`/
    // `coreContentDigest` (content-cell.ts) never do.
    const content = {
      campaignCount: status.coreCampaignCount,
      contentDigest: status.coreContentDigest,
      lastSuccessAt: status.lastSuccessAt,
      lastFailureAt: status.lastFailureAt,
      lastError: status.lastError,
      bootstrapFallback: status.bootstrapFallback,
    };

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
