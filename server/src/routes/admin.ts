/**
 * The machine/operator surface for issue #27: manage content sources, pull content on
 * demand, and see what the server is currently serving -- backing `AdminPanel.tsx`'s
 * sources table, Sync buttons, and paste-JSON block.
 *
 * Guarded by `players.role = 'admin'` (`roles.ts`, migration 012) -- queryable, assignable
 * data rather than the `ADMIN_SUBJECTS` env allowlist this used to check. The first grant
 * comes from `grant-role-cli.ts`, run once per deployment; every admin after that is granted
 * from this page (see the role routes below).
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
  approveSubmission,
  getContentSource,
  listContentSources,
  listPendingSubmissions,
  rejectSubmission,
  removeContentSource,
  type ContentSourceRow,
} from "../content-sources.js";
import { requirePrincipal, resolvePrincipal } from "../principal.js";
import { findPlayerByIdentity, isAdmin, setRole } from "../roles.js";

/** A write -- refreshing content is a real action, so this mints a guest the same as any
 *  other authenticated write route would (session.ts's `auth`), then checks the role. */
function requireAdmin(pool: Pool) {
  const auth = requirePrincipal(pool);
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await auth(request, reply);
    if (reply.sent) return;
    if (!(await isAdmin(pool, request.principal.playerId))) {
      reply.code(403);
      await reply.send({ error: { operation: "admin", code: "forbidden" } });
    }
  };
}

/** Read-only admin guard: unlike `requireAdmin`, this never mints a guest account merely
 *  because somebody guessed an admin URL. */
function resolveAdmin(pool: Pool) {
  const resolve = resolvePrincipal(pool);
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await resolve(request);
    const principal = request.principalOrNull;
    if (!principal || !(await isAdmin(pool, principal.playerId))) {
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
): void {
  const admin = requireAdmin(pool);
  const readAdmin = resolveAdmin(pool);

  // This response contains source URLs and refresh errors as well as the catalog, so the
  // read itself is guarded rather than relying on the browser to hide the page.
  app.get("/api/admin/content/status", { preHandler: readAdmin }, async () => {
    const demo = cell.current();
    return {
      isAdmin: true,
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
  });

  app.post("/api/admin/content/refresh", { preHandler: admin }, async () =>
    cell.refresh(),
  );

  // Adding a source immediately refreshes -- "paste and submit" is meant to be one action,
  // not a paste followed by a separate trip to the Sync button.
  //
  // `source` in the response is deliberately re-read *after* that refresh rather than being
  // the insert's own `returning` row: `createMultiSourceCampaignSource.load()` persists
  // every source's outcome before throwing, so the re-read carries this source's own
  // `lastError` (or its campaign/extension counts). That is the whole difference between
  // "what you just pasted is broken" and "what you just pasted is fine, some *other*
  // source is broken" -- a refresh is fail-closed across all sources, so `refresh.ok` alone
  // cannot tell an operator which of those two just happened.
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
        const created = await addUrlSource(pool, body.label, body.url);
        const refresh = await cell.refresh();
        reply.code(201);
        return {
          source: (await getContentSource(pool, created.id)) ?? created,
          refresh,
        };
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
        const created = await addPastedSource(pool, label, body.payload);
        const refresh = await cell.refresh();
        reply.code(201);
        return {
          source: (await getContentSource(pool, created.id)) ?? created,
          refresh,
        };
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

  // The moderation queue -- every player-submitted row awaiting a decision. Approving or
  // rejecting refreshes afterward for the same reason adding a source does (this file's
  // header on `POST /api/admin/content/sources`): the row's `status`/`visibility` change is
  // only what `composition.ts` reads into `ServerDemo.provenance` on the *next* build, so a
  // decision has no visible effect until one runs.
  app.get(
    "/api/admin/content/submissions",
    { preHandler: readAdmin },
    async () => ({ submissions: await listPendingSubmissions(pool) }),
  );

  app.post(
    "/api/admin/content/submissions/:id/approve",
    { preHandler: admin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { note?: string } | undefined;
      const ok = await approveSubmission(
        pool,
        id,
        request.principal.playerId,
        body?.note,
      );
      if (!ok) {
        reply.code(404);
        return { error: { operation: "admin", code: "not_found" } };
      }
      const refresh = await cell.refresh();
      return { source: await getContentSource(pool, id), refresh };
    },
  );

  // Also how an admin revokes a previously-approved row -- `rejectSubmission` sets both
  // `status` and `visibility` regardless of which state the row was already in.
  app.post(
    "/api/admin/content/submissions/:id/reject",
    { preHandler: admin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { note?: string } | undefined;
      const ok = await rejectSubmission(
        pool,
        id,
        request.principal.playerId,
        body?.note,
      );
      if (!ok) {
        reply.code(404);
        return { error: { operation: "admin", code: "not_found" } };
      }
      const refresh = await cell.refresh();
      return { source: await getContentSource(pool, id), refresh };
    },
  );

  // Grants or revokes the admin role by `(provider, subject)` -- the same identity shape
  // `ADMIN_SUBJECTS` used to be configured with, now a runtime action instead of a redeploy.
  // Resolving through `identities` (rather than taking a raw `playerId`) means an operator
  // never has to go find one -- they already know the identity they want to promote.
  app.post(
    "/api/admin/players/role",
    { preHandler: admin },
    async (request, reply) => {
      const body = request.body as {
        provider?: string;
        subject?: string;
        role?: string;
      };
      if (!body.provider || !body.subject || !body.role) {
        reply.code(400);
        return {
          error: { operation: "admin", code: "missing_provider_subject_role" },
        };
      }
      if (body.role !== "player" && body.role !== "admin") {
        reply.code(400);
        return { error: { operation: "admin", code: "invalid_role" } };
      }
      const target = await findPlayerByIdentity(
        pool,
        body.provider,
        body.subject,
      );
      if (!target) {
        reply.code(404);
        return { error: { operation: "admin", code: "identity_not_found" } };
      }
      await setRole(pool, target, body.role);
      return { ok: true, playerId: target, role: body.role };
    },
  );
}
