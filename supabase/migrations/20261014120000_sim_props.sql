-- sim_props: each upcoming game's simulation, for the simulation-driven prop
-- boards (NBA points, NHL points / goals / first goal, NFL and college
-- touchdowns and first touchdown).
--
-- A game is played up to 100,000 times by the site's own simulator — far too
-- many for a page load, so scheduled jobs (/api/public/hooks/sim-props) play
-- each day's games a few at a time and store every player's chance of
-- reaching each line here. The boards read this table; the forward ledger
-- (player_predictions) snapshots its picks from it.
--
-- One row per game, rewritten when the game is re-simulated (an injury, a
-- later run with more plays). It is a cache of a computation, not a record:
-- the record is player_predictions, written once before the game.

create table if not exists public.sim_props (
  league text not null,                   -- nba | nhl | nfl | cfb
  event_id text not null,
  game_date date not null,                -- the slate's (US Eastern) date
  start_time timestamptz,
  home_id text not null,
  away_id text not null,
  home_abbr text,
  away_abbr text,
  runs int not null,                      -- games actually played
  version text not null,                  -- simulator build, e.g. 'sim-v1'
  -- [{id, name, team, side, pos, played, first, p: {market: [P(>= line)...]}, mean: {market: x}}]
  players jsonb not null,
  basis text,                             -- what the numbers were built from
  generated_at timestamptz not null default now(),
  primary key (league, event_id)
);

create index if not exists sim_props_by_date on public.sim_props (league, game_date);

grant select on public.sim_props to anon, authenticated;
grant all on public.sim_props to service_role;

alter table public.sim_props enable row level security;

drop policy if exists "Public read sim_props" on public.sim_props;
create policy "Public read sim_props" on public.sim_props for select using (true);

comment on table public.sim_props is
  'Each upcoming game simulated up to 100,000 times; every player''s chance of reaching each prop line. Rewritten on re-simulation; the forward record lives in player_predictions.';
