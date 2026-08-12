-- Replaces the ADMIN_SUBJECTS env allowlist (routes/admin.ts) with queryable, assignable
-- data: a role an admin can grant to another player from the admin page, rather than opaque
-- configuration that requires a redeploy to change. Two values only -- there is no moderator
-- tier below admin yet, and adding one later is another allowed value, not a reshape.
--
-- No row starts as 'admin' -- the first grant comes from `grant-role-cli.ts`, run once per
-- deployment against the deployed database (see CLAUDE.md's admin bootstrap note), the same
-- one-off posture `ADMIN_SUBJECTS` itself had before this migration.
alter table players
  add column role text not null default 'player' check (role in ('player', 'admin'));
