/**
 * The one interface a discussion forum implements. Nothing outside this directory knows
 * which forum is behind it -- `routes/discussions.ts` only ever sees `DiscussionForum`,
 * exactly as `principal.ts` only ever sees `IdentityProvider` (identity/provider.ts).
 *
 * Two properties this interface exists to hold, and which a second implementation must
 * also hold:
 *
 *  - **Text crossing this seam is plain text, never markup.** `excerpt`/`body` are
 *    rendered-to-text, not markdown and not HTML. The frontend has no markdown renderer
 *    and no `dangerouslySetInnerHTML` anywhere, so an adapter that started returning
 *    markup would turn every consumer into an injection surface without changing one
 *    line of the consumer. See `github.ts` on `bodyText`.
 *  - **`id` is opaque.** It is the forum's own stable handle for a thread, as a string.
 *    Nothing outside this directory parses it, and `discussion_posts.discussion_ref`
 *    (migration 014) stores it verbatim.
 */
export interface DiscussionThread {
  /** Opaque, vendor-assigned, stable. Safe in a URL path: adapters must only ever
   *  produce `[A-Za-z0-9_-]{1,64}`, which `routes/discussions.ts` validates before
   *  passing one back. */
  readonly id: string;
  readonly title: string;
  /** Plain-text opening of the thread, truncated by the adapter (<= 280 chars, cut at a
   *  whitespace boundary). The list view never needs the whole post. */
  readonly excerpt: string;
  /** The forum account that wrote it, as the forum names it -- `null` for a deleted or
   *  otherwise unnamed account. Everything this server posts carries the project's own
   *  token, so this is the *bot* account for those; `routes/discussions.ts` overrides it
   *  from `discussion_posts` where a local player is on record. */
  readonly authorLogin: string | null;
  readonly createdAt: string; // ISO-8601
  readonly updatedAt: string; // ISO-8601
  readonly commentCount: number;
  /** Canonical link to the thread on the forum itself. */
  readonly url: string;
}

export interface DiscussionComment {
  readonly id: string;
  readonly body: string; // plain text
  readonly authorLogin: string | null;
  readonly createdAt: string;
  readonly url: string;
}

export interface DiscussionThreadPage {
  readonly threads: readonly DiscussionThread[];
  /** Opaque. Absent means this is the last page. */
  readonly nextCursor?: string;
}

export interface DiscussionThreadDetail {
  readonly thread: DiscussionThread;
  /** Full plain-text body -- `thread.excerpt` is the truncation of this. */
  readonly body: string;
  /** Top-level comments only, one page deep. Replies-to-replies are not part of the read
   *  scope; `thread.url` is where a reader goes for the rest. */
  readonly comments: readonly DiscussionComment[];
  readonly moreComments: boolean;
}

export interface CreateThreadInput {
  readonly title: string;
  readonly body: string;
  /** Who to attribute the thread to *on the forum*. Already masked and display-safe
   *  (`display-name.ts`'s `maskDisplayName`) -- an adapter renders it however its forum
   *  renders a byline and never re-checks it. Needed because every thread is posted by
   *  one project-owned account, so the forum's own author field cannot carry this. */
  readonly authorLabel: string;
}

export type DiscussionForumFailure =
  /** The forum answered, and said no such thing exists. */
  | "not_found"
  /** The configured credential is missing, expired, or lacks the permission. An operator
   *  problem: never surfaced to a player as their fault. */
  | "unauthorized"
  /** The forum is refusing us for volume reasons -- its budget, not this player's quota. */
  | "rate_limited"
  /** Anything else: transport failure, timeout, 5xx, a shape we do not understand. */
  | "unavailable";

export class DiscussionForumError extends Error {
  readonly reason: DiscussionForumFailure;

  constructor(
    reason: DiscussionForumFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DiscussionForumError";
    this.reason = reason;
  }
}

export interface DiscussionForum {
  /** For display only ("view this on <name>") -- the one string that identifies the
   *  vendor, carried as data so no route file has to spell it. Same role as
   *  `IdentityProvider.name`. */
  readonly name: string;
  listThreads(options?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<DiscussionThreadPage>;
  /** `undefined` for "no such thread, or not in the configured category" -- the same
   *  fold `content-sources.ts`'s owner-scoped reads use, so a caller cannot leak the
   *  difference by picking the wrong status code. Every other failure throws
   *  `DiscussionForumError`. */
  getThread(id: string): Promise<DiscussionThreadDetail | undefined>;
  createThread(input: CreateThreadInput): Promise<DiscussionThread>;
}
