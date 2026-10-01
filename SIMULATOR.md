# The game simulator

Each of the NFL, NBA, MLB and NHL sections has a **Simulate** view
(`/nfl/simulate`, `/nba/simulate`, `/mlb/simulate`, `/nhl/simulate`) that plays
games out one play at a time from real player statistics and each team's
tendencies on both sides of the ball. Pick a game from the date's slate (or
build any matchup), choose how many times to play it — 10, 100, 1,000, 5,000,
10,000, 50,000, 100,000 or any number up to 250,000 — and read:

* the win probability, margin and total against the posted line, the most
  likely scores — each with its Monte Carlo error;
* the **average box score**: every player's line averaged over all the games;
* every player's projected stat next to **his season per-game average**, with
  the distribution and the chance of clearing each common line (CSV export);
* **who this matchup moves**: the biggest gaps between a player's simulated
  average and his season;
* the **matchup factors** behind it: each defense's season splits against the
  league, and what they do to the offense across from it.

Or watch a single game unfold with a live box score. A fifth mode runs every
game on a date at once. `/sim` is an overview with the calibration table.

Nothing on the page is replayable by design. Every run draws fresh random
numbers, so the same matchup run twice gives slightly different answers — by
about the ± the page shows, which shrinks with the square root of the number
of games (±3 points of win probability at 1,000 games, ±1 at 10,000).

The server only gathers data. Every game is played in the browser, in Web
Workers — a big batch is split across up to four cores and the pieces' totals
added back together — so 100,000 games cost the server nothing (about 12
seconds for the NBA on a four-core laptop, 3 seconds for 20,000 NFL games) and
a what-if (bench a star, start the backup goalie) needs no round trip.

## Where things live

| File | What it does |
| --- | --- |
| `src/lib/sim/espn-stats.server.ts` | ESPN reads: league-wide player season stats, team season stats (own and opponents'), standings, teams, rosters + injuries + handedness, scoreboard (lines, probables). Cached in-process. |
| `src/lib/sim/tendencies.server.ts` | Team totals → regressed matchup tendencies (pass defense, pace, power play…). |
| `src/lib/sim/build.server.ts` | Season totals → regressed per-player rates, season per-game averages and a `SimMatchup`. |
| `src/lib/sim/sim.functions.ts` | The three server functions: slate, teams, matchup. |
| `src/lib/sim/{nba,nhl,mlb,nfl}.ts` | The engines. Pure TypeScript, seeded, no I/O. |
| `src/lib/sim/aggregate.ts` | Folds a batch into histograms, box-score sums and summaries; mergeable across workers. |
| `src/lib/sim/props.ts` | Box-score layouts (per game and averaged) and the player stats a batch reports. |
| `src/lib/sim/sim.worker.ts` | Runs engines off the main thread. |
| `src/components/sim/SimulatePage.tsx` | The Simulate view; the four `src/routes/<sport>.simulate.tsx` routes render it. |
| `src/components/sim/*` | Matchup factors, batch results, viewer, roster editor, slate runner, worker pool. |
| `scripts/test-game-sim.ts` | Invariants, determinism, merging, calibration against live data. |

## Data

* **Player stats** — ESPN's league-wide `statistics/byathlete` feed, this season
  and last. It is read league-wide and matched on the player, so someone traded
  over the summer brings last season's numbers to his new team. It is heavy
  (4–8 MB a page), so it is reduced to numbers immediately and cached for hours.
* **Team stats** — ESPN's `statistics/byteam` feed: each team's own season
  totals and its opponents' against it. This is where the matchup comes from.
* **Two seasons, weighted.** Counts are pooled as `this season + w × last`,
  with `w = 1` before a season has games and falling to 0.2 by mid-season
  (6 games in the NFL, 30 in the NBA/NHL, 50 in MLB). Percentages and
  baseball's innings are converted to counts per season before pooling.
* **Regression toward the league.** Every rate is `(count + k·league) /
  (opportunities + k)`, with `k` sized to how noisy the stat is. In baseball,
  for instance, a batter's strikeout rate regresses with 100 plate appearances
  of league average, power with 250, and singles — mostly luck on balls in play
  — with 600; three-point defense in the NBA with 2,500 attempts, because it is
  mostly luck. Players with no numbers are the league average, slightly
  discounted.
* **Rosters, injuries and handedness** from each team's ESPN roster. Anyone
  listed out, doubtful, on IR or the IL starts benched; every player can be
  toggled.
* **The posted line** (spread, total, moneyline) rides along from the
  scoreboard for comparison only. No engine reads it.

## Matchups

Each engine combines a player's own rates with what the defense across from him
allows, relative to the league — rates by odds ratio, amounts by ratio:

| League | Defense (what it allows) | Offense / style |
| --- | --- | --- |
| NFL | completion %, yards per completion, yards per carry, sack rate, interception rate | pass rate, plays per game (tempo) |
| NBA | opponents' 2P% and 3P%, share of shots that are threes, free throws per shot, turnovers forced, defensive rebound % | pace (both teams', combined) |
| NHL | shots allowed; penalty kill against the power play | power-play conversion; score effects |
| MLB | errors (reached on error) | platoon: each hitter's line split by pitcher hand |

So a receiver facing a secondary that gives up 9% more yards per catch than the
league gains about 9% more per catch; a lefty-heavy lineup against a lefty
starter strikes out more and hits for less power. What the public data does not
have is **position-by-position** defense — who covers whom — so a shutdown
corner on one receiver is not modelled; team splits are.

## The engines

**NBA — possession by possession.** Each possession lasts a sampled number of
seconds; then one of the five players on the floor uses it (two, three, free
throws, turnover) by his per-minute rates raised to the 1.5 power — season
rates were earned next to different teammates and add up to more than one
team's possessions, and real role players defer to the star. Shots meet the
defense by odds ratio; misses go to a rebound battle; steals, blocks, assists
and fouls are credited the same way. A rotation tracks each player's minutes
against his season average — starters open halves, the top five close a close
fourth quarter, the bench plays out blowouts — with foul trouble, foul-outs,
late intentional fouling, "down three, shoot a three", and overtime until
someone wins.

**NHL — shift by shift.** Continuous time. The twelve forwards and six
defencemen with the most ice time dress in lines and pairs, which get the ice
in proportion to their ice time. Each skater shoots at his per-60 rate times
how many shots the opponent allows; a shot scores at his regressed shooting
percentage times how much more (or less) the goalie lets in than the league.
The trailing team presses at even strength (6% more shots per goal of deficit,
up to two). Penalties follow each player's penalty rate; the power play's
conversion meets the penalty kill's. The goalie is pulled around two minutes
out down one; regular-season ties go to 3-on-3 and a shootout, playoff ties to
20-minute sudden-death periods.

**MLB — plate appearance by plate appearance.** Outcome probabilities combine
batter (split by the pitcher's hand), pitcher and league by the odds-ratio
method, then the park. Realistic base advancement, double plays, sac flies,
steals, hit batsmen and errors (at the fielding team's rate); the starter tires
the third time through and leaves on a pitch count or a blow-up; the pen is
used by leverage (closer for saves, set-up men in the eighth, long men in
blowouts). Ghost runner in regular-season extras, none in October; walk-offs.
With no listed probable, each game draws its starter from the rotation.

**NFL — snap by snap.** Quarter, clock, down, distance, field position,
timeouts. Run/pass from the team's own pass rate bent by down, distance, score
and clock; the ball goes to a player by carries or targets (tilted toward
touchdown-makers in the red zone); yards from his own averages against this
defense. Completion = QB accuracy × receiver catch rate × the defense's
completion rate allowed, by odds ratio; sacks and picks = QB rates against the
defense's. Touchdowns happen when a gain crosses the goal line. Fourth-down
calls, FGs by distance and kicker, punts, 2025 kickoffs, penalties, two-minute
warning, hurry-up and clock-killing, kneel-downs, two-point tries, onside
kicks, and overtime with both teams guaranteed a possession (ties possible in
the regular season). Tackles are credited as official totals are, with assisted
tackles counted for both players.

Every engine is seeded — the tests rely on it: the same matchup, settings and
seed give the same game play for play, and a batch split across workers adds
up to exactly the same totals as one run. The page never reuses a seed.

## Calibration

Each engine has a handful of constants (scoring level, home edge, game-to-game
variance) tuned until real rosters, played against each other both ways,
reproduce their league. Figures from the October 1, 2026 data:

| League | Scoring (real → sim) | Home team wins, same roster both sides (of decided games) | Margin spread around expectation |
| --- | --- | --- | --- |
| NFL | 22.97 → 22.95 pts | 55.6% | 13.1 (real ≈ 13.5) |
| NBA | 115.0 → 114.7 pts | 55.6% | 13.4 (real ≈ 13) |
| NHL | 3.13 → 3.12 goals | 54.1% | 2.3 (real ≈ 2.4) |
| MLB | 4.48 → 4.48 runs | 52.3% | 4.1 (real ≈ 4.3) |

Plus the shape of a game: NFL ~63 offensive plays, ~335 net yards and 85% field
goals a team; NBA ~88 FGA, 36 threes, 23 FTA, 13 turnovers; NHL ~28 shots and
2.8 power plays converting ~20%, 21% of games to overtime; MLB ~8.4 hits,
3.4 walks, 8.5 strikeouts and ~148 pitches a team.

**Players against their own seasons.** Every player who plays in at least 80%
of simulated games, in every team's roster, compared with his season per-game
average and split into thirds by how much he produces:

* NBA points per minute within ~10% of season in every tier, and rebounds
  within 1%. Stars had been 12–20% short before usage was concentrated — Luka
  Dončić came out at 26 points a game; he now averages 31 against the
  Clippers' defense (33.5 on the season). Preseason rosters hold more players
  with real minutes than a game has, so most players' minutes, and points,
  shrink a little to fit 240.
* NHL shots and ice time within ~4% in every tier, goals within 5% for the
  regular scorers; assists within ~8% (defencemen had been getting a fifth too
  many).
* MLB hits, total bases, homers, walks and strikeouts within 2–5%, against a
  season line counted per start — a part-timer's per-game average includes
  one-PA pinch-hit games the simulation never plays.
* NFL rushing and receiving yards within 2%, passing yards within 6%, tackles
  93% and sacks 95% of season.

**Known misses.** Overtime frequency is off in two leagues: the NFL engine goes
to overtime in ~9% of games (real ≈ 5–6%) and ends ~1% tied (real ≈ 0.3%),
because late-game decision-making is simpler than real coaching; the NBA engine
goes to overtime in ~3% (real ≈ 6%), because real end-of-game play steers toward
ties more than per-possession randomness does. Neither moves win probabilities
much, but a prop on "goes to overtime" should not be read off these numbers.

**Strength elasticity.** A full round robin (every team against every other,
both ways, neutral site) checks how much of each team's season points for and
against shows up in the simulation. Net strength carries through at 0.57×
(NFL), 0.50× (NBA, preseason, so last season's results), 0.70× (NHL) and 0.68×
(MLB) — the shrinkage you'd want from noisy season results.

**Against the market** (never an input):

* NFL, October 4, 2026, 14 games: simulated mean margin vs posted spread
  correlates **0.90** (0.81 before the defensive splits were added), slope
  0.88; simulated win probability vs no-vig moneyline correlates **0.92**.
* NHL, October 1, 2026, 8 games: simulated win probability vs no-vig moneyline
  correlates **0.90** (logit), more cautious than the market (slope ≈ 0.76).
* MLB postseason (one game) and the NBA (preseason) had too few priced games to
  say anything.

Reproducing league averages is the floor, not proof of accuracy on any single
game. A proper out-of-sample backtest — simulating last season's games from
point-in-time data and scoring the results like the other models on this site —
is the obvious next step and has not been done.

## What the simulator can't know

Today's news beyond the injury report (minutes limits, weather, rest),
position-by-position matchups (a shutdown corner, a lefty specialist out of the
pen), schemes, and whether a small-sample hot start is real. Its probabilities
are its own; where it disagrees with the market, the market usually knows
something it doesn't.

## Testing

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/test-game-sim.ts          # all four
NODE_USE_ENV_PROXY=1 npx tsx scripts/test-game-sim.ts nfl nhl  # some
```

Checks, per league, against live data: box scores add up (every point credited
to a player, minutes and innings consistent), a seed replays the same game,
recorded play-by-play rebuilds the final box exactly, a batch merged from
pieces equals the whole, round-robin scoring within 4% of the league, and a
mirror match won at home 51–58% of the time.

Locally, server functions need the Supabase variables the global auth
middleware reads (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) even
though the simulator never touches Supabase; placeholder values are enough.
