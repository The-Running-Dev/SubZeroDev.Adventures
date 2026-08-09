-- Lets a guest claim their progress on a second device without signing in anywhere --
-- same discipline as auth_sessions: code_hash stores sha256(code), the raw code is never
-- persisted, only ever compared by re-hashing what's redeemed.
create table transfer_codes (
  code_hash  text primary key,
  player_id  uuid not null references players(player_id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index transfer_codes_by_player on transfer_codes (player_id);
