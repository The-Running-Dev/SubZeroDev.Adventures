-- Attribution for threads this server posted to the operator's forum
-- (server/src/discussions/). Every thread is created with one project-owned credential, so
-- the forum records the same bot account as the author for all of them -- this table is the
-- only place that knows which player actually wrote one, and it is what
-- `routes/discussions.ts` reads to put a real name on the list.
--
-- It is also the entire per-player rate limit. A second table counting attempts would be a
-- second source of truth about the same event, and the quantity the limit is actually about
-- -- posts that exist on the forum -- is exactly the set of rows here.
--
-- `discussion_ref` is the forum's own stable handle for the thread, held as text because
-- nothing on this side parses it: `discussions/forum.ts` declares `DiscussionThread.id`
-- opaque so the seam does not assume the vendor's handles are numeric. Today's adapter
-- stores GitHub's discussion number in it.
--
-- `title` is a local copy, deliberately: it keeps the row self-describing after the thread
-- is edited or deleted upstream, which is precisely the case a moderator is looking at when
-- they come here.
create table discussion_posts (
  discussion_ref text primary key,
  player_id      uuid not null references players(player_id) on delete cascade,
  title          text not null,
  created_at     timestamptz not null default now()
);

-- Serves both reads: the rate-limit window
-- (`where player_id = $1 and created_at > now() - interval '1 day'`) and a player's own
-- post history. `created_at desc` puts the newest first so the window scan stops early.
create index discussion_posts_by_player on discussion_posts (player_id, created_at desc);
