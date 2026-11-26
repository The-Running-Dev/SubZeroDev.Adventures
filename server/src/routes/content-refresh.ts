/**
 * `POST /api/content/refresh` -- the publisher's trigger (issue #21). When the content
 * repository publishes, its workflow calls this, and the running server rebuilds its catalog
 * through the same content cell the admin page's Sync button uses. That is what lets a
 * campaign published after the last deploy become playable without one, and without the
 * server polling its sources on a timer.
 *
 * Service-to-service, not a principal. The caller is a CI job, not a player: it holds no
 * session, mints no guest, and never reaches `principal.ts` -- the identity seam
 * (CLAUDE.md, "The Identity Seam") stays about players. A shared secret compared here is the
 * whole mechanism, sent as `Authorization: Bearer <secret>`. Both sides are hashed before the
 * constant-time comparison so it compares equal-length buffers and the secret's length does
 * not leak through an early return.
 *
 * Everything else is the cell's: `refresh()` publishes only a build that succeeded (a failed
 * one keeps serving the previous catalog, #22) and joins a refresh already in flight, so a
 * publish that fires twice, or overlaps an admin's Sync, runs one rebuild, never two
 * interleaved ones.
 *
 * One process today (`docker-compose.yml` runs one `adventures-api`), so one call reaches
 * the one catalog. Under more than one replica (#9) a call reaches whichever process the
 * edge routes it to, and the others keep serving what they had -- that fan-out is #9's to
 * solve, not this route's.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ContentCell } from "../content-cell.js";

const BEARER = "Bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function presented(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith(BEARER))
    return undefined;
  const token = authorization.slice(BEARER.length).trim();
  return token === "" ? undefined : token;
}

/**
 * `secret` is `CONTENT_REFRESH_SECRET` as `index.ts` read it. Undefined means the trigger is
 * not configured: the route is still registered and answers `503 not_configured`, so the
 * publisher's workflow can tell "this deployment has no trigger" from a mistyped URL -- the
 * same posture `routes/discussions.ts` takes.
 */
export function registerContentRefreshRoute(
  app: FastifyInstance,
  cell: ContentCell,
  secret: string | undefined,
): void {
  const expected = secret === undefined ? undefined : digest(secret);

  app.post("/api/content/refresh", async (request, reply) => {
    if (expected === undefined) {
      reply.code(503);
      return {
        error: { operation: "content_refresh", code: "not_configured" },
      };
    }

    const token = presented(request.headers.authorization);
    if (token === undefined || !timingSafeEqual(digest(token), expected)) {
      reply.code(401);
      return { error: { operation: "content_refresh", code: "unauthorized" } };
    }

    const result = await cell.refresh();
    // A rebuild that failed answers non-2xx, unlike the admin route's 200 `{ ok: false }`:
    // the caller here is a workflow, and a red publish run is the only place a person will
    // see that what was just published is not what the server is serving.
    if (!result.ok) reply.code(502);
    return result;
  });
}
