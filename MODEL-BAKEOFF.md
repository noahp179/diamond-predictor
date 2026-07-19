# Model bake-off — "try everything," ranked by winning percentage

_Run `npx tsx scripts/model-bakeoff.ts [nba|nfl|both]`. Walk-forward over the
full odds datasets (23,403 NBA games 2008–2026, 5,254 NFL games 2006–2025),
every strategy scored purely on **how often its pick wins**. No money, no ROI._

This is the "throw everything at it" run: rating systems, market-derived picks,
the heuristics bettors actually use, a few out-of-the-box ideas, ensembles, and
— the important part — **selective conviction strategies** that only pick when
the signals line up. Two kinds of strategy:

- **FULL** — commits a pick on _every_ game. This is a pure "who's better"
  contest, and the honest answer (again) is _nobody beats the market_.
- **SELECTIVE** — only picks games that clear a conviction bar (agreement,
  confidence, heavy favorite…). Reported with **coverage** = the share of games
  it acts on. **This is the real lever for maximizing your hit rate.**

## The one-paragraph answer

**If you pick every game, ~66% (NBA) / ~64% (NFL) is the ceiling for any model,
and the market's ~68.5% / ~66.4% beats all of them.** Twenty-plus models, every
ensemble, every heuristic — none clears the line. **But you don't have to pick
every game.** Filter to the high-conviction spots and the win rate climbs
hard: **~75% at loose filters, ~80–83% at tight ones, and ~86% on the heaviest
favorites** — in both sports. The trade is volume: the 86% strategy only fires
on ~12–20% of games. That's the whole game — _pick fewer, hit more._

## FULL strategies — pick every game (win %, vs. the market)

**NBA** (market favorite = 68.5%)

| Strategy                                              | Win %     | vs mkt |
| ----------------------------------------------------- | --------- | ------ |
| **market (devig moneyline)**                          | **68.5%** | —      |
| blend (model × market)                                | 68.5%     | −0.0   |
| closing spread                                        | 68.0%     | −0.6   |
| consensus of elo+srs+market                           | 67.6%     | −0.9   |
| majority vote (all models+market)                     | 67.0%     | −1.6   |
| ensemble mean · conf-weighted ensemble                | 66.6%     | −2.0   |
| stacked logistic                                      | 66.4%     | −2.1   |
| SRS ridge · offense/defense · elo-rest                | 66.3%     | −2.2   |
| Elo (MOV) · Glicko-2 · multiscale Elo · Bradley-Terry | 66.1%     | −2.5   |
| Pythagorean                                           | 65.8%     | −2.7   |
| better season record                                  | 64.0%     | −4.5   |
| hotter last-10                                        | 62.2%     | −6.3   |
| always home                                           | 58.2%     | −10.4  |
| longer win streak                                     | 57.4%     | −11.2  |
| more rest                                             | 56.6%     | −12.0  |

**NFL** (market favorite = 66.4%)

| Strategy                                      | Win %     | vs mkt     |
| --------------------------------------------- | --------- | ---------- |
| **market (devig moneyline)**                  | **66.4%** | —          |
| closing spread                                | 66.4%     | −0.0       |
| blend (model × market)                        | 66.3%     | −0.1       |
| consensus of elo+srs+market                   | 65.9%     | −0.5       |
| majority vote                                 | 64.8%     | −1.6       |
| SRS ridge · offense/defense                   | 64.5%     | −1.9       |
| stacked logistic · multiscale Elo · ensembles | 64.4%     | −2.0       |
| Elo (MOV) · elo-rest · Bradley-Terry          | 64.1%     | −2.3       |
| Glicko-2                                      | 63.1%     | −3.3       |
| Pythagorean                                   | 62.5%     | −3.9       |
| better season record                          | 61.6%     | −4.8       |
| hotter last-10                                | 61.2%     | −5.2       |
| longer win streak                             | 58.9%     | −7.5       |
| always home · more rest                       | ~55%      | −10 to −12 |

**Read:** the score-based rating models all cluster tightly (~66% NBA / ~64%
NFL) — Elo, SRS, offense/defense, Glicko, Bradley-Terry, Pythagorean are within
~1 point of each other, so _which_ rating math you use barely matters. Fancy
combinations (stacked logistic, gradient-boosted stacker, confidence-weighted
ensemble, majority vote) don't beat a plain average, and the plain average
doesn't beat the market. Pure heuristics (rest, streaks, home, form) are
clearly worse — the rating models already contain what little signal those
carry. **Blending a model into the market just reproduces the market.**

## SELECTIVE strategies — pick only high-conviction games (the win-rate lever)

**NBA**

| Strategy                                | Win %     | Games  | Coverage |
| --------------------------------------- | --------- | ------ | -------- |
| **market favorite ≥ 80%**               | **86.0%** | 4,607  | 20%      |
| blend confidence ≥ 75%                  | 83.5%     | 6,895  | 29%      |
| model & market agree, market conf ≥ 75% | 83.2%     | 7,065  | 30%      |
| market favorite ≥ 75%                   | 83.2%     | 7,158  | 31%      |
| model confidence ≥ 75%                  | 81.1%     | 6,000  | 26%      |
| blend confidence ≥ 70%                  | 80.3%     | 9,898  | 42%      |
| market favorite ≥ 70%                   | 80.0%     | 10,128 | 43%      |
| model confidence ≥ 70%                  | 78.0%     | 8,927  | 38%      |
| agree, market conf ≥ 65%                | 76.8%     | 12,949 | 55%      |
| model confidence ≥ 65%                  | 74.9%     | 12,335 | 53%      |
| elo + spread + market all agree         | 70.3%     | 19,784 | 85%      |
| model & market agree                    | 70.1%     | 20,155 | 86%      |
| all rating models agree                 | 69.7%     | 18,735 | 80%      |

**NFL**

| Strategy                                | Win %     | Games | Coverage |
| --------------------------------------- | --------- | ----- | -------- |
| **market favorite ≥ 80%**               | **86.0%** | 607   | 12%      |
| market favorite ≥ 75%                   | 82.2%     | 1,192 | 23%      |
| model & market agree, market conf ≥ 75% | 82.1%     | 1,180 | 22%      |
| blend confidence ≥ 75%                  | 82.1%     | 1,072 | 20%      |
| model confidence ≥ 75%                  | 82.0%     | 822   | 16%      |
| blend confidence ≥ 70%                  | 79.7%     | 1,803 | 34%      |
| market favorite ≥ 70%                   | 78.9%     | 1,944 | 37%      |
| model confidence ≥ 70%                  | 77.8%     | 1,444 | 27%      |
| blend confidence ≥ 65%                  | 76.0%     | 2,630 | 50%      |
| model confidence ≥ 65%                  | 74.0%     | 2,206 | 42%      |
| all rating models agree                 | 68.2%     | 3,639 | 69%      |
| elo + spread + market all agree         | 67.8%     | 4,488 | 85%      |
| model & market agree                    | 67.8%     | 4,503 | 86%      |

**Read:** this is the answer to "maximize my chances." A clean menu by appetite:

- **Want volume?** "Model & market agree" fires on **86%** of games and wins
  **70% (NBA) / 68% (NFL)** — a couple points better than picking blindly,
  because it skips the coin-flip games where the two disagree.
- **Want a strong balance?** "Confidence ≥ 70%" fires on ~35–43% of games at
  **~78–80%**.
- **Want the safest?** "Market favorite ≥ 80%" wins **86%** in both sports, but
  only ~12–20% of games qualify.

## The honest catch (important)

**Selectivity raising your hit rate is _not_ the model beating the market.** On
the games where the model and market agree, the market _by itself_ also scores
~70% — because you've thrown out the hard coin-flip games, which lifts _both_.
The confident buckets win ~80–86% for the same reason the market's own 80%
favorites win ~86%: heavy favorites just win a lot. So:

- These are **"safest picks" filters, not an edge.** They tell you _which games
  to trust_, not how to beat the book's price. At the moneyline you still pay
  the favorite's premium.
- The heaviest-favorite strategies (86%) are also the ones the whole world
  agrees on, so the payout is smallest.
- The 20-plus FULL strategies confirm what the full study found three times
  over: **no public-data model beats the market straight-up.** The ~2-point gap
  is the injury/lineup news the line prices and end-of-day data can't see.

## What was tried (the full menu)

- **Rating systems:** Elo (margin-of-victory), basic Elo, rest/short-week Elo,
  a **multi-timescale Elo** (fast⊕slow blend, novel), Glicko-2, Pythagorean +
  log5, SRS ridge margin ratings, an offense/defense points model, Bradley-Terry.
- **Market-derived:** devigged moneyline, closing spread → probability.
- **Ensembles:** logit-mean, majority vote, model×market blend, a 3-way
  consensus, a **confidence-weighted ensemble** (each model weighted by its own
  trailing accuracy, novel), a walk-forward **stacked logistic**, and a
  **gradient-boosted stacker**.
- **Bettor heuristics:** always-home, always-favorite, better record, hotter
  last-10, longer win streak, more rest, a rest-aware home rule.
- **Selective/novel:** model–market agreement, triple agreement (elo+spread+
  moneyline), unanimous rating models, model/market/blend confidence gates,
  heavy-favorite gates, "agree **and** the pick isn't on a rest deficit"
  (novel), and "market favorite **and** the model is _even more_ confident"
  (novel).

## Recommendation

For the product, the actionable output is the **selective** menu, not a new
headline model:

1. Keep the Elo model as the engine (it's at the ~66%/64% frontier and
   self-calibrates), and keep showing the market beside it.
2. On **Recommended / Best Odds**, surface a confidence tier so users can pick
   their appetite — e.g. badge picks as _Safe_ (≥80% → ~86% historical),
   _Strong_ (≥70% → ~78–80%), _Lean_ (agree → ~70%). That converts this
   backtest directly into a feature.
3. Don't ship any "beats the market" claim — nothing here does, and the
   selective win rates are a _game-selection_ effect, stated honestly.

_(Reproduce: `npx tsx scripts/model-bakeoff.ts`. Companion:
`ACCURACY-BACKTEST.md` for the model-vs-market head-to-head, `NBA-NFL-ANALYSIS.md`
for the full research program.)_
