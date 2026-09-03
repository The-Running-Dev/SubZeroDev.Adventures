-- `StoredSaveRecord.savedAt` (engine 0.10.0, W99 "Session Lifecycle Operations") is a
-- clock-stamped ISO-8601 string the engine reads back verbatim -- the same reasoning
-- `002_sessions_and_saves.sql` already gives for `sessions.created_at`/`updated_at` being
-- `text`, not `timestamptz`: a timestamptz round-trip through Postgres would reformat it,
-- and nothing in the engine parses this column as a Postgres timestamp. Distinct from
-- `saves.created_at` (host-owned, ordering only, unrelated to the engine record).
--
-- Backfill value for every pre-existing row is the epoch, per the engine's own contract
-- (`design/90-decisions.md`, 2026-08-2x "session branching and the fork-point contract" --
-- "the epoch, so unstamped saves sort last"): `listSaves` sorts `savedAt` descending, so an
-- unstamped save simply sorts after every save this server has actually written since.
alter table saves add column saved_at text;

update saves set saved_at = '1970-01-01T00:00:00.000Z' where saved_at is null;

alter table saves alter column saved_at set not null;

-- `listSaves(profileId)` (engine `SessionStore`) sorts by `savedAt` descending, `saveId`
-- ascending -- the same shape `saves_by_player_campaign` already indexes for
-- `saved_at_seq`, one column swapped for the one this operation actually orders by.
create index saves_by_player_saved_at on saves (profile_id, saved_at desc, save_id asc);
