# MLB prop boards in the playoffs

The prop models were fitted on the regular season. From October 2026 the boards
also price playoff games, so this replays the boards' own code on every playoff
game of 2024, 2025 and 2026 so far — 120 games — and grades
every price against the box score.

    FORM=all DATES=post npx tsx scripts/backtest-mlb-postseason.ts            # raw prices
    FORM=regular DATES=post npx tsx scripts/backtest-mlb-postseason.ts        # form from regular season only
    FORM=all DATES=sept npx tsx scripts/backtest-mlb-postseason.ts            # September 2026 baseline
    python3 research/mlb-props/postseason_shift.py                            # the playoff correction
    SHIFT=on FORM=all DATES=post npx tsx scripts/backtest-mlb-postseason.ts   # prices as shipped

Everything is as of the morning of each game: game logs cut at the date,
MLB's listed lineups and probable starters, and the regular season — over
before the first playoff game — for the season-level numbers. The September
baseline runs through the same harness (184 games), so the
two are like for like. (The shipped models were refitted through 2026, so
September is in-sample; the playoffs never were.)

## Every market

"Said" is the average price, "came in" the hit rate. Brier is compared with
always quoting the market's regular-season base rate.

| market | playoff games: priced | said | came in | as shipped: said | Brier (base rate) | September 2026: said | came in |
|---|---|---|---|---|---|---|---|
| 1+ hits | 720 | 65.2% | 64.2% | 65.2% | 0.2286 (0.2308) | 66.6% | 66.2% |
| 2+ hits | 720 | 25.1% | 24.2% | 25.1% | 0.1829 (0.1838) | 26.6% | 27.1% |
| 3+ hits | 720 | 5.8% | 6.2% | 5.8% | 0.0586 (0.0588) | 6.4% | 6.9% |
| 4+ hits | 720 | 0.8% | 0.8% | 0.8% | 0.0083 (0.0083) | 0.9% | 1.1% |
| 2+ total bases | 720 | 40.0% | 38.8% | 40.0% | 0.2342 (0.2384) | 41.0% | 41.4% |
| 3+ total bases | 720 | 25.2% | 23.3% | 25.2% | 0.1785 (0.1796) | 25.5% | 26.5% |
| 4+ total bases | 720 | 19.7% | 17.5% | 19.7% | 0.1427 (0.1453) | 18.9% | 19.8% |
| 5+ total bases | 720 | 9.7% | 9.2% | 9.7% | 0.0829 (0.0838) | 9.4% | 8.7% |
| 1+ home run | 720 | 17.2% | 16.7% | 17.2% | 0.1367 (0.1415) | 15.8% | 16.6% |
| 1+ RBI | 720 | 33.3% | 33.3% | 33.3% | 0.2204 (0.2237) | 33.9% | 36.4% |
| 1+ run | 720 | 43.0% | 42.2% | 43.0% | 0.2414 (0.2460) | 44.3% | 45.8% |
| 1+ stolen base | 720 | 11.3% | 10.8% | 11.3% | 0.0963 (0.0982) | 11.3% | 12.0% |
| 5+ strikeouts | 234 | 57.4% | 46.2% | 47.8% | 0.1975 (0.2527) | 50.5% | 49.0% |
| 6+ strikeouts | 234 | 43.8% | 35.9% | 34.8% | 0.1916 (0.2303) | 37.2% | 34.4% |
| 7+ strikeouts | 234 | 29.6% | 22.6% | 22.1% | 0.1491 (0.1754) | 23.7% | 23.9% |
| 2+ bases board (every hitter) | 2,158 | 33.7% | 31.6% | 33.7% | 0.2125 (0.2160) | 34.5% | 35.5% |
| Team over 3.5 runs | 240 | 53.0% | 47.1% | 47.8% | 0.2471 (0.2491) | 56.2% | 59.8% |
| Team over 4.5 runs | 240 | 39.7% | 35.4% | 34.8% | 0.2261 (0.2287) | 43.2% | 46.2% |
| Team over 5.5 runs | 240 | 29.8% | 25.8% | 25.7% | 0.1887 (0.1916) | 32.5% | 34.2% |

## What changed for October

**Recent form counts playoff games.** The model learned a 30-day window that
holds every game a player played. Read from the regular season alone, in
October that window is two weeks old and half empty, and a Game 4 starter looks
a month rested. Against the same replay with regular-season form only
(`FORM=regular`), counting the playoff games is as good on the hitters, better
calibrated on team runs (over 4.5 said 39.7% against 42.0%; 35.4% came in), and
the 2+ bases board's top three a game came in 43.1% against 40.6%.

**A playoff correction for two groups.** Starter strikeouts ran 7–11 points
high (playoff starters are pulled sooner) and team totals 4–6 points high
(October runs are scarcer). Each group gets one log-odds shift for playoff
games. It is checked by fitting on 2024–25 and scoring 2026, which it never
saw; a group ships a shift only if that check calls for one and it helps 2026.

| group | shift fitted on 2024–25 | 2026 came in | 2026 said, raw → adjusted | 2026 Brier, raw → adjusted | ships |
|---|---|---|---|---|---|
| Starter strikeouts (5+/6+/7+) | -0.468 | 36.8% | 44.2% → 35.4% | 0.1724 → 0.1681 | -0.449 |
| Team runs (over 3.5/4.5/5.5) | -0.103 | 27.2% | 39.1% → 36.8% | 0.2047 → 0.1997 | -0.211 |
| Hitter props (12 markets) | +0.008 | 20.4% | 23.7% → 23.8% | 0.1369 → 0.1370 | +0.000 |
| 2+ bases board | -0.048 | 26.9% | 32.1% → 31.1% | 0.1987 → 0.1977 | +0.000 |

The hitters and the 2+ bases board need no correction on 2024–25; their drift
in 2026 is one low-scoring October so far, which is not a pattern to price.
Regular-season prices are untouched.
