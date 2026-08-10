-- A player's public-profile identifier and opt-in flag. `profile_slug` is a second,
-- unguessable public id -- deliberately distinct from `player_id`, which stays opaque
-- (see api.test.ts's "keeps the internal player identifier out of every response but
-- /api/me"). Generated lazily, the first time a player opts into public, and kept stable
-- afterward so re-enabling doesn't rotate the link (routes/profile.ts).
alter table players
  add column profile_slug   text unique,
  add column profile_public boolean not null default false;
