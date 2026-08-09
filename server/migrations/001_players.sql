-- Players first: sessions and saves both carry an optional FK to this table, so it has to
-- exist before them. The plan's phase numbering (players in "phase 3") describes the
-- feature rollout, not migration order — the schema itself is applied here, up front.
create table players (
  player_id    uuid primary key,
  kind         text not null check (kind in ('guest', 'github')),
  github_id    text unique,
  display_name text,
  created_at   timestamptz not null default now()
);
