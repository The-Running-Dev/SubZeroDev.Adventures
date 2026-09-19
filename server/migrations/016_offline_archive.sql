-- Separate, noncompetitive validated histories. Existing aggregates cannot count them.
create table offline_grants (
 token uuid primary key, owner_id uuid references players(player_id) on delete cascade,
 bundle jsonb not null, checkpoint jsonb, source_revision uuid,
 created_at timestamptz not null default now()
);
create table offline_runs (
 owner_id uuid not null references players(player_id) on delete cascade,
 local_run_id uuid not null, grant_token uuid not null references offline_grants(token),
 inputs jsonb not null, blob text not null, revision uuid not null,
 primary key(owner_id,local_run_id)
);
create table offline_receipts (
 owner_id uuid not null references players(player_id) on delete cascade,
 idempotency_key uuid not null, request_hash text not null, receipt jsonb not null,
 primary key(owner_id,idempotency_key)
);
-- A distinct server-owned lineage, rotated even for an ABA state change.
alter table sessions add column offline_revision uuid not null default gen_random_uuid();
create function rotate_offline_revision() returns trigger language plpgsql as $$
begin new.offline_revision := gen_random_uuid(); return new; end $$;
create trigger sessions_offline_lineage before update on sessions
for each row execute function rotate_offline_revision();
