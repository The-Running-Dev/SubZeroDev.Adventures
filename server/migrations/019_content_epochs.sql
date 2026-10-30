-- Durable content epochs (engine plan 54, §3.1): one key `(campaign_id, campaign_version)`
-- names one content forever, and what is current is a pointer, never inferred from row order.
-- Before this, a content refresh rebuilt the engine and the session store around a new
-- registry, and a session or save naming a version the new registry no longer held could not
-- be resumed or loaded at all.
--
-- `content_epochs.epoch` is the engine's `EpochForm` exactly as hashed (`epochDigest`): the
-- composed campaign without `migrateState`, its attachments, and its authored strings. No core
-- or kind message is stored; the running engine supplies those at hydration. Insert only.
-- `migration` is the portable campaign's migration spec, kept beside the form because the
-- engine form carries no `migrateState` and Adventures derives one from data, not code. It is
-- not digest input. Nor is `extensions`, the applied extensions' `{id, extends}` in application
-- order, which the admin page lists; `extensions_digest` (D2) is their full digest.
create table content_epochs (
  campaign_id              text not null,
  campaign_version         text not null,
  digest                   text not null,
  epoch                    jsonb not null,
  migration                jsonb,
  reserved_keys            jsonb not null,
  first_publication_id     uuid not null,
  published_kind_id        text not null,
  published_kind_version   text not null,
  published_engine_version text not null,
  extensions_digest        text,
  extensions               jsonb not null default '[]',
  created_at               timestamptz not null default now(),
  primary key (campaign_id, campaign_version)
);

create table content_publications (
  publication_id        uuid primary key,
  seq                   bigint generated always as identity unique,
  parent_publication_id uuid references content_publications(publication_id),
  reason                text not null check (reason in ('refresh', 'rollback', 'withdrawal', 'deletion')),
  created_at            timestamptz not null default now(),
  created_by            text not null
);

alter table content_epochs
  add constraint content_epochs_first_publication
  foreign key (first_publication_id) references content_publications(publication_id)
  deferrable initially deferred;

-- One row per campaign a publication offers. A campaign absent from a publication is
-- withdrawn from it. `position` is catalog order (manifest order: core, then submissions);
-- `catalog` is the catalog projection the HTTP surface serves; `provenance` is the access
-- snapshot (null for core).
create table content_publication_entries (
  publication_id   uuid not null references content_publications(publication_id),
  campaign_id      text not null,
  campaign_version text not null,
  position         integer not null,
  catalog          jsonb not null,
  provenance       jsonb,
  primary key (publication_id, campaign_id),
  unique (publication_id, position),
  foreign key (campaign_id, campaign_version)
    references content_epochs(campaign_id, campaign_version) on delete restrict
);

-- The only thing that says what is current. Exactly one row, ever.
create table content_current (
  singleton            boolean primary key default true check (singleton),
  publication_id       uuid references content_publications(publication_id),
  state_seq            bigint not null default 0,
  applied_external_seq bigint not null default 0
);
insert into content_current (singleton, publication_id) values (true, null);

-- Which epoch a session or save is on, read off its own envelope, so a miss is classified
-- without parsing a failure. Generated, so no writer can disagree with the blob it wrote;
-- nullable, because a row whose blob is not an envelope (test fixtures) names no version.
alter table sessions add column campaign_version text
  generated always as (blob::jsonb ->> 'campaignVersion') stored;
alter table saves add column campaign_version text
  generated always as (blob::jsonb ->> 'campaignVersion') stored;
