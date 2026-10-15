-- game_results: what actually happened in every game the boards tracked.
--
-- Each pick in player_predictions is graded hit / miss / void from the box
-- score, but only the verdict was kept — not the line it was judged on. This
-- stores the box score itself once a tracked game is final: the score and
-- every player's line in the stats the markets settle on (touchdowns,
-- receiving yards, goals, shots, points, ...), plus who scored first. With it
-- next to the pre-game simulation (sim_props) and the recorded picks, any
-- pick can be checked by hand — and box_url is where to check it.
--
-- Written by the morning grading job (/api/public/hooks/sim-props?settle=1)
-- for every game it grades, and for every earlier game this season that has
-- recorded picks but no stored result yet. One row per game; a later fetch
-- of the same final box score rewrites it with the same numbers.

create table if not exists public.game_results (
  league text not null,                   -- nba | nhl | nfl | cfb | mlb
  event_id text not null,                 -- ESPN event id, as in player_predictions
  game_date date,                         -- the slate's (US Eastern) date
  matchup text,                           -- 'SEA @ DEN'
  final_score text,                       -- 'SEA 20 – DEN 17'
  -- [{id, name, team, stats: {stat: value}}], ids are ESPN athlete ids
  players jsonb not null,
  first_scorer text,                      -- player id of the first goal / touchdown
  box_url text,
  source text not null default 'espn',
  fetched_at timestamptz not null default now(),
  primary key (league, event_id)
);

create index if not exists game_results_by_date on public.game_results (league, game_date desc);

grant select on public.game_results to anon, authenticated;
grant all on public.game_results to service_role;

alter table public.game_results enable row level security;

drop policy if exists "Public read game_results" on public.game_results;
create policy "Public read game_results" on public.game_results for select using (true);

comment on table public.game_results is
  'The final box score of every tracked game — each player''s line in the stats the prop markets settle on — so recorded picks can be checked against what happened.';
