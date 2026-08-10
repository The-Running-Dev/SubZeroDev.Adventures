-- Backs the redeem-attempt rate limit (routes/transfer.ts) with a row per IP instead of
-- a process-local Map -- durable across a restart and shared between replicas, since both
-- would otherwise count the same brute-force attempt separately.
create table transfer_redeem_attempts (
  ip           text primary key,
  count        integer not null default 1,
  window_start timestamptz not null default now()
);
