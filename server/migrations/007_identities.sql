-- Generalizes the single github_id column into a (provider, subject) link table, so a
-- second identity provider is a new row shape, not a new column on players. Existing
-- GitHub-linked players migrate in as provider='github', subject=github_id, unchanged
-- player_id -- no player loses their account.
--
-- kind's job shrinks to "has this player ever linked an identity, or is it still a bare
-- guest" -- 'github' stops being a meaningful value once a second provider exists, so it
-- renames to 'member'.
create table identities (
  provider   text not null,
  subject    text not null,
  player_id  uuid not null references players(player_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);

create index identities_by_player on identities (player_id);

insert into identities (provider, subject, player_id)
select 'github', github_id, player_id from players where github_id is not null;

update players set kind = 'member' where kind = 'github';

alter table players drop constraint players_kind_check;
alter table players add constraint players_kind_check check (kind in ('guest', 'member'));

alter table players drop column github_id;
