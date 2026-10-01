# The game simulator

`/sim` plays NFL, NBA, NHL and MLB games out one play at a time from real
player statistics. Pick a game from the day's slate (or invent one), then
either **watch one game** — scoreboard, line score, play-by-play and a box score
that fills in as it goes — or **simulate thousands** and read off the win
probability, the margin and total against the posted line, the most likely
scores, and every player's stat distribution (exportable as CSV). A third mode
runs every game on a date at once.

The server only gathers data. Every game is played in the browser, in a Web
Worker, so a 10,000-game batch costs the server nothing and a what-if (bench a
star, start the backup goalie) needs no round trip.

## Where things live

| File | What it does |
| --- | --- |
| `src/lib/sim/espn-stats.server.ts` | ESPN reads: league-wide player season stats, standings, teams, rosters + injuries, scoreboard (lines, probables). Cached in-process. |
| `src/lib/sim/build.server.ts` | Turns season totals into regressed per-player rates and a `SimMatchup`. |
| `src/lib/sim/sim.functions.ts` | The three server functions: slate, teams, matchup. |
| `src/lib/sim/{nba,nhl,mlb,nfl}.ts` | The engines. Pure TypeScript, seeded, no I/O. |
| `src/lib/sim/aggregate.ts` | Folds a batch into histograms and summaries. |
| `src/lib/sim/props.ts` | Box-score layouts and the player stats a batch reports. |
| `src/lib/sim/sim.worker.ts` | Runs engines off the main thread. |
| `src/components/sim/*` | Viewer, batch results, roster editor, slate runner. |
| `src/routes/sim*.tsx` | `/sim` and `/sim/$league`. |
| `scripts/test-game-sim.ts` | Invariants, determinism, calibration against live data. |

## Data

* **Player stats** — ESPN's league-wide `statistics/byathlete` feed, this season
  and last. It is read league-wide and matched on the player, so someone traded
  over the summer brings last season's numbers to his new team. It is heavy
  (4–8 MB a page), so it is reduced to numbers immediately and cached for hours.
* **Two seasons, weighted.** Counts are pooled as `this season + w × last`,
  with `w = 1` before a season has games and falling to 0.2 by mid-season
  (6 games in the NFL, 30 in the NBA/NHL, 50 in MLB).
* **Regression toward the league.** Every rate is `(count + k·league) /
  (opportunities + k)`, with `k` sized to how noisy the stat is. In baseball,
  for instance, a batter's strikeout rate regresses with 100 plate appearances
  of league average, power with 250, and singles — mostly luck on balls in play
  — with 600; a pitcher's hits allowed regress with 700 batters faced. Players
  with no numbers are the league average, slightly discounted.
* **Rosters and injuries** from each team's ESPN roster. Anyone listed out,
  doubtful, on IR or the IL starts benched; every player can be toggled.
* **Defense** comes from the standings: points allowed per game relative to the
  league becomes a factor applied to the opponent, regressed (see below).
* **The posted line** (spread, total, moneyline) rides along from the
  scoreboard for comparison only. No engine reads it.

## The engines

**NBA — possession by possession.** Each possession lasts a sampled number of
seconds; then one of the five players on the floor uses it (two, three, free
throws, turnover) in proportion to his per-minute rates. Misses go to a
rebound battle between the offense's offensive rebounding and the defense's
defensive rebounding; steals, blocks, assists and fouls are credited the same
way. A rotation tracks each player's minutes against his season average —
starters open halves, the top five close a close fourth quarter, the bench
plays out blowouts — with foul trouble, foul-outs, late intentional fouling,
"down three, shoot a three", and overtime until someone wins. Score effects
(a leading team plays slightly worse) and shared game-to-game pace noise bring
the margin spread to the real ~13 points.

**NHL — shift by shift.** Continuous time. The twelve forwards and six
defencemen with the most ice time dress in lines and pairs, which get the ice
in proportion to their ice time. Each skater shoots at his per-60 rate; a shot
scores at his regressed shooting percentage times how much more (or less)
the goalie lets in than the league. Penalties follow each player's penalty
rate; power plays use the best power-play producers. The goalie is pulled
around two minutes out down one (later down two); regular-season ties go to
3-on-3 and a shootout, playoff ties to 20-minute sudden-death periods.

**MLB — plate appearance by plate appearance.** Outcome probabilities combine
batter, pitcher and league by the odds-ratio method, then the park. Realistic
base advancement, double plays, sac flies, steals and errors; the starter
tires the third time through and leaves on a pitch count or a blow-up; the pen
is used by leverage (closer for saves, set-up men in the eighth, long men in
blowouts). Ghost runner in regular-season extras, none in October; walk-offs.
With no listed probable, each game draws its starter from the rotation.

**NFL — snap by snap.** Quarter, clock, down, distance, field position,
timeouts. Run/pass from the team's own tendency bent by down, distance, score
and clock; the ball goes to a player by carries or targets (tilted toward
touchdown-makers in the red zone); yards from his own averages against this
defense. Completion = QB accuracy × receiver catch rate by odds ratio;
sacks and picks = QB rates against the pass rush and secondary. Touchdowns
happen when a gain crosses the goal line. Fourth-down calls, FGs by distance
and kicker, punts, 2025 kickoffs, penalties, two-minute warning, hurry-up and
clock-killing, kneel-downs, two-point tries, onside kicks, and overtime with
both teams guaranteed a possession (ties possible in the regular season).

Every engine is seeded. The same matchup, settings and seed give the same game
play for play, whether recorded for the viewer or played silently in a batch —
which is how a game picked out of a batch ("biggest upset") can be watched.
Flavor text draws from a separate random stream so recording never changes the
game.

## Calibration

Each engine has a handful of constants (scoring level, home edge, game-to-game
variance) tuned until real rosters, played against each other both ways,
reproduce their league. Figures from the October 1, 2026 data:

| League | Scoring (real → sim) | Home team wins, same roster both sides (of decided games) | Margin spread around expectation |
| --- | --- | --- | --- |
| NFL | 22.97 → 23.0 pts | 55.4% | 13.0 (real ≈ 13.5) |
| NBA | 115.0 → 114.6 pts | 55.2% | 13.3 (real ≈ 13) |
| NHL | 3.13 → 3.12 goals | 54.2% | 2.5 (real ≈ 2.5) |
| MLB | 4.48 → 4.48 runs | 52.2% | 4.1 (real ≈ 4.3) |

Plus the shape of a game: NFL ~63 offensive plays, ~330 yards and 85% field
goals a team; NBA ~88 FGA, 36 threes, 23 FTA, 13 turnovers; NHL ~28 shots and
2.8 power plays converting ~20%, 20% of games to overtime; MLB ~8.5 hits,
3.8 walks, 8.4 strikeouts and ~148 pitches a team.

**Known misses.** Overtime frequency is off in two leagues: the NFL engine goes
to overtime in ~8% of games (real ≈ 5–6%) and ends ~1% tied (real ≈ 0.3%),
because late-game decision-making is simpler than real coaching; the NBA engine
goes to overtime in ~3% (real ≈ 6%), because real end-of-game play steers toward
ties more than per-possession randomness does. Neither moves win probabilities
much, but a prop on "goes to overtime" should not be read off these numbers.

**Strength elasticity.** A full round robin (every team against every other,
both ways, neutral site) checks how much of each team's season points for and
against shows up in the simulation. The first NFL version turned a defense
allowing 27% more points than average into one ~40% worse (yardage and
completion boosts compound); its defense weight was cut until simulated points
allowed track season points allowed at a regressed ~0.65×. The NBA defense was
under-weighted (0.36×) and raised to ~0.5×. Net strength now carries through
at 0.72× (NFL), 0.50× (NBA, preseason, so last season's results), 0.65× (NHL)
and 0.57× (MLB) — the shrinkage you'd want from noisy season results.

**Against the market** (never an input):

* NFL, October 4, 2026, 14 games: simulated mean margin vs posted spread
  correlates **0.81**, with a similar spread of opinions (SD 5.8 vs 5.3 points).
  The biggest disagreements are games where the injury report decides the
  quarterback (e.g. Chicago with Caleb Williams listed doubtful).
* NHL, October 1, 2026, 8 games: simulated win probability vs no-vig moneyline
  correlates **0.91** (logit), but the simulation is more cautious than the
  market (slope ≈ 0.7).
* MLB postseason (one game) and the NBA (preseason) had too few priced games to
  say anything.

Reproducing league averages is the floor, not proof of accuracy on any single
game. A proper out-of-sample backtest — simulating last season's games from
point-in-time data and scoring the results like the other models on this site —
is the obvious next step and has not been done.

## What the simulator can't know

Today's news beyond the injury report (minutes limits, weather, rest), matchups
inside the matchup (a shutdown corner, a lefty specialist), schemes, and
whether a small-sample hot start is real. Its probabilities are its own; where
it disagrees with the market, the market usually knows something it doesn't.

## Testing

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/test-game-sim.ts          # all four
NODE_USE_ENV_PROXY=1 npx tsx scripts/test-game-sim.ts nfl nhl  # some
```

Checks, per league, against live data: box scores add up (every point credited
to a player, minutes and innings consistent), a seed replays the same game,
recorded play-by-play rebuilds the final box exactly, round-robin scoring
within 4% of the league, and a mirror match won at home 51–58% of the time.

Locally, server functions need the Supabase variables the global auth
middleware reads (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) even
though the simulator never touches Supabase; placeholder values are enough.
