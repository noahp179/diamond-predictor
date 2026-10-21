# College football simulator — factors tested (October 2026)

The college boards run the football engine (`src/lib/sim/nfl.ts`, league
"cfb"). Its optional factors live in `src/lib/sim/football-knobs.ts`; each was
switched on alone in the props backtest (`scripts/props-backtest-football.ts`,
`FB_KNOBS`) on the 2025 season — 958 games, 19,481 player-games, every
yardage, catch, carry and passing line on the boards plus anytime touchdown
(42 markets), 300 plays a game — and scored by `cfb_factor_eval.py`:
calibrated Brier (cross-fitted over five blocks of game days), the average
relative change, and a paired bootstrap over games. The winners were then
checked on **2026 to date (512 games), which no choice was made on**.

## One at a time, 2025

| factor | change in error | 95% range | better / worse | kept |
|---|---|---|---|---|
| Recent usage (targets, carries), 25% | −0.56% | −0.71, −0.42 | 33 / 6 | |
| Recent usage, 50% | −0.87% | −1.09, −0.66 | 36 / 6 | |
| **Recent usage, 75%** (last four appearances, half-life 2) | **−1.05%** | −1.34, −0.77 | 34 / 8 | ✅ |
| Recent usage, 100% | −1.00% | −1.36, −0.66 | 30 / 7 | |
| … half-life 1 / 4 games | −0.96% / −0.92% | | | |
| Starters sit when up 21 / 28 / 35 (leader only) | +0.06% / −0.03% / −0.02% | | | |
| Starters sit when 21 / **28** / 35 apart (both sides) | −0.24% / **−0.19%** / −0.09% | −0.34, −0.05 at 28 | 20 / 16 | ✅ (28) |
| … sitting starters keep half their work | +0.01% | | | |
| Bye week (+3% offense) | +0.02% | | | ✗ |
| Short week (−3% offense) | 0.00% | | | ✗ |
| Target concentration 1.3 / 1.7 (now 1.5) | −0.05% / −0.04% | | | ✗ |
| Carry concentration 1.4 / 1.8 (now 1.6) | +0.04% / +0.06% | | | ✗ |
| Game-to-game form 0.07 / 0.11 (now 0.09) | +0.07% / −0.03% | | | ✗ |

Combined on 2025: recent usage 75% + blowouts at 28, both sides: **−1.26%**
(36 better, 5 worse); with recent usage at 100%: −1.22%.

## Held out: 2026 to date (512 games, 10,198 player-games)

| | change in error | 95% range | better / worse |
|---|---|---|---|
| Upgraded simulator | −1.12% | −1.54, −0.70 | 38 / 3 |
| + betting total and spread, half weight | −1.93% | −2.39, −1.49 | 42 / 0 |
| **+ betting total and spread, full weight (shipped)** | **−2.49%** | −3.14, −1.89 | **42 / 0** |

ESPN kept lines for every 2026 game (and 101 of 2025's), so the market's
weight was chosen on 2026; by half of the season its gain over the upgraded
simulator was −1.73% and −1.33%, both significant. The market matters far
more in college than in the NBA: one team rating has to cover 130 FBS teams
and their FCS opponents, and the line knows about mismatches the rating
misses. Passing-yards error fell from 63.9 to 61.6 yards a quarterback.

Not testable: weather (ESPN keeps none for college games), depth charts and
injury reports (not archived).
