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

## How many plays

The boards play each game up to **100,000** times. Scheduled jobs (`/api/public/hooks/sim-props`) do it a few games at a time, inside Vercel's 300-second function limit. The backtest seasons were played 1,000 times a game; `runs_study.py` replays a sample at 1,000, 10,000 and 100,000 to show what the extra plays change (results in `results/*_runs_study.json`).

## Files

- `fetch_espn.py`, `fetch_first_goal.py`, `fetch_positions.py`: data (gitignored under `data/`).
- `asof.py`: what was known each morning.
- `evaluate.py` (NBA, NHL), `evaluate_football.py` (NFL, college): the comparisons.
- `export_calibration.py` → `src/lib/sim-props-calibration.json`.
- `export_backtest_summary.py` → `src/lib/sim-props-backtest.json` (what the boards print).
- `runs_study.py`: 1k vs 10k vs 100k plays.
