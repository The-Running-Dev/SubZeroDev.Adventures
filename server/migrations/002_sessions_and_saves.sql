-- StoredSessionRecord / StoredSaveRecord, mapped 1:1 (engine/src/engine/src/core/session/types.ts).
--
-- created_at/updated_at on sessions are `text`, not `timestamptz`: the engine writes
-- ISO-8601 strings through its `Clock` and reads them back verbatim into
-- StoredSessionRecord -- a timestamptz round-trip through Postgres would reformat them,
-- and nothing in the engine ever parses these as a Postgres timestamp. saves.created_at is
-- a separate host-owned column used only for ordering, unrelated to the engine record.
create table sessions (
  session_id        uuid primary key,
  blob              text not null,
  audience          text not null,
  attempt_counter   integer not null,
  replay_compatible boolean not null,
  profile_id        uuid references players(player_id) on delete cascade,
  created_at        text not null,
  updated_at        text not null
);

create table saves (
  save_id       uuid primary key,
  campaign_id   text not null,
  blob          text not null,
  saved_at_seq  integer not null,
  audience      text not null,
  profile_id    uuid references players(player_id) on delete cascade,
  created_at    timestamptz not null default now()
);

create index saves_by_player_campaign on saves (profile_id, campaign_id, saved_at_seq desc);
