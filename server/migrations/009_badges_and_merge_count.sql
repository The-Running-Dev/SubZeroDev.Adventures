-- Cross-campaign player badges (server/src/badges.ts) plus the merge counter one of them
-- reads. Mirrors 004_achievements.sql's shape -- same stored-not-computed posture, same
-- `on delete cascade`, same "unlocked_at records when earned, not when a merge ran"
-- contract mergePlayers' carry-over depends on. No campaign_id in the key: a badge is a
-- property of the whole account, not one campaign.
create table badges (
  player_id   uuid not null references players(player_id) on delete cascade,
  badge_id    text not null,
  unlocked_at timestamptz not null default now(),
  primary key (player_id, badge_id)
);

-- Read only by the frequent-flyer badge. Lives on players, not derived, because a merge
-- deletes the "from" player's row (principal.ts) -- nothing is left to count afterwards.
alter table players
  add column merge_count integer not null default 0;
