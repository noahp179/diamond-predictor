# Player props from the simulator: who is most likely to go over, score, or score first

Which method should rank players on each prop board: the site's own game simulator, a simpler algorithm, or a mix of the two?

The boards covered are NBA points, NHL points / goals / first goal, NFL and college touchdowns and first touchdown, and soccer goalscorers.

Every method in this note was tested the same way:
- on a season it never saw,
- with only what was known the morning of each game,
- on exactly the same players.

## The methods

**sim: the site's game simulator.** For every game, it rebuilds what the live site would have known that morning from the box scores of the games before it (`scripts/props-backtest.ts`, `props-backtest-football.ts`). That means:
- every player's season-to-date line, plus last season's;
- every team's totals and its opponents' totals;
- college's schedule-adjusted ratings.

It hands these to the same pure functions the site uses (`makeSeason`, `assembleMatchup`, `assembleFootball`) and plays the game N times. A player's probability is the share of plays in which he reached the line:

    P(line) = (plays in which he reached it) / N

**sim_cal: the simulator, calibrated.** The simulator is over-sure at the extremes (it gives a bench player 0%), so its raw share goes through an isotonic map. The map is learned on the previous season's simulations (football: cross-fitted on other weeks) and answers "of the players it gave 61%, how many did it?". The map is monotone, so it never changes the order of the list, only how honest the numbers are.

**avg: the season average.** The player's per-game average μ (this season, with up to 10 games of last season carried in) is turned into a probability:
- Poisson for hockey: `P(X ≥ k) = 1 − Σ_{j<k} e^{−μ} μ^j / j!`
- Negative binomial for basketball points: variance `μ + φμ²`, with φ fitted on the training season.

**fit: gradient-boosted trees** (sklearn `HistGradientBoostingClassifier`, isotonic-calibrated). Trained on 2024-25 player-games, using inputs known that morning:
- season, last-season, recent-weighted and last-5 averages;
- minutes / ice time, shot volume and usage;
- rest;
- home or away;
- team and opponent scoring.

**hybrid: the same trees, with the simulator's own numbers added as inputs.**

**blend: half sim_cal, half fit.**

**model: the touchdown model the site already shipped** (NFL pairwise ranker, college extra-trees), reproduced exactly on its held-out seasons by `research/football-td`.

## Results (held-out season; lower Brier = better; AUC = how well it ranks)

### NBA points: 2025-26, 33,373 player-games, 1,316 games

Each cell is Brier / the top 10 a day's hit rate.

| line | sim | **sim_cal (shipped)** | avg | fit | hybrid | blend |
|---|---|---|---|---|---|---|
| 10+ | .1439 / 92.8% | .1428 / 92.7% | .1581 / 93.6% | .1388 / 93.3% | **.1352** / 92.8% | .1363 / 93.4% |
| 15+ | .1119 / 81.9% | .1116 / 82.3% | .1221 / 82.7% | .1124 / 82.9% | **.1089** / 82.9% | .1091 / 83.2% |
| 20+ | .0742 / 65.5% | .0741 / 65.8% | .0798 / 65.6% | .0762 / 65.6% | .0766 / 65.8% | **.0733** / 66.5% |
| 25+ | .0433 / 45.5% | .0434 / 45.3% | .0467 / 44.9% | .0441 / 45.5% | .0435 / 45.4% | **.0429** / 46.1% |
| 30+ | .0232 / 26.3% | .0231 / 26.0% | .0258 / 25.9% | .0239 / 25.2% | .0243 / 25.7% | **.0229** / 26.4% |

What the board's numbers meant (sim_cal):

| line | it said | it hit |
|---|---|---|
| 20+ | 65.9% | 65.8% |
| 25+ | 44.7% | 45.3% |
| 30+ | 26.7% | 26.0% |

The season average under-says by 15 to 20 points.

**Shipped: sim_cal.**
- On every line, all six methods pick almost the same top 10 a day; their hit rates are within a point of each other.
- The calibrated simulator's stated percentages are the most honest (ECE 0.001–0.017).
- It is the best single method at 20+, 25+ and 30+.
- The blend is about 1% better on the error score. Adding it would need every player's game log at prediction time.

### NHL points, goals, first goal: 2025-26, 50,181 player-games, 1,394 games

Each cell is Brier / the top 10 a day's hit rate. For first goal it is the top pick per game.

| line | sim | **sim_cal (shipped)** | avg | fit | hybrid | blend |
|---|---|---|---|---|---|---|
| 1+ point | .2041 / 64.5% | .2041 / 64.2% | .2055 / 65.0% | .2047 / 64.3% | .2050 / 64.2% | **.2030** / 65.5% |
| 2+ points | .0750 / 29.6% | .0751 / 29.7% | .0750 / 30.0% | .0751 / 30.0% | .0751 / 29.8% | **.0748** / 31.0% |
| 1+ goal | .1201 / 35.7% | .1201 / 36.3% | .1215 / 33.5% | .1201 / 35.7% | .1200 / 34.9% | **.1197** / 36.3% |
| 1+ assist | .1709 / 48.0% | .1709 / 48.3% | .1777 / 47.1% | .1707 / 48.4% | .1709 / 48.7% | **.1700** / 49.2% |
| first goal | **.0267 / 7.6%** (shipped) | .0267 / 7.0% | .0268 / 5.9% | .0268 / 6.3% | .0268 / 5.5% | .0267 / 6.4% |

What the board's numbers meant:

| line | method | it said | it hit |
|---|---|---|---|
| 1+ point | sim_cal | 66.2% | 64.2% |
| 1+ goal | sim_cal | 35.7% | 36.3% |
| first goal | sim | 8.7% | 7.6% |

The season average over-says goals by 6 points and assists by 9.

**Shipped: sim_cal for points and goals, the raw simulator for first goal.**
- Hockey is close to a coin toss for any single skater, so every method is within a hair of the others.
- The blend is about 0.5% better, for the same reason as in basketball.
- The simulator is the only method that knows the lines, who is on the power-play units, and which goalie starts. On the first goal its top pick per game hits 7.6%, against 5.5–7.0% for every other method.
- On a typical night the first-goal favourite is 9–11%. Base rate: 2.8% for a skater.

### NFL anytime touchdown: 2025 season + 2026 to date, 364 games, 6,497 player-games

| method | Brier | AUC | top pick per game scored (said) |
|---|---|---|---|
| previous model (pairwise ranker) | .1585 | .671 | 48.9% (48.0%) |
| sim | .1588 | .693 | 50.3% (59.1%) |
| **sim_cal (shipped)** | **.1564** | .688 | **51.4% (48.9%)** |
| blend | .1562 | .691 | 49.5% |
| hybrid | .1560 | .694 | 50.0% |

The paired bootstrap over games:
- hybrid − model: Brier −0.0025 [−0.0034, −0.0015], so the simulator-based methods beat the old model.
- hybrid − sim_cal: −0.0004 [−0.0011, +0.0003], so the two are indistinguishable.

**Shipped: sim_cal.**

### NFL first touchdown (same games)

| method | Brier | AUC | top pick per game scored first (said) |
|---|---|---|---|
| **sim (shipped)** | .04704 | **.703** | **15.4% (16.4%)** |
| shipped first-TD model | .04708 | .688 | 15.1% (16.5%) |
| anytime model split by share | .04713 | .684 | 15.1% |

This is a tie on the error score; the simulator ranks better.

### College anytime touchdown: 2025-26, 1,393 games, 26,670 player-games

| method | Brier | AUC | top pick per game scored (said) |
|---|---|---|---|
| **previous model (extra-trees), kept** | .1669 | .696 | **58.1% (55.5%)** |
| sim_cal | .1712 | .672 | 51.9% |
| hybrid | .1665 | .698 | 58.4% |

The model wins clearly over the simulator. The hybrid adds 0.3 points, so the board keeps its model.

### College first touchdown (same games)

| method | Brier | AUC | top pick per game scored first (said) |
|---|---|---|---|
| **anytime model split by share (shipped)** | **.04315** | **.726** | **16.7% (14.5%)** |
| sim | .04365 | .703 | 14.4% |

The share split works like this:
- each candidate's anytime probability p becomes a touchdown rate `r = −ln(1 − p)`;
- his chance of the first touchdown is `0.97 × r / Σ r` over the game's candidates (3% of first touchdowns are defensive or return scores).

### Soccer anytime goalscorer: 5 leagues, 2025-26, 28,084 starter-matches (research/soccer-scorers)

| method | Brier | AUC | top pick per match scored (said) |
|---|---|---|---|
| shipped model (on the boards) | .0763 | .764 | 30.6% (31.1%) |
| sim (team xG × goal share) | .0767 | .760 | 30.6% (34.9%) |
| hybrid | .0757 | .770 | 30.8% |
| **gradient boosting + sim inputs** | **.0752** | **.779** | **31.7% (33.1%)** |

The boosted model is best in four of five leagues by a significant margin, but the gain is modest. It is recommended as a follow-up; the shipped model stays on the boards.

The simulator's anytime chance for a player is `1 − Σ_g P(team scores g) · (1 − s·m)^g`, where:
- s is his share of his team's goals: 180-day half-life, shrunk toward his position;
- m is his expected share of minutes.

### Soccer first goal (same matches)

| method | Brier | AUC | top pick per match scored first (said) |
|---|---|---|---|
| model, split by share | .03617 | .759 | 14.0% (13.8%) |
| sim (closed form) | .03604 | .761 | 14.0% (14.6%) |
| **hybrid_first** | **.03592** | **.770** | **14.6% (14.4%)** |

Champions League 2025-26 (189 matches): the simulator's closed form puts the actual first scorer on top 20.1% of the time.

Two problems the soccer research found in the live site, both still to fix:
- **The live model computes its features differently from how it was trained.** It uses this season only, and the player's last-seen slot (often "SUB"). Training used totals since 2021-22 and the lineup slot. Fixing that alone, with the same coefficients, takes 2025-26 log loss from .2679 to .2650 and AUC from .764 to .773.
- **The Champions League simulator under-prices every starter by about 35%.** It spreads goal shares across the whole squad, so the 11 starters' shares sum to about 0.53. Starters actually score 82% of a team's goals.

The details and every constant are in `research/soccer-scorers/README.md` and `results/backtest.json`.

## Every other market on the boards (October 2026)

The boards now price every common prop from the same simulations:

| sport | markets |
|---|---|
| NBA (49) | points, rebounds, assists, threes, Pts+Reb+Ast, Pts+Reb, Pts+Ast, Reb+Ast, double- and triple-double, steals, blocks, steals+blocks |
| NHL (15) | points, goals, assists, shots on goal, first goal, goalie saves |
| NFL (43) | receptions, receiving yards, rushing yards, carries, rush+rec yards, passing yards, TD passes, completions, anytime and first TD |

Each market was tested the same way as above:
- `evaluate_markets.py` covers NBA and NHL: train on 2024-25, test on 2025-26.
- `evaluate_nfl_props.py` covers the NFL: 2025 plus 2026 to date. Calibration is cross-fitted over five blocks of game days.
- The market list is the boards' own (`dump_markets.ts`).
- The full per-market tables are in `results/markets_tables.md`. Every number the boards print comes from `results/*_markets_backtest.json` and `nfl_props_backtest.json`.

Shared scoring lives in `marketlib.py`:
- Brier, AUC and calibration.
- How each game's top three picks did (top pick for QBs and goalies, two a game).
- Fixed ten-point confidence bands, which the Analytics pages show.
- A paired bootstrap over games.

### NBA, 2025-26 (33,373 player-games)

A selection; Brier / AUC for the board's method.

| line | player-games | board (sim) | season avg | fitted trees | blend | top 3 a game came in (said) |
|---|---|---|---|---|---|---|
| 8+ rebounds | 33,373 | 0.0763 / 0.866 | 0.0780 | 0.0764 | 0.0747 | 52.1% (54.1%) |
| 10+ rebounds | 33,373 | 0.0433 / 0.889 | 0.0444 | 0.0434 | 0.0425 | 32.9% (35.8%) |
| 6+ assists | 33,373 | 0.0609 / 0.908 | 0.0619 | 0.0613 | 0.0599 | 50.3% (48.9%) |
| 2+ threes | 33,373 | 0.1500 / 0.816 | 0.1505 | 0.1470 | 0.1457 | 67.3% (69.1%) |
| 3+ threes | 33,373 | 0.1029 / 0.822 | 0.1022 | 0.1022 | 0.1010 | 45.5% (48.0%) |
| 30+ Pts+Reb+Ast | 33,373 | 0.0693 / 0.915 | 0.0788 | 0.0703 | 0.0679 | 62.6% (64.3%) |
| 25+ Pts+Reb | 33,373 | 0.0794 / 0.901 | 0.0876 | 0.0804 | 0.0777 | 63.8% (65.8%) |
| 25+ Pts+Ast | 33,373 | 0.0627 / 0.922 | 0.0706 | 0.0638 | 0.0616 | 60.0% (60.2%) |
| 10+ Reb+Ast | 33,373 | 0.1093 / 0.862 | 0.1135 | 0.1096 | 0.1068 | 68.3% (69.4%) |
| Double-double | 33,373 | 0.0448 / 0.884 | — | 0.0452 | 0.0441 | 31.2% (34.8%) |
| 1+ steal | 33,373 | 0.2043 / 0.733 | 0.2114 | 0.2016 | 0.1996 | 71.4% (71.3%) |
| 1+ block | 33,373 | 0.1629 / 0.744 | 0.1643 | 0.1614 | 0.1598 | 61.9% (62.4%) |

Results across all 49 markets (paired bootstrap):
- **Against the season average:** the calibrated simulator is better on 39, worse on 3, and too close to call on 5.
- **Against the fitted trees:** better on 19, worse on 13, close on 17. The trees win the low lines: 4+ rebounds, 2+ assists, 1+ three, 1+ steal.
- **Against the blend:** the half-simulator, half-fitted-model blend is better on 41 of 49. It is 0.3–7% lower on Brier, and its top three a game come in 55.7% of the time against 55.1%.

That is the same finding as for points. The blend needs every player's game log at prediction time, so it stays a follow-up; the boards run the calibrated simulator.

### NHL, 2025-26 (50,181 skater-games, 2,788 goalie starts)

| line | player-games | board (sim) | season avg | fitted trees | blend | top picks came in (said) |
|---|---|---|---|---|---|---|
| 1+ assist | 50,181 | 0.1709 / 0.666 | 0.1720 | 0.1703 | 0.1698 | 46.7% (45.8%) |
| 2+ shots on goal | 50,181 | 0.2111 / 0.713 | 0.2115 | 0.2105 | 0.2096 | 76.9% (75.4%) |
| 3+ shots on goal | 50,181 | 0.1467 / 0.745 | 0.1469 | 0.1470 | 0.1459 | 55.2% (52.7%) |
| 4+ shots on goal | 50,181 | 0.0812 / 0.778 | 0.0813 | 0.0819 | 0.0811 | 34.7% (31.8%) |
| 20+ saves | 2,788 | 0.1761 / 0.648 | 0.1840 | — | — | 81.4% (80.5%), top pick |
| 25+ saves | 2,788 | 0.2334 / 0.650 | 0.2505 | — | — | 55.3% (60.7%), top pick |
| 30+ saves | 2,788 | 0.1643 / 0.660 | 0.1747 | — | — | 28.6% (28.6%), top pick |

Notes:
- **Skaters:** every method is within a hair of the others, as before.
- **Saves:** the simulator beats the season average clearly, because it knows the opponent's shot volume.
- **Starting goalie assumed known:** saves are scored on the actual starter. In the morning, the board relies on ESPN's probable goalie; a goalie who does not start is voided in the live record.

### NFL, 2025 + 2026 to date (364 games)

Against the season average, the simulator is better on 22 of 41 lines and never significantly worse.

Against the site's existing logistic prop models (`nfl-props-model.json`, the "Model props" board):
- Their predictions were reproduced exactly by `research/nfl-props/dump_shipped_preds.py`, which matches the model's selftests and `metrics.json`.
- Both were scored on the player-games both price.
- The logistic models' calibration was fitted on 2021-24, so both seasons are out of sample for them too.

| line | player-games | logistic model | simulator (board) | difference [95%] | top picks: model / sim |
|---|---|---|---|---|---|
| 3+ catches | 3,875 | 0.2025 / 0.754 | 0.2023 / 0.750 | -0.0003 [-0.0039, +0.0030] too close to call | 76.9% / 77.0% |
| 5+ catches | 3,875 | 0.1453 / 0.773 | 0.1463 / 0.766 | +0.0009 [-0.0025, +0.0042] too close to call | 46.0% / 45.8% |
| 7+ catches | 3,875 | 0.0659 / 0.827 | 0.0660 / 0.819 | +0.0001 [-0.0020, +0.0020] too close to call | 21.6% / 20.6% |
| 40+ receiving yards | 3,727 | 0.1809 / 0.767 | 0.1822 / 0.760 | +0.0012 [-0.0018, +0.0041] too close to call | 61.5% / 61.4% |
| 60+ receiving yards | 3,727 | 0.1300 / 0.781 | 0.1302 / 0.772 | +0.0002 [-0.0023, +0.0026] too close to call | 39.7% / 38.9% |
| 80+ receiving yards | 3,727 | 0.0826 / 0.798 | 0.0819 / 0.794 | -0.0007 [-0.0026, +0.0012] too close to call | 24.3% / 24.5% |
| 40+ rushing yards | 1,750 | 0.1794 / 0.795 | 0.1734 / 0.803 | -0.0060 [-0.0128, +0.0009] too close to call | 55.9% / 56.1% |
| 60+ rushing yards | 1,750 | 0.1439 / 0.795 | 0.1363 / 0.809 | -0.0076 [-0.0132, -0.0019] **simulator better** | 34.9% / 35.3% |
| 80+ rushing yards | 1,750 | 0.0981 / 0.811 | 0.0894 / 0.830 | -0.0086 [-0.0128, -0.0047] **simulator better** | 19.9% / 20.0% |
| 60+ rush+rec yards | 3,848 | 0.1716 / 0.767 | 0.1695 / 0.768 | -0.0022 [-0.0056, +0.0008] too close to call | 61.3% / 63.8% |
| 90+ rush+rec yards | 3,848 | 0.1085 / 0.788 | 0.1067 / 0.791 | -0.0018 [-0.0043, +0.0007] too close to call | 34.3% / 35.1% |
| 225+ passing yards | 612 | 0.2309 / 0.655 | 0.2420 / 0.626 | +0.0112 [-0.0007, +0.0234] too close to call | 55.6% / 54.2% |
| 275+ passing yards | 612 | 0.1769 / 0.656 | 0.1815 / 0.652 | +0.0046 [-0.0049, +0.0147] too close to call | 29.1% / 29.7% |
| 2+ TD passes | 612 | 0.2416 / 0.609 | 0.2422 / 0.598 | +0.0006 [-0.0081, +0.0090] too close to call | 49.9% / 50.4% |

Summary:
- **Rushing:** the simulator wins outright.
- **Receiving and rush+rec:** a tie.
- **Passing:** the model is slightly ahead, but not significantly. Every method ranks quarterbacks poorly (AUC about 0.6).
- **What ships:** the simulator boards are the default, and the logistic board stays available as "Model props".

### Raw or calibrated, per market

On a small market the calibration map can cost more than it fixes, so each market uses whichever of the raw and calibrated simulator scored better on held-out games. Most use the calibrated one. The exceptions:
- **NFL:** passing yards, 1+ TD pass, 22+/25+ completions.
- **NBA:** 25+ points, 8+/10+ assists, 3+ threes, 25+/30+/35+ Pts+Ast, triple-double.
- **NHL:** points, assists, 25+/30+ saves.

The maps for the original points/goals/touchdown markets are kept as published.

### The projection under each player

The simulator's own average runs a little extreme at the top. In the NFL backtest, receivers it projected for 100+ yards averaged 81.

`fit_means.py` maps each stat's simulated average to what such players actually averaged (isotonic, on every backtested game). It keeps the map only where it lowers the error among the simulator's top tenth on held-out games:
- **Kept for 20 of 24 stats.** For NFL rushing yards, for example, the top-tenth error falls from 34.1 to 32.0 and the bias from +10.5 to −4.8 yards.
- **Not used for 4:** NBA assists, NHL points, saves, and NFL completions.

The boards print this corrected projection, so it can be set against a sportsbook's line.

### Tracking and the Analytics pages

The record:
- Every market's three likeliest players in each game go into `player_predictions` before the game, one model version per market (`nba-sim-reb10-v1`, …).
- `settleSimPicks` settles them from the ESPN box score, reading every stat; `scripts/test-sim-settle.ts` checks it against the backtest data.
- A player who did not appear is a void.

Analytics:
- Props › Analytics shows, for every market, how often its numbers came true in each ten-point confidence band.
- It shows the backtest above, and the live record (the `sim_prop_bands` view) as it fills.

## How many plays

The boards play each game up to **100,000** times. Scheduled jobs (`/api/public/hooks/sim-props`) do it a few games at a time, inside Vercel's 300-second function limit.

The backtest seasons were played 1,000 times a game. `runs_study.py` replays 66 NBA games from 2025-26 (every 20th) at 1,000, 10,000 and 100,000 plays, with the same inputs each time:

| line | 1k vs 100k: mean gap (95th pct) | 10k vs 100k: mean gap (95th pct) | Brier 1k / 10k / 100k | top 3 per game same as 100k: 1k / 10k |
|---|---|---|---|---|
| 10+ | 0.9 pts (2.5) | 0.3 pts (0.8) | .14223 / .14219 / .14213 | 97% / 99% |
| 15+ | 0.9 (2.3) | 0.3 (0.7) | .11917 / .11894 / .11890 | 97% / 98% |
| 20+ | 0.8 (2.3) | 0.2 (0.7) | .07291 / .07280 / .07276 | 99% / 99% |
| 25+ | 0.7 (2.0) | 0.2 (0.6) | .04576 / .04575 / .04573 | 99% / 99% |
| 30+ | 0.7 (2.1) | 0.2 (0.5) | .02346 / .02342 / .02339 | 97% / 100% |

The gap is in percentage points.
- At 1,000 plays a player's number is off by about 0.8 points, and up to 2.5.
- At 100,000 it is settled to about 0.15 points: the standard error is `√(p(1−p)/N)`, at most 0.16 points.
- Accuracy improves at every line, but only in the fourth decimal.
- A few of each game's top three swap places.

So the extra plays sharpen the numbers, not the order. The backtest's 1,000-play results are a fair, slightly pessimistic stand-in for the boards' 100,000.

The soccer research checked the same thing on its engine (`research/soccer-scorers`):
- At 1,000 plays, the first-goal favourite changed in 8–15% of matches.
- At 100,000 plays it matched the closed form in 98.5–99%.

## Files

- `fetch_espn.py`, `fetch_first_goal.py`, `fetch_positions.py`: data (gitignored under `data/`).
- `asof.py`: what was known each morning.
- `evaluate.py` (NBA, NHL), `evaluate_football.py` (NFL, college): the comparisons.
- `export_calibration.py` → `src/lib/sim-props-calibration.json`.
- `export_backtest_summary.py` → `src/lib/sim-props-backtest.json` (what the boards print).
- `runs_study.py`: 1k vs 10k vs 100k plays.
- `evaluate_markets.py`, `evaluate_nfl_props.py`, `marketlib.py`, `dump_markets.ts`, `tables_markets.py`: every market on the boards.
- `fit_means.py`: the corrected projections.
- `season_to_date.py`: this season's games already played, replayed as the boards would have called them (calibration from earlier seasons only) → `src/lib/sim-props-season.json`, the "This season" view on the Analytics pages.

## October 2026: factor tests and the upgraded simulators

Every factor the data allows was tested one at a time, combined, and checked
on a season none of the choices were made on. Full tables:
`NBA_FACTORS.md` (NBA) and `CFB_FACTORS.md` (college).

- **NBA, 2025-26 held out:** error −3.05% across all 49 markets (49 better,
  0 worse). Kept: recent minutes, recent per-minute rates, shot zones from
  play-by-play, the betting total and spread. Also shipped, untestable on
  past games: questionable players drawn per game, and a re-run before
  tip-off when the injury news changes.
- **College, 2026 to date held out:** error −2.49% across all 42 markets
  (42 better, 0 worse). Kept: recent usage, starters sitting in blowouts, the
  betting total and spread.
- **The blend** (half simulator, half gradient-boosted trees), 2% better than
  the old simulator, is 0.4% better than the new one, and the trees alone are
  now 3.5% worse; it stays unshipped.

The production replays (`data/sim_nba_*`, `data/sim_cfb_*`), calibration maps,
projection maps and every backtest file were regenerated with the upgraded
simulators. `export_upgrade.py` writes the before/after table the Analytics
pages show.
