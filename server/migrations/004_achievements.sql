-- One row per (player, campaign, achievement) unlock -- the ProfileStore's PlayerProfile
-- is just this table grouped by player_id (core/session/profile-store.ts's reference
-- in-memory shape is a Map<profileId, PlayerProfile>; this is its durable equivalent).
create table achievements (
  player_id      uuid not null references players(player_id) on delete cascade,
  campaign_id    text not null,
  achievement_id text not null,
  unlocked_at    timestamptz not null default now(),
  primary key (player_id, campaign_id, achievement_id)
);
