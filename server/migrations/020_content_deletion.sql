-- Permanent deletion of private content (engine plan 54, D3 §5-§6). One protocol removes a
-- submission and everything that names it: record (the irreversibility point), append to the
-- external ledger, purge. `server/src/content/deletion.ts` is the only writer of these tables
-- and the only `delete` of the content it purges.
--
-- `content_epoch_sources` joins an epoch to every submission source it was composed from (the
-- base campaign's and each applied extension's), written at publication. Trusted sources (the
-- builtin default and admin rows) are never deleted, so they are not recorded here.
create table content_epoch_sources (
  campaign_id      text not null,
  campaign_version text not null,
  source_id        uuid not null,
  primary key (campaign_id, campaign_version, source_id),
  foreign key (campaign_id, campaign_version)
    references content_epochs(campaign_id, campaign_version) on delete cascade
);
create index content_epoch_sources_by_source on content_epoch_sources (source_id);

-- The ledger (§5.4): contentless and permanent. `pending_keys` is the clear-text
-- `[campaignId, campaignVersion]` list the purge needs, nulled when the purge commits.
create table content_deletions (
  deletion_id     uuid primary key,
  seq             bigint generated always as identity unique,
  external_seq    bigint unique,
  source_id       uuid not null unique,
  state           text not null check (state in ('pending', 'purged')),
  deleted_at      timestamptz not null default now(),
  purged_at       timestamptz,
  actor_role      text not null check (actor_role in ('owner', 'admin')),
  actor_player_id uuid references players(player_id) on delete restrict,
  pending_keys    jsonb,
  constraint content_deletions_purged_shape check ((state = 'purged') = (purged_at is not null)),
  constraint content_deletions_keys_shape check (pending_keys is null or state = 'pending')
);

-- `sha256Hex(canonicalize([campaignId, campaignVersion]))` of each deleted epoch key. A key in
-- here is never published, admitted or written again, whatever the age.
create table content_deletion_keys (
  deletion_id    uuid not null references content_deletions(deletion_id),
  epoch_key_hash text not null unique,
  primary key (deletion_id, epoch_key_hash)
);

-- A campaign none of whose epochs is held any more, by `canonicalDigest(["campaign", id])`: its
-- achievements were deleted with its last epoch, and are not written again while it has none.
create table content_deleted_campaigns (
  campaign_hash text primary key,
  deletion_id   uuid not null references content_deletions(deletion_id)
);

-- A historical publication entry naming a purged epoch, without its catalog metadata.
create table content_publication_entry_markers (
  publication_id uuid not null references content_publications(publication_id),
  epoch_key_hash text not null,
  deletion_id    uuid not null references content_deletions(deletion_id),
  primary key (publication_id, epoch_key_hash)
);

-- Tombstones (§6): an id, who may be told it was deleted, and when. No campaign id, title,
-- version or content.
create table session_tombstones (
  session_id  uuid primary key,
  profile_id  uuid references players(player_id) on delete restrict,
  deletion_id uuid not null references content_deletions(deletion_id),
  deleted_at  timestamptz not null default now()
);
create table save_tombstones (
  save_id     uuid primary key,
  profile_id  uuid references players(player_id) on delete restrict,
  deletion_id uuid not null references content_deletions(deletion_id),
  deleted_at  timestamptz not null default now()
);
create table grant_tombstones (
  token_hash  text primary key,
  owner_id    uuid not null references players(player_id) on delete restrict,
  deletion_id uuid not null references content_deletions(deletion_id),
  deleted_at  timestamptz not null default now()
);
create table run_tombstones (
  owner_id     uuid not null references players(player_id) on delete restrict,
  local_run_id uuid not null,
  deletion_id  uuid not null references content_deletions(deletion_id),
  deleted_at   timestamptz not null default now(),
  primary key (owner_id, local_run_id)
);

-- Every epoch a holder depends on (§5.5): its envelope's version, and both ends of every
-- content entry after its last migration. Written from the blob in the holder's own write
-- transaction; `restrict` means no epoch is purged while anything still names it.
create table session_epochs (
  session_id       uuid not null references sessions(session_id) on delete cascade,
  campaign_id      text not null,
  campaign_version text not null,
  primary key (session_id, campaign_id, campaign_version),
  foreign key (campaign_id, campaign_version)
    references content_epochs(campaign_id, campaign_version) on delete restrict
);
create index session_epochs_by_epoch on session_epochs (campaign_id, campaign_version);
create table save_epochs (
  save_id          uuid not null references saves(save_id) on delete cascade,
  campaign_id      text not null,
  campaign_version text not null,
  primary key (save_id, campaign_id, campaign_version),
  foreign key (campaign_id, campaign_version)
    references content_epochs(campaign_id, campaign_version) on delete restrict
);
create index save_epochs_by_epoch on save_epochs (campaign_id, campaign_version);
create table grant_epochs (
  token            uuid not null references offline_grants(token) on delete cascade,
  campaign_id      text not null,
  campaign_version text not null,
  primary key (token, campaign_id, campaign_version),
  foreign key (campaign_id, campaign_version)
    references content_epochs(campaign_id, campaign_version) on delete restrict
);
create index grant_epochs_by_epoch on grant_epochs (campaign_id, campaign_version);
create table run_epochs (
  owner_id         uuid not null,
  local_run_id     uuid not null,
  campaign_id      text not null,
  campaign_version text not null,
  primary key (owner_id, local_run_id, campaign_id, campaign_version),
  foreign key (owner_id, local_run_id)
    references offline_runs(owner_id, local_run_id) on delete cascade,
  foreign key (campaign_id, campaign_version)
    references content_epochs(campaign_id, campaign_version) on delete restrict
);
create index run_epochs_by_epoch on run_epochs (campaign_id, campaign_version);

-- An owner can no longer be removed out from under their submissions: deleting a player with
-- content runs the protocol first (§5.6).
alter table content_sources drop constraint content_sources_owner_player_id_fkey;
alter table content_sources
  add constraint content_sources_owner_player_id_fkey
  foreign key (owner_player_id) references players(player_id) on delete restrict;
