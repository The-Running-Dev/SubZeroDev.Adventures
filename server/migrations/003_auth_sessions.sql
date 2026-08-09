-- token_hash stores sha256(cookie value) -- the raw token is never persisted, only ever
-- compared by re-hashing an incoming cookie.
create table auth_sessions (
  token_hash text primary key,
  player_id  uuid not null references players(player_id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index auth_sessions_by_player on auth_sessions (player_id);
