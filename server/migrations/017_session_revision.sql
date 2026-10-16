-- `StoredSessionRecord.revision` (engine 0.11.0, S122): the session compare-and-swap field,
-- `0` when first written and `+1` on every accepted write. `server/src/persistence.ts`
-- compared `attempt_counter` before this, but the engine advances that on a *rejected*
-- submission without writing, so the next valid action after any rejection failed the
-- compare-and-swap as a false conflict.
--
-- Backfill is `0` for every existing row: the engine reads `revision` back through
-- `sessions.get` and writes `revision + 1`, so any starting value is consistent as long as
-- it is the one stored. Rows written by an engine that predates the field never carried one.
alter table sessions add column revision integer not null default 0;
