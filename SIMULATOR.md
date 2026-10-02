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

Or watch a single game unfold with a live play-by-play, box score and team
stats. A fifth mode runs every game on a date at once, up to 250,000 times
each (the page estimates how long a big slate will take). `/sim` is an
overview with the calibration table.

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
| `scripts/build-nfl-coaching.ts` → `src/lib/sim/nfl-coaching.json` | NFL coaching from nflverse play-by-play: pass rate over expected, the league's 4th-down go rates by spot, each head coach's aggressiveness. Re-run weekly in season. |
| `src/lib/sim/build.server.ts` | Season totals → regressed per-player rates, season per-game averages and a `SimMatchup`. |
| `src/lib/sim/sim.functions.ts` | The three server functions: slate, teams, matchup. |
| `src/lib/sim/{nba,nhl,mlb,nfl}.ts` | The engines. Pure TypeScript, seeded, no I/O. |
| `src/lib/sim/aggregate.ts` | Folds a batch into histograms, box-score sums and summaries; mergeable across workers. |
| `src/lib/sim/props.ts` | Box-score layouts (per game and averaged) and the player stats a batch reports. |
| `src/lib/sim/sim.worker.ts` | Runs engines off the main thread. |
| `src/components/sim/SimulatePage.tsx` | The Simulate view; the four `src/routes/<sport>.simulate.tsx` routes render it. |
| `src/components/sim/*` | Matchup factors, batch results, viewer, roster editor, slate runner, worker pool. |
| `scripts/test-game-sim.ts` | Invariants, determinism, merging, calibration against live data. |
| `scripts/backtest-sim.ts` | Out-of-sample backtest: replays finished games from last season's stats and scores them against the closing market and players' actual lines. |

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
| NFL | completion %, yards per completion, yards per carry, sack rate, interception rate | pass rate over expected, plays per game (tempo), head coach's 4th-down aggressiveness |
| NBA | opponents' 2P% and 3P%, share of shots that are threes, free throws per shot, turnovers forced, defensive rebound % | pace (both teams', combined) |
| NHL | shots allowed; penalty kill against the power play | power-play conversion; score effects |
| MLB | errors (reached on error) | platoon: each hitter's line split by pitcher hand |

So a receiver facing a secondary that gives up 9% more yards per catch than the
league gains about 9% more per catch; a lefty-heavy lineup against a lefty
starter strikes out more and hits for less power. What the public data does not
have is **position-by-position** defense — who covers whom — so a shutdown
corner on one receiver is not modelled; team splits are.

## Individual players, schemes and coaching: what was tested

Before adding anything here it was tested against real games, because an
effect that doesn't show up in results makes a simulation less realistic, not
more. Data: nflverse's public charting (per-defender targets, completions,
yards, interceptions and pressures from Pro Football Reference; combine 40
times and heights; Next Gen Stats participation with man/zone coverage and
pass rushers on every play; play-by-play with expected pass rates).

| Idea | Test | Result | In the sim? |
| --- | --- | --- | --- |
| Cornerback/safety coverage quality | Same player, one season to the next | Yards per target allowed r = 0.01, completion % allowed r ≈ 0.1 — noise | No; team pass defense (r ≈ 0.4) is used instead |
| … as a matchup | ~2,200 WR games 2023–24: opposing starting CBs' prior-season numbers vs the WR's yards beyond his own average | t = 0.4, no signal (team pass defense: t = 2.5) | No |
| Speed (40 time) and height mismatches, WR vs CB | Same games | 0.5 ± 0.9 yards per SD of speed gap; −0.15 ± 0.4 yards per inch | No |
| Individual interception likelihood | Interceptions per target, season to season | r ≈ 0.18 — weak but real | Yes: interceptions go to defenders by their own regressed rates |
| Individual pass rushers | Pressures per game, season to season | r ≈ 0.78 — very real | Partly: today's defenders' sacks weight the team's sack rate. A starting front's pressure total added nothing beyond the team's own season sack rate in 1,088 team-games (t = 0.7) |
| Defensive scheme (man rate, blitz rate) | Team, season to season | r = 0.44 and 0.57 — real tendencies | Their average effect is already in each defense's splits |
| Scheme as a matchup (QB vs man/zone, vs the blitz) | Same QB, season to season | r = −0.12 and −0.33 — noise | No |
| Play calling: pass rate over expected in neutral game states | Team, season to season | r = 0.30–0.45 | **Yes** (below) |
| Fourth-down aggressiveness by head coach | Same coach, season to season | r = 0.09 and 0.62 | **Yes**, regressed hard (below) |

**Coaching**, from `scripts/build-nfl-coaching.ts` (which writes
`src/lib/sim/nfl-coaching.json`; re-run weekly in season):

* *Play calling.* A team's raw pass rate mixes its coach's preference with
  how often it trailed, and the engine already throws more when behind, so
  each team plays at the league's rate plus its early-down pass rate over
  expected in neutral game states (win probability 20–80%), this season and
  half of last (a fifth under a new head coach), regressed with 600 plays of
  league average. About ±2% between the most pass-happy and run-heavy staffs.
* *Fourth downs.* The engine used to go for it on ~15% of 4th-and-5-or-less
  between the 25s; real coaches went 37% of the time the last two seasons. It
  now decides from the league's own go rate by distance and field position,
  shifted by the head coach's go rate over expected (four seasons, regressed
  with 50 decisions): from about 28% for the most conservative staffs to 37%
  for the most aggressive in those spots.

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
someone wins. Minutes and usage wobble from game to game (a starter's target
minutes by about 15%, his share of the shots by about 16%) so a player has hot
and quiet nights, not the same line every game; players in foul trouble play
carefully; rebounds are shared by rebounding rate raised to the 1.55 power
(rebounding is concentrated), and 12% of defensive rebounds are team rebounds
no player is credited with, as in real box scores. On the second night of a
back-to-back a team makes its shots 2.8% less often (real effect: about 2
points a game).

**NHL — shift by shift.** Continuous time. The twelve forwards and six
defencemen with the most ice time dress in lines and pairs, which get the ice
in proportion to their ice time. Each skater shoots at his per-60 rate times
how many shots the opponent allows; a shot scores at his regressed shooting
percentage times how much more (or less) the goalie lets in than the league.
The trailing team presses at even strength (6% more shots per goal of deficit,
up to two). Penalties follow each player's penalty rate; the power play's
conversion meets the penalty kill's. Offsetting penalties (roughing pairs,
fights — five minutes each — and ten-minute misconducts) add the penalty
minutes that never become power plays; real teams average ~9.7 PIM a game, and
power-play minors alone gave 5.6. Defencemen pick up assists at a lower rate
than forwards, the home team shoots a little more, and trailing teams press.
The goalie is pulled around two minutes out down one; regular-season ties go to
3-on-3 and a shootout, playoff ties to 20-minute sudden-death periods.

**MLB — plate appearance by plate appearance.** Outcome probabilities combine
batter (split by the pitcher's hand), pitcher and league by the odds-ratio
method, then the park. Realistic base advancement, double plays, sac flies,
steals, hit batsmen and errors (at the fielding team's rate); the starter tires
the third time through and leaves on a pitch count or a blow-up; the pen is
used by leverage (closer for saves, set-up men in the eighth, long men in
blowouts), and a middle reliever is often lifted after one inning. A
starter's leash varies from start to start, so about a fifth of starts end
before the fourth inning is over, as real ones do. From the sixth inning the
manager uses the bench: a better bat pinch-hits in a close late game, regulars
rest in a blowout, a defensive replacement comes in to protect a small lead
("J. Smith pinch-hits for A. Jones" in the play-by-play) — a real team uses
~10.3 batters a game, and the engine used to use exactly nine. Ghost runner in
regular-season extras, none in October; walk-offs. With no listed probable,
each game draws its starter from the rotation.

**NFL — snap by snap.** Quarter, clock, down, distance, field position,
timeouts. Run/pass from the coaching staff's neutral-situation tendency bent
by down, distance, score and clock; the ball goes to a player by carries or targets (tilted toward
touchdown-makers in the red zone); yards from his own averages against this
defense. Completion = QB accuracy × receiver catch rate × the defense's
completion rate allowed, by odds ratio; sacks and picks = QB rates against the
defense's. Touchdowns happen when a gain crosses the goal line. Fourth-down
calls from the league's real go rates by spot and the head coach's lean, FGs
by distance and kicker, punts, 2025 kickoffs, penalties, two-minute
warning, hurry-up and clock-killing, kneel-downs, two-point tries, onside
kicks, and overtime with both teams guaranteed a possession (ties possible in
the regular season). Tackles are credited as official totals are, with assisted
tackles counted for both players.

Since the realism benchmark below, the NFL engine also has: quarterback
scrambles on called passes (about two-thirds of a quarterback's rushing
yards), sneaks on third and fourth and inches, offenses throwing to the sticks
on third and fourth down, compressed gains inside the 20 (less room to run),
pass depth in the play-by-play ("pass deep left", "short middle") that matches
the real share of deep completions, real penalty types and yardages (false
starts, holding, pass interference at the spot, roughing and face masks with
an automatic first down), kneel-downs only when the clock can really be run
out, a hurry-up when tied late (the engine used to sit on a tie and went to
overtime nearly twice as often as real games do), two-point tries at the real
rate, a small chance a quarterback leaves hurt, and a roof: games in domes
get 4.5% better completion odds and 2% more yards per catch, outdoor games a
little less (real effect: domes score about 2 points a game more).

Every engine is seeded — the tests rely on it: the same matchup, settings and
seed give the same game play for play, and a batch split across workers adds
up to exactly the same totals as one run. The page never reuses a seed.

## Calibration

Each engine has a handful of constants (scoring level, home edge, game-to-game
variance) tuned until real rosters, played against each other both ways,
reproduce their league. Figures from the October 1, 2026 data (NFL with the
real mix of domes and open-air stadiums):

| League | Scoring (real → sim) | Home team wins, same roster both sides (of decided games) | Margin spread around expectation |
| --- | --- | --- | --- |
| NFL | 22.97 → 22.99 pts | 54.3% | 13.0 (real ≈ 13.5) |
| NBA | 115.0 → 114.7 pts | 55.2% | 13.3 (real ≈ 13) |
| NHL | 3.13 → 3.11 goals | 51.7% | 2.3 (real ≈ 2.4) |
| MLB | 4.48 → 4.42 runs | 51.8% | 4.1 (real ≈ 4.3) |

The shape of a game — plays, drives, punts, rebounds, pitchers used, penalty
minutes and the rest — is checked against real games in the realism
benchmark below.

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

**Known misses.** See the realism benchmark: NBA overtime (~2.7% of games,
real ≈ 6% over a full season) because real end-of-game play steers toward ties
more than per-possession randomness does; NHL overtime (21%, real ≈ 23–26%)
and one-goal games; NFL fourth-down conversions (50%, real 56%). A prop on
"goes to overtime" should not be read off these numbers.

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
game. `scripts/backtest-sim.ts` replays finished games from the _previous_
season's statistics only (plus the starting pitcher or quarterback and the
posted lineup, known before the game) and scores the result against the
closing market. First runs: 467 MLB games from September 2026 — log loss 0.679
against the market's 0.665 and a home-team constant's 0.692; 48 NFL games from
weeks 1–4 of 2026 — 0.690 against the market's 0.659. The market is better, as
it should be; the simulator is better than knowing nothing, and its value is
the play-by-play and the player lines, not beating the line.

## Realism: simulated games against real ones

Every number a simulated game produces can be checked against real games, so
it was: thousands of simulated games from the October 1 rosters against the
2025 NFL regular season (nflverse play-by-play, 272 games), 467 MLB games from
September 2026, 173 NBA games from November 2025 and 144 NHL games from
October–November 2025 (ESPN box scores). Per team per game unless noted;
"before" is the engine before this round of work.

| NFL | Real | Before | Now |
| --- | --- | --- | --- |
| Pass attempts | 31.9 | 35.0 | 32.7 |
| Completions | 20.6 | 22.5 | 20.9 |
| Drives | 10.6 | 11.7 | 10.8 |
| Punts | 3.55 | 4.08 | 3.52 |
| First downs | 17.8 | 16.4 | 17.8 |
| Third-down conversion | 40.4% | 35.1% | 39.5% |
| Penalties / yards | 3.6 / 26.8 | 3.3 / 22.1 | 3.6 / 29.3 |
| Plays of 20+ yards | 3.48 | 4.08 | 3.89 |
| Two-point tries | 0.24 | 0.08 | 0.25 |
| Scrambles | 4.3 | — | 4.1 |
| Kneel-downs (game) | 1.6 | ~3 | 1.85 |
| Deep share of completions | 11.9% | — | 12.6% |
| Red-zone trips: TD / FG | 59% / 28% | — | 56% / 28% |
| Games to overtime / tied | 5.1% / 0.4% | 7.9% / 1.0% | 4.4% / 0.2% |
| One-score games | 53% | 47% | 50% |
| Points | 23.0 | 23.5 | 23.4 |

| MLB | Real | Before | Now |
| --- | --- | --- | --- |
| Batters used | 10.28 | 9.00 | 10.32 |
| Pinch-hitters and replacements | 1.32 | 0 | 1.32 |
| Starting hitter's plate appearances | 3.91 | 4.26 | 4.07 |
| Pitchers used | 4.40 | 4.67 | 4.63 |
| Starts under 4 innings | 21% | 16% | 21.5% |
| Starter's pitches | 80.6 | 86.0 | 83.2 |
| Runs / hits / HR | 4.50 / 8.25 / 1.14 | 4.46 / 8.48 / 1.19 | 4.45 / 8.47 / 1.20 |

| NBA | Real | Before | Now |
| --- | --- | --- | --- |
| Defensive rebounds | 32.6 | 37.1 | 32.6 |
| Foul-outs (game) | 0.18 | 0.36 | 0.18 |
| Most minutes on a team | 35.4 | 33.1 | 35.5 |
| Top scorer | 27.2 | 26.2 | 27.2 |
| Top scorer 30+ / 40+ | 35% / 5.2% | 27% / 3.1% | 31% / 5.7% |
| Double-doubles | 0.82 | 0.81 | 0.74 |

| NHL | Real | Before | Now |
| --- | --- | --- | --- |
| Penalty minutes | 9.7 | 5.6 | 9.6 |
| Power plays / goals | 2.84 / 0.60 | 2.78 / 0.60 | 2.85 / 0.59 |
| Shots / goals | 28.0 / 3.17 | 27.9 / 3.16 | 27.8 / 3.12 |

Still short: game-to-game spread of NBA minutes (starters' minutes vary about
two-thirds as much as real ones), NHL one-goal games and overtime, MLB
first-inning runs (+9%), NFL fourth-down conversions (50% vs 56%), and NFL
plays of 20+ yards (+12%).

Context effects were tested against real results before going in. Dome games
(about 2,900 NFL games since 2010, against the expected total) have 2.2 ± 0.5
more points between the two teams (the engine: +1.9); the second night of an
NBA back-to-back costs 2.0 ± 0.8 points of margin (the engine: −1.9). Left out:
NHL back-to-backs (−0.2 goals, not significant once the starting goalie is
known), cold (no effect), rest days in the NFL (0.15 points a day, not
significant). Wind is real (−0.28 points per mph above 10), but the free
schedule feed doesn't carry wind speed.

## What the simulator can't know

Today's news beyond the injury report (minutes limits, wind and rain),
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
