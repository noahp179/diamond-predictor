-- sim_props: each upcoming game's simulation, for the simulation-driven prop
-- boards (every NBA, NHL and NFL market on the Props pages: points, rebounds,
-- assists, threes, combos, shots, saves, yards, catches, passing, touchdowns,
-- first scorers).
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

-- sim_prop_bands: the Analytics pages' one read. Every simulation pick in the
-- ledger, counted per market, per confidence band (0-10%, 10-20%, ... 90-100%,
-- by the probability the board showed) and per rank on the game's card: how
-- many settled, how many came in, what they were priced at in total, how many
-- were voided (the player did not play) and how many still wait on a result.
-- A few hundred rows a sport, however long the ledger grows.

create or replace view public.sim_prop_bands
with (security_invoker = true) as
select
  sport,
  market,
  pick_rank,
  least(floor(prob * 10), 9)::int as band,
  count(*) filter (where settled_at is not null and scored is not null) as n,
  count(*) filter (where scored) as hits,
  coalesce(sum(prob) filter (where settled_at is not null and scored is not null), 0) as said,
  count(*) filter (where settled_at is not null and scored is null) as voids,
  count(*) filter (where settled_at is null) as pending,
  min(event_date) as first_date,
  max(event_date) filter (where settled_at is not null) as last_settled
from public.player_predictions
where model_version like '%-sim-%' and provenance = 'forward'
group by sport, market, pick_rank, least(floor(prob * 10), 9);

grant select on public.sim_prop_bands to anon, authenticated;

comment on view public.sim_prop_bands is
  'Simulation picks per market, confidence band and card rank: settled, hits, total price, voids, pending. Read by the Props > Analytics pages.';
