/**
 * Everything `discussion_posts` (migration 014) is queried for: who actually wrote a
 * thread this server posted with its one project-owned credential, and how many a given
 * player has posted in the last day. Kept out of `routes/discussions.ts`, the same split
 * `content-sources.ts`/`roles.ts` draw between SQL and route handling.
 */
import type { Pool } from "pg";

const DAILY_POST_LIMIT = 5;

export interface AttributedAuthor {
  readonly playerId: string;
  readonly displayName: string | null;
}

/** One batched lookup over a page's worth of ids -- never N+1, so listing a page of
 *  threads costs one extra query regardless of how many of them a local player wrote. */
export async function attributionsFor(
  pool: Pool,
  discussionRefs: readonly string[],
): Promise<ReadonlyMap<string, AttributedAuthor>> {
  if (discussionRefs.length === 0) return new Map();
  const { rows } = await pool.query(
    `select d.discussion_ref, d.player_id, p.display_name
       from discussion_posts d
       join players p on p.player_id = d.player_id
      where d.discussion_ref = any($1)`,
    [discussionRefs],
  );
  return new Map(
    rows.map((row) => [
      row.discussion_ref as string,
      {
        playerId: row.player_id as string,
        displayName: row.display_name as string | null,
      },
    ]),
  );
}

/** The entire per-player rate limit: `discussion_posts` is both the attribution record and
 *  the count of posts that exist, so there is no second table to keep in sync. Only
 *  successful posts consume quota -- the row is written after the upstream create returns
 *  (`recordPost` below) -- so a member whose creates keep failing is not slowed by this at
 *  all; that cost is bounded by `discussions/cache.ts`'s failure cooldown instead. */
export async function postsToday(
  pool: Pool,
  playerId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n
       from discussion_posts
      where player_id = $1 and created_at > now() - interval '1 day'`,
    [playerId],
  );
  return rows[0].n as number;
}

export async function underDailyLimit(
  pool: Pool,
  playerId: string,
): Promise<boolean> {
  return (await postsToday(pool, playerId)) < DAILY_POST_LIMIT;
}

export async function recordPost(
  pool: Pool,
  discussionRef: string,
  playerId: string,
  title: string,
): Promise<void> {
  await pool.query(
    `insert into discussion_posts (discussion_ref, player_id, title) values ($1, $2, $3)`,
    [discussionRef, playerId, title],
  );
}

const postLocks = new Map<string, Promise<void>>();

/**
 * Serializes one player's post attempts so the daily-cap check-then-act sequence in
 * `routes/discussions.ts` (count, then a network round trip to create the thread, then the
 * insert that records it) cannot let two concurrent requests from the same player both pass
 * the check before either is recorded. Process-local, the same posture `discussions/cache.ts`
 * argues for its own TTL cache: this deployment runs exactly one API container
 * (docker-compose.yml), so there is no second replica for a lock like this to miss, and a DB
 * advisory lock would otherwise have to hold a pooled connection open across the network call
 * to the forum -- a worse tradeoff for a soft anti-spam cap than a plain in-process mutex.
 */
export function withPlayerPostLock<T>(
  playerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = postLocks.get(playerId) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const marker = result.then(
    () => undefined,
    () => undefined,
  );
  postLocks.set(playerId, marker);
  void marker.finally(() => {
    if (postLocks.get(playerId) === marker) postLocks.delete(playerId);
  });
  return result;
}
