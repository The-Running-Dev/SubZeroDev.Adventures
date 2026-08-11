-- Content sources an operator has added through the admin page (issue #27) -- a URL to
-- fetch a manifest+campaigns from, or a JSON campaign/extension pasted directly in. The
-- one hardcoded, unremovable default source lives in code (server/src/index.ts), not here:
-- it needs no row to always be present, and this table only ever holds what an admin chose
-- to add. `source_id` is minted in application code (randomUUID(), same as
-- players.player_id in principal.ts), not a DB-side default.
--
-- The status columns are last-known-outcome, not history -- overwritten on every refresh
-- attempt (server/src/campaigns/multi-source.ts), so a row always reflects the most recent
-- Sync rather than accumulating a log.
create table content_sources (
  source_id       uuid primary key,
  kind            text not null check (kind in ('url', 'pasted')),
  label           text not null,
  url             text,
  payload         jsonb,
  last_synced_at  timestamptz,
  last_error      text,
  campaign_count  integer,
  extension_count integer,
  created_at      timestamptz not null default now(),
  constraint content_sources_kind_shape check (
    (kind = 'url' and url is not null and payload is null) or
    (kind = 'pasted' and payload is not null and url is null)
  )
);
