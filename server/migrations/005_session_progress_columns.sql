-- Denormalizes four fields the progress endpoint (server/src/routes/progress.ts) needs to
-- query across all of a player's sessions -- campaign_id, status, step_count are cheap to
-- read straight off the stored GameState JSON (blob is canonicalStringify(GameState):
-- 002_sessions_and_saves.sql), so there's no reason to make every progress request
-- deserialize every blob through the engine to answer "what have I played and how far".
--
-- ending_id is the one field this migration cannot backfill in SQL: it comes from the
-- kind's own `outcome(kindState)` (engine/src/engine/src/core/kernel/types.ts), which is
-- kind-specific application logic, not a fixed JSON path -- story-graph's outcome reads
-- `kindState.endingId` directly, but a future kind is free to compute it differently.
-- Existing ended sessions land with ending_id null until next touched; going forward,
-- server/src/persistence.ts writes it on every put alongside the other three.
alter table sessions
  add column campaign_id text,
  add column status       text,
  add column ending_id    text,
  add column step_count   integer;

update sessions
set
  campaign_id = blob::jsonb ->> 'campaignId',
  status      = blob::jsonb ->> 'status',
  step_count  = jsonb_array_length(coalesce(blob::jsonb -> 'actionLog', '[]'::jsonb));

alter table sessions
  alter column campaign_id set not null,
  alter column status set not null,
  alter column step_count set not null;

create index sessions_by_player_campaign on sessions (profile_id, campaign_id);
