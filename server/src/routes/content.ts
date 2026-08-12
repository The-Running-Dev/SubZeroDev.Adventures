/**
 * The author-facing surface for user-submitted content: submit, list your own, edit,
 * request publish, delete. Ported from `routes/admin.ts`'s paste/upload/URL flow
 * (CLAUDE.md's "Ingestion UI scope" decision) and scoped to one owner rather than being
 * admin-only -- same shape validation (`classifyPastedPayload`), same "add, then refresh,
 * then report this row's own outcome" pattern (`admin.ts`'s header comment on why the
 * re-read has to happen *after* the refresh), just against `content-sources.ts`'s
 * owner-scoped queries instead of the admin ones.
 *
 * Every route here answers another player's row with a 404, never a 403 -- `content-sources
 * .ts`'s owner-scoped reads already fold "doesn't exist" and "exists but isn't yours" into
 * the same `undefined`/`false`, so there is nothing left for this file to leak by choosing
 * the wrong status code.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ContentCell } from "../content-cell.js";
import { classifyPastedPayload } from "../campaigns/multi-source.js";
import {
  addSubmission,
  getOwnedSubmission,
  listSubmissionsByOwner,
  removeOwnedSubmission,
  requestPublish,
  updateOwnedSubmission,
} from "../content-sources.js";
import { requirePrincipal, resolvePrincipal } from "../principal.js";

interface SubmissionBody {
  readonly kind?: string;
  readonly label?: string;
  readonly url?: string;
  readonly payload?: unknown;
}

function parseSource(body: SubmissionBody):
  | {
      readonly ok: true;
      readonly source:
        { kind: "url"; url: string } | { kind: "pasted"; payload: unknown };
    }
  | { readonly ok: false; readonly code: string } {
  if (body.kind === "url") {
    if (!body.url) return { ok: false, code: "missing_url" };
    try {
      new URL(body.url);
    } catch {
      return { ok: false, code: "invalid_url" };
    }
    return { ok: true, source: { kind: "url", url: body.url } };
  }
  if (body.kind === "pasted") {
    if (!classifyPastedPayload(body.payload))
      return { ok: false, code: "unrecognized_payload_shape" };
    return { ok: true, source: { kind: "pasted", payload: body.payload } };
  }
  return { ok: false, code: "unknown_source_kind" };
}

function labelFor(body: SubmissionBody): string {
  if (body.label) return body.label;
  const kind = classifyPastedPayload(body.payload);
  const payload = body.payload as { id?: string; campaign?: { id?: string } };
  return (
    (kind === "campaign" ? payload.campaign?.id : payload.id) ||
    "submitted content"
  );
}

export function registerContentRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
): void {
  const auth = requirePrincipal(pool);
  const resolve = resolvePrincipal(pool);

  app.get("/api/content/mine", { preHandler: resolve }, async (request) => {
    const principal = request.principalOrNull;
    if (!principal) return { submissions: [] };
    return {
      submissions: await listSubmissionsByOwner(pool, principal.playerId),
    };
  });

  // One action, like the admin paste flow: submit, refresh, and report this row's own
  // outcome -- see this file's header for why the re-read has to happen after the refresh.
  app.post("/api/content", { preHandler: auth }, async (request, reply) => {
    const body = request.body as SubmissionBody;
    const parsed = parseSource(body);
    if (!parsed.ok) {
      reply.code(400);
      return { error: { operation: "content", code: parsed.code } };
    }
    const created = await addSubmission(
      pool,
      request.principal.playerId,
      labelFor(body),
      parsed.source,
    );
    const refresh = await cell.refresh();
    reply.code(201);
    return {
      source:
        (await getOwnedSubmission(
          pool,
          created.id,
          request.principal.playerId,
        )) ?? created,
      refresh,
    };
  });

  app.patch(
    "/api/content/:id",
    { preHandler: auth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as SubmissionBody;
      const hasSource = body.kind !== undefined;
      const parsed = hasSource ? parseSource(body) : undefined;
      if (parsed && !parsed.ok) {
        reply.code(400);
        return { error: { operation: "content", code: parsed.code } };
      }
      const updated = await updateOwnedSubmission(
        pool,
        id,
        request.principal.playerId,
        {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(parsed?.ok ? { source: parsed.source } : {}),
        },
      );
      if (!updated) {
        reply.code(404);
        return { error: { operation: "content", code: "not_found" } };
      }
      const refresh = await cell.refresh();
      return {
        source: await getOwnedSubmission(pool, id, request.principal.playerId),
        refresh,
      };
    },
  );

  // Requesting public visibility -- the owner cannot set `visibility: "public"` directly;
  // this only ever moves a row into the moderation queue (`content-sources.ts`'s
  // `requestPublish`). Going public happens exclusively through an admin's approval
  // (`routes/admin.ts`), never from this file.
  app.post(
    "/api/content/:id/publish",
    { preHandler: auth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await requestPublish(pool, id, request.principal.playerId);
      if (!ok) {
        reply.code(404);
        return { error: { operation: "content", code: "not_found" } };
      }
      return {
        source: await getOwnedSubmission(pool, id, request.principal.playerId),
      };
    },
  );

  app.delete(
    "/api/content/:id",
    { preHandler: auth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const removed = await removeOwnedSubmission(
        pool,
        id,
        request.principal.playerId,
      );
      if (!removed) {
        reply.code(404);
        return { error: { operation: "content", code: "not_found" } };
      }
      await cell.refresh();
      return { ok: true };
    },
  );
}
