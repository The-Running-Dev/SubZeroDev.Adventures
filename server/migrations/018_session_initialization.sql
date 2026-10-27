-- Host-owned replay input, outside the serialized GameState. NULL means an older
-- writer did not record it; JSON {} means a known initialization without profile data.
-- Never backfill unknown inputs or give this column an empty-object default.
alter table sessions add column initialization jsonb;
alter table saves add column initialization jsonb;
