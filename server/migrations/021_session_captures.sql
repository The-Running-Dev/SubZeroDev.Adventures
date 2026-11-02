-- Session captures (engine spec 08 §8, docs/session-capture.md). The fixture is the engine's
-- `ReplayFixture`, verbatim; everything that ties it to a person lives in the columns beside
-- it, never inside it. `player_id` cascades, so deleting an account deletes its captures.
-- `campaign_versions` is every epoch the fixture replays through (its start version and each
-- adoption target), so a content deletion can purge the captures that name a deleted epoch.
-- `expires_at` is set at insert from `CAPTURE_RETENTION_DAYS`; reads filter on it and
-- `maintenance.ts` sweeps it.
create table session_captures (
  capture_id        uuid primary key,
  player_id         uuid not null references players(player_id) on delete cascade,
  session_id        uuid not null,
  campaign_id       text not null,
  campaign_versions text[] not null,
  trigger           text not null check (trigger in ('report', 'fault')),
  fixture           jsonb not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null
);
create index session_captures_by_player on session_captures (player_id, created_at desc);
create index session_captures_by_expiry on session_captures (expires_at);
-- At most one fault capture per session: an error that repeats on every command would
-- otherwise store the same history once per command.
create unique index session_captures_one_fault on session_captures (session_id)
  where trigger = 'fault';

-- Consent to automatic fault capture (decided 2026-11-01: an explicit opt-in, off by default).
-- NULL is "not given"; a timestamp records when it was. A report carries its own consent in
-- the request and never reads this.
alter table players add column fault_capture_consented_at timestamptz;
