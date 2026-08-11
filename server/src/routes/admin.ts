/**
 * The machine/operator surface for issue #27: pull content on demand and see what the
 * server is currently serving, backing `AdminPanel.tsx`'s "Sync" button.
 *
 * Guarded by a signed-in principal whose linked `(provider, subject)` (the `identities`
 * table, migration 007) appears in the `ADMIN_SUBJECTS` allowlist (`AppConfig`). Nothing
 * durable is stored -- no role column, no migration -- and no provider name is typed into
 * this file: the allowlist is opaque configuration, checked against rows this file reads
 * generically. Keeps the identity seam CLAUDE.md documents intact.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { ContentCell } from "../content-cell.js";
import { requirePrincipal, resolvePrincipal } from "../principal.js";

async function isAdmin(
  pool: Pool,
  playerId: string,
  adminSubjects: ReadonlySet<string>,
): Promise<boolean> {
  if (adminSubjects.size === 0) return false;
  const { rows } = await pool.query<{ provider: string; subject: string }>(
    `select provider, subject from identities where player_id = $1`,
    [playerId],
  );
  return rows.some((row) =>
    adminSubjects.has(`${row.provider}:${row.subject}`),
  );
}

/** A write -- refreshing content is a real action, so this mints a guest the same as any
 *  other authenticated write route would (session.ts's `auth`), then checks the allowlist. */
function requireAdmin(pool: Pool, adminSubjects: ReadonlySet<string>) {
  const auth = requirePrincipal(pool);
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await auth(request, reply);
    if (reply.sent) return;
    if (!(await isAdmin(pool, request.principal.playerId, adminSubjects))) {
      reply.code(403);
      await reply.send({ error: { operation: "admin", code: "forbidden" } });
    }
  };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
  adminSubjects: readonly string[],
): void {
  const allowlist = new Set(adminSubjects);
  const admin = requireAdmin(pool, allowlist);
  // Read-only, so this resolves an existing session but never mints a guest row --
  // `resolvePrincipal`'s posture on every other read-only route (progress.ts, badges.ts).
  // A logged-out visitor just gets `isAdmin: false`.
  const resolve = resolvePrincipal(pool);

  // Answers "am I allowed" alongside the catalog/refresh status, so `AdminPanel.tsx` can
  // disable Sync with a reason instead of letting a click 403.
  app.get(
    "/api/admin/content/status",
    { preHandler: resolve },
    async (request) => {
      const principal = request.principalOrNull;
      const allowed = principal
        ? await isAdmin(pool, principal.playerId, allowlist)
        : false;
      const demo = cell.current();
      return {
        isAdmin: allowed,
        status: cell.status(),
        campaigns: demo.all.map((campaign) => ({
          campaignId: campaign.campaignId,
          title: campaign.title,
          kindId: campaign.kindId,
          version: campaign.version,
          endingCount: campaign.endingCount,
        })),
        extensions: demo.appliedExtensions,
      };
    },
  );

  app.post("/api/admin/content/refresh", { preHandler: admin }, async () =>
    cell.refresh(),
  );
}
