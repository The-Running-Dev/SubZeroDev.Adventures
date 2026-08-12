-- Turns `content_sources` (migration 011) from an admin-only table into one that also holds
-- player-submitted content awaiting moderation. `owner_player_id null` keeps meaning exactly
-- what it already means today -- an admin-curated row, live the moment it validates; every
-- column below defaults so the migration alone reproduces today's behavior for every existing
-- row, with no backfill script beyond the one UPDATE here.
alter table content_sources
  add column owner_player_id uuid references players(player_id) on delete cascade,
  add column status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  add column visibility text not null default 'private' check (visibility in ('private', 'public')),
  add column review_note text,
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references players(player_id),
  -- Distinct from `last_error`, deliberately: `last_error` means "this row's own fetch/shape
  -- failed and contributed nothing" (multi-source.ts's fail-closed trusted tier, unchanged by
  -- this migration). A quarantined row *loaded and validated on its own* but was excluded from
  -- a combined build it collided with -- conflating the two would make an admin's or author's
  -- "why isn't this showing" table lie about which case they're looking at.
  add column quarantine_reason text,
  add column quarantined_at timestamptz;

update content_sources
   set status = 'approved', visibility = 'public'
 where owner_player_id is null;

-- An ownerless row is an admin row, by construction -- it can never sit in the moderation
-- queue or be private, so a row with no owner but `status != 'approved'` (or `visibility !=
-- 'public'`) is a state this schema does not allow rather than one the application has to
-- remember to prevent.
alter table content_sources
  add constraint content_sources_owner_shape check (
    owner_player_id is not null or (status = 'approved' and visibility = 'public')
  );

create index content_sources_by_owner on content_sources (owner_player_id);
