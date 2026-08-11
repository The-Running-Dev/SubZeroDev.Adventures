/**
 * The machine/operator surface for issue #27: manage content sources, pull content on
 * demand, and see what the server is currently serving -- backing `AdminPanel.tsx`'s
 * sources table, Sync buttons, and paste-JSON block.
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
import type { CampaignSource } from "../campaigns/source.js";
import {
  classifyPastedPayload,
  isMultiCampaignSource,
} from "../campaigns/multi-source.js";
import {
  addPastedSource,
  addUrlSource,
  listContentSources,
  removeContentSource,
  type ContentSourceRow,
} from "../content-sources.js";
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

interface SourceStatusEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: "url" | "pasted";
  readonly url?: string;
  readonly builtin: boolean;
  readonly removable: boolean;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

function fromDbRow(row: ContentSourceRow): SourceStatusEntry {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    builtin: false,
    removable: true,
    ...(row.url !== undefined ? { url: row.url } : {}),
    ...(row.lastSyncedAt !== undefined
      ? { lastSyncedAt: row.lastSyncedAt }
      : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.campaignCount !== undefined
      ? { campaignCount: row.campaignCount }
      : {}),
    ...(row.extensionCount !== undefined
      ? { extensionCount: row.extensionCount }
      : {}),
  };
}

async function listSourceStatuses(
  pool: Pool,
  campaignSource: CampaignSource,
): Promise<readonly SourceStatusEntry[]> {
  const dbRows = await listContentSources(pool);
  const dbEntries = dbRows.map(fromDbRow);
  // Disk-mode tests (`buildApp` without an explicit `campaignSource`) never build a real
  // multi-source, so there is no builtin row to show -- the sources table is then just
  // whatever's in the DB, which is also legitimately what a real deployment shows *before*
  // its first refresh sets `builtinStatus()`'s url.
  if (!isMultiCampaignSource(campaignSource)) return dbEntries;
  const builtin = campaignSource.builtinStatus();
  return [
    {
      id: builtin.id,
      label: builtin.label,
      kind: "url",
      builtin: true,
      removable: false,
      ...(builtin.url !== undefined ? { url: builtin.url } : {}),
      ...(builtin.lastSyncedAt !== undefined
        ? { lastSyncedAt: builtin.lastSyncedAt }
        : {}),
      ...(builtin.lastError !== undefined
        ? { lastError: builtin.lastError }
        : {}),
      ...(builtin.campaignCount !== undefined
        ? { campaignCount: builtin.campaignCount }
        : {}),
      ...(builtin.extensionCount !== undefined
        ? { extensionCount: builtin.extensionCount }
        : {}),
    },
    ...dbEntries,
  ];
}

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
  campaignSource: CampaignSource,
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
        sources: await listSourceStatuses(pool, campaignSource),
      };
    },
  );

  app.post("/api/admin/content/refresh", { preHandler: admin }, async () =>
    cell.refresh(),
  );

  // Adding a source immediately refreshes -- "paste and submit" is meant to be one action,
  // not a paste followed by a separate trip to the Sync button. The created row's own
  // status (lastSyncedAt/lastError) already reflects that refresh's outcome by the time
  // this responds, since `createMultiSourceCampaignSource.load()` persists it before
  // throwing on failure.
  app.post(
    "/api/admin/content/sources",
    { preHandler: admin },
    async (request, reply) => {
      const body = request.body as {
        kind?: string;
        label?: string;
        url?: string;
        payload?: unknown;
      };

      if (body.kind === "url") {
        if (!body.label || !body.url) {
          reply.code(400);
          return {
            error: { operation: "admin", code: "missing_label_or_url" },
          };
        }
        try {
          new URL(body.url);
        } catch {
          reply.code(400);
          return { error: { operation: "admin", code: "invalid_url" } };
        }
        const source = await addUrlSource(pool, body.label, body.url);
        const refresh = await cell.refresh();
        reply.code(201);
        return { source, refresh };
      }

      if (body.kind === "pasted") {
        const kind = classifyPastedPayload(body.payload);
        if (!kind) {
          reply.code(400);
          return {
            error: { operation: "admin", code: "unrecognized_payload_shape" },
          };
        }
        const payload = body.payload as {
          id?: string;
          campaign?: { id?: string };
        };
        const label =
          body.label ||
          (kind === "campaign" ? payload.campaign?.id : payload.id) ||
          "pasted content";
        const source = await addPastedSource(pool, label, body.payload);
        const refresh = await cell.refresh();
        reply.code(201);
        return { source, refresh };
      }

      reply.code(400);
      return { error: { operation: "admin", code: "unknown_source_kind" } };
    },
  );

  app.delete(
    "/api/admin/content/sources/:id",
    { preHandler: admin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (
        isMultiCampaignSource(campaignSource) &&
        id === campaignSource.builtinStatus().id
      ) {
        reply.code(400);
        return {
          error: { operation: "admin", code: "cannot_remove_builtin" },
        };
      }
      const removed = await removeContentSource(pool, id);
      if (!removed) {
        reply.code(404);
        return { error: { operation: "admin", code: "not_found" } };
      }
      return { ok: true };
    },
  );
}
