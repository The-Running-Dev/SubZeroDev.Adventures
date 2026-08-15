/**
 * A first-party forum over this repository's GitHub Discussions -- read-only list/thread
 * views for anyone, and posting for a signed-in member, with every thread created under
 * one project-owned credential (`discussions/registry.ts`) and attributed back to the
 * caller's own SubZeroDev session (`discussions/attribution.ts`). Names no vendor: this
 * file only ever sees the `DiscussionForum` seam (`discussions/forum.ts`), exactly as
 * every other route only ever sees `Principal`, never a provider name
 * (CLAUDE.md's identity-seam properties).
 *
 * Posting is immediate and public the instant it is written -- unlike
 * `routes/content.ts`'s "the owner cannot set visibility: public directly", moderation
 * here is retrospective and belongs to the repository's maintainers on GitHub, not to an
 * approval queue this server would have to grow. See the `CLAUDE.md` decision-log entry
 * for the full reasoning.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { resolvePrincipal } from "../principal.js";
import { maskDisplayName } from "../display-name.js";
import {
  type AttributedAuthor,
  attributionsFor,
  recordPost,
  underDailyLimit,
} from "../discussions/attribution.js";
import type {
  DiscussionComment,
  DiscussionForum,
  DiscussionThread,
} from "../discussions/forum.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9=_-]{1,256}$/;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 4000;
// Every C0 control character except the two a plain-text composer legitimately produces.
// eslint-disable-next-line no-control-regex -- deliberate: that is the whole point of this pattern.
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Builds on `resolvePrincipal`, never `requirePrincipal`. `requirePrincipal` mints a
 *  guest for any cookieless request (`principal.ts:109-126`) -- and a freshly minted guest
 *  can never satisfy a member check, so gating a POST on it would leave behind a `players`
 *  row that exists only because somebody was refused. `resolveAdmin` (`routes/admin.ts`)
 *  exists for the identical reason on the read side; this is the write-side version of the
 *  same problem, because the gate here is a linked identity rather than a role a
 *  signed-in operator already holds.
 *
 *  403, not 401: this API issues no `WWW-Authenticate` challenge, and the only other
 *  `kind === "member"` check in the codebase -- `routes/transfer.ts`'s inverted
 *  `already_linked_account` -- answers 403 too. */
function requireMember(pool: Pool) {
  const resolve = resolvePrincipal(pool);
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await resolve(request);
    const principal = request.principalOrNull;
    if (!principal || principal.kind !== "member") {
      reply.code(403);
      await reply.send({
        error: { operation: "discussions", code: "members_only" },
      });
      return;
    }
    request.principal = principal;
  };
}

function parseLimit(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return "invalid";
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 50 ? n : "invalid";
}

function normalizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= MAX_TITLE_LENGTH ? trimmed : undefined;
}

function normalizeBody(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length > MAX_BODY_LENGTH) return undefined;
  if (DISALLOWED_CONTROL_CHARS.test(normalized)) return undefined;
  return normalized;
}

/** Local attribution wins over the forum's own author field, which is always the one
 *  project-owned bot account -- see this file's header. `maskDisplayName` does double duty
 *  here: for a local player it masks an email-shaped `display_name`; for a bare upstream
 *  login or a deleted account (`null`) it is a no-op or "Anonymous Operator", which is
 *  exactly the fallback already wanted for those cases. */
function attributedName(
  authorLogin: string | null,
  attribution: AttributedAuthor | undefined,
): { readonly authorName: string; readonly authorKind: "player" | "forum" } {
  if (attribution) {
    return {
      authorName: maskDisplayName(attribution.displayName),
      authorKind: "player",
    };
  }
  return { authorName: maskDisplayName(authorLogin), authorKind: "forum" };
}

function threadEntry(
  thread: DiscussionThread,
  attributions: ReadonlyMap<string, AttributedAuthor>,
) {
  const { authorName, authorKind } = attributedName(
    thread.authorLogin,
    attributions.get(thread.id),
  );
  return {
    id: thread.id,
    title: thread.title,
    excerpt: thread.excerpt,
    authorName,
    authorKind,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    commentCount: thread.commentCount,
    url: thread.url,
  };
}

function commentEntry(comment: DiscussionComment) {
  return {
    id: comment.id,
    body: comment.body,
    authorName: maskDisplayName(comment.authorLogin),
    createdAt: comment.createdAt,
    url: comment.url,
  };
}

export function registerDiscussionRoutes(
  app: FastifyInstance,
  pool: Pool,
  forum: DiscussionForum | undefined,
): void {
  const resolve = resolvePrincipal(pool);
  const requireMemberGuard = requireMember(pool);

  // Registered whether or not a forum is configured -- an unregistered route answers 404,
  // indistinguishable from a typo'd path, and the frontend needs to tell "not set up yet"
  // from "broken" (the same reasoning behind identity's `oauth_not_configured`).
  app.get(
    "/api/discussions",
    { preHandler: resolve },
    async (request, reply) => {
      if (!forum) {
        reply.code(503);
        return { error: { operation: "discussions", code: "not_configured" } };
      }

      const query = request.query as { limit?: string; cursor?: string };
      const limit = parseLimit(query.limit);
      if (limit === "invalid") {
        reply.code(400);
        return { error: { operation: "discussions", code: "invalid_limit" } };
      }
      if (query.cursor !== undefined && !CURSOR_PATTERN.test(query.cursor)) {
        reply.code(400);
        return { error: { operation: "discussions", code: "invalid_cursor" } };
      }

      let page;
      try {
        page = await forum.listThreads({ limit, cursor: query.cursor });
      } catch (error) {
        request.log.error(error);
        reply.code(503);
        return {
          error: { operation: "discussions", code: "forum_unavailable" },
        };
      }

      const attributions = await attributionsFor(
        pool,
        page.threads.map((thread) => thread.id),
      );

      return {
        configured: true,
        forum: forum.name,
        canPost: request.principalOrNull?.kind === "member",
        threads: page.threads.map((thread) =>
          threadEntry(thread, attributions),
        ),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  );

  app.get(
    "/api/discussions/:id",
    { preHandler: resolve },
    async (request, reply) => {
      if (!forum) {
        reply.code(503);
        return { error: { operation: "discussions", code: "not_configured" } };
      }

      const { id } = request.params as { id: string };
      // Checked before the forum is touched: an unbounded path segment must never become
      // an upstream request.
      if (!ID_PATTERN.test(id)) {
        reply.code(400);
        return {
          error: { operation: "discussions", code: "invalid_thread_id" },
        };
      }

      let detail;
      try {
        detail = await forum.getThread(id);
      } catch (error) {
        request.log.error(error);
        reply.code(503);
        return {
          error: { operation: "discussions", code: "forum_unavailable" },
        };
      }
      if (!detail) {
        reply.code(404);
        return { error: { operation: "discussions", code: "not_found" } };
      }

      const attributions = await attributionsFor(pool, [detail.thread.id]);

      return {
        configured: true,
        forum: forum.name,
        canPost: request.principalOrNull?.kind === "member",
        thread: threadEntry(detail.thread, attributions),
        body: detail.body,
        comments: detail.comments.map(commentEntry),
        moreComments: detail.moreComments,
      };
    },
  );

  app.post(
    "/api/discussions",
    { preHandler: requireMemberGuard },
    async (request, reply) => {
      if (!forum) {
        reply.code(503);
        return { error: { operation: "discussions", code: "not_configured" } };
      }

      const body = request.body as { title?: unknown; body?: unknown };
      const title = normalizeTitle(body.title);
      if (title === undefined) {
        reply.code(400);
        return { error: { operation: "discussions", code: "invalid_title" } };
      }
      const text = normalizeBody(body.body);
      if (text === undefined) {
        reply.code(400);
        return { error: { operation: "discussions", code: "invalid_body" } };
      }

      // Checked before the forum is touched -- a player over quota never spends any of
      // the project token's budget. Only *successful* posts consume quota (the row below
      // is written after the create returns), so a member whose creates keep failing is
      // not slowed by this at all; that cost is bounded by `discussions/cache.ts`'s
      // failure cooldown instead.
      if (!(await underDailyLimit(pool, request.principal.playerId))) {
        reply.code(429);
        return { error: { operation: "discussions", code: "rate_limited" } };
      }

      let thread;
      try {
        thread = await forum.createThread({
          title,
          body: text,
          authorLabel: maskDisplayName(request.principal.displayName),
        });
      } catch (error) {
        // Every failure reason -- including the forum's own `rate_limited` -- answers the
        // same 503 here. A `rate_limited` from the forum is the *project token's* shared
        // budget, not this player's quota; returning 429 for it would tell a player to
        // slow down when they did nothing wrong. The upstream message is logged, never
        // returned.
        request.log.error(error);
        reply.code(503);
        return {
          error: { operation: "discussions", code: "forum_unavailable" },
        };
      }

      try {
        await recordPost(
          pool,
          thread.id,
          request.principal.playerId,
          thread.title,
        );
      } catch (error) {
        // The thread already exists publicly at this point. A 500 here would invite a
        // retry, and `createDiscussion` has no idempotency key, so the retry would
        // duplicate a public post -- losing this local attribution row is the cheaper
        // failure, and retrospective moderation on GitHub is the backstop either way.
        request.log.error(error);
      }

      reply.code(201);
      return {
        thread: {
          id: thread.id,
          title: thread.title,
          excerpt: thread.excerpt,
          authorName: maskDisplayName(request.principal.displayName),
          authorKind: "player" as const,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          commentCount: thread.commentCount,
          url: thread.url,
        },
        canPost: true,
      };
    },
  );
}
