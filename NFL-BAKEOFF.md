# The NFL touchdown bake-off

Twenty-four models, one question: of the names on a game's card, which is
likeliest to score a touchdown?

The college board went through this exercise first and extra trees won. The NFL
board did not inherit that answer, and it should not have: the NFL feature set
carries three market-derived features college has none of, and the NFL sample is
a fifth the size. Both cut against the flexible models. The run was repeated from
scratch.

**The result: a within-game pairwise ranker, now live.** It picks the right name
in **49.2%** of games it was not fitted on, against **44.9%** for the logistic it
replaced. It is eighteen coefficients and 3.9 KB.

---

## 1. The headline number was a random seed

The first run produced a clean-looking leaderboard on per-game top-1:

| model | top-1 |
|---|---|
| hist gradient boosting | **49.5%** |
| neural net (64,32) | 48.8% |
| within-game pairwise ranker | 48.5% |
| random forest | 48.2% |
| extra trees | 46.8% |
| logistic L2 (shipped) | 44.9% |

Hist gradient boosting by 4.6 points. Shipping that would have been a mistake.

Every one of those models except the ranker carries a `random_state`. Refitting
the four stochastic ones under ten seeds, changing nothing else:

| model | seed 0 | 10-seed mean | min | max | sd |
|---|---|---|---|---|---|
| hist gradient boosting | 49.5% | **45.3%** | 42.5% | 49.5% | 1.71 |
| neural net (64,32) | 48.8% | 46.2% | 42.9% | 49.5% | 2.12 |
| random forest | 48.2% | 47.1% | 46.2% | 48.2% | 0.61 |
| extra trees | 46.8% | 46.1% | 45.2% | 46.8% | 0.60 |

Seed 0 was the **maximum of ten** for hist gradient boosting. Its honest mean is
45.3%, four tenths of a point over the model it would have replaced, and its
worst seed loses to it outright. The 49.5% was a `random_state`, reported to four
significant figures.

The neural net is the same story with a wider spread. Random forest and extra
trees are stable, and correspondingly much less exciting.

## 2. What survived the statistics

Each model was compared to the shipped logistic with a paired bootstrap that
resamples **whole slates**, not games — games in one week share the week and the
state of every team's usage sample, so treating 301 games as 301 independent
trials overstates the precision.

| model | top-1 | diff | 95% CI | P(better) |
|---|---|---|---|---|
| hist gradient boosting | 49.5% | +4.6 | [+0.0, +8.8] | 0.97 |
| neural net (64,32) | 48.8% | +4.0 | [+0.0, +8.2] | 0.96 |
| **within-game pairwise ranker** | 48.5% | **+3.7** | **[+0.9, +6.6]** | **0.99** |
| random forest | 48.2% | +3.2 | [−1.4, +7.6] | 0.91 |
| extra trees | 46.8% | +2.0 | [−1.4, +5.3] | 0.86 |

**One of twenty-four had an interval excluding zero**, and it was not the one
with the biggest gap. McNemar on the champion agreed: 30 games to 16 on the
disagreements, two-sided p = 0.054 — suggestive, not conclusive.

The ranker is also the only strong model with no `random_state` in its
architecture. It does sample which pairs it trains on, so the same suspicion
applies and was tested: over **20 seeds, mean 48.87%, min 47.5%, sd 0.51**. The
worst sample it ever drew still beats the shipped logistic by 2.6 points.
Averaging the weight vectors over those 20 samples — no single sample is
privileged — gives **49.17%**, and that is what ships.

## 3. Five metrics, five different winners

Ranking on one number would have picked a different model each time:

| metric | winner | value |
|---|---|---|
| AUC | hierarchical team × share | 0.6895 |
| log loss | hierarchical team × share | 0.4851 |
| ECE | *control: random* | 0.0045 |
| top-1 per game | hist gradient boosting (seed 0) | 49.5% |
| 5-leg parlay | within-game pairwise ranker | 10.5% |

The ECE row is the joke that makes the point. A model that predicts the base rate
for every player is perfectly calibrated and completely useless — it cannot order
two names. Best among models that actually discriminate: calibrated boosting
0.009, random forest 0.011.

The AUC row matters more. **The shipped ranker has the LOWER AUC** — 0.675 against
the logistic's 0.688 — and the higher top-1. That is not an anomaly to explain
away. It is the mechanism, and it is the whole argument.

## 4. Why a ranker should win, mechanically

Both models are linear: a weight vector over the same eighteen features. The only
difference is which direction they fit.

- **Logistic** maximises the likelihood of `scored` over all 20,379 training rows
  pooled together. It is rewarded for separating a workhorse back from a
  third-string receiver — a comparison the board never makes, because those two
  never appear on the same card.
- **Ranker** trains on the *difference* between two players **in the same game**,
  one who scored and one who did not, with no intercept (a difference of zero
  must give even odds). Every training example is the exact comparison the card
  makes.

So the ranker should be worse at ordering the global field and better at ordering
within a game. AUC measures the first; the board shows the second. It gives up
the metric nobody reads to win the one on the screen.

The pair cap confirms this is doing real work rather than adding noise. Capping at
four scorers × four non-scorers per game scores 49.10%; lifting the cap to 8×8
drops to 45.32%, and uncapped to 45.51%. Without a cap a five-touchdown rout
supplies a disproportionate share of the training pairs and the fit starts
learning about blowouts instead of about players. Regularisation strength barely
registers — the pairwise problem is well conditioned.

## 5. Making a ranker state a probability

A ranker emits an unbounded score, and the card sells a percentage per leg. Two
monotone steps convert it, and monotone is the point: neither can reorder a card,
so calibration can never change a pick.

**Platt** (`p = sigmoid(a·s + b)`), fitted on a held-back tail of the training
seasons the ranker inside it never saw. This left the *overall* calibration good
— ECE 0.0144, 5,322 distinct probabilities, no collapse into ties — but the lead
picks, the one number in large type, still said 55.1% and hit 49.2%.

Six points of overstatement is not shippable, but "the ranker is over-confident"
is only a finding if what it replaces is not:

| | lead picks stated | actual | gap |
|---|---|---|---|
| logistic L2 (shipped) | 53.8% | 44.9% | **−8.9** |
| pairwise ranker, Platt only | 55.1% | 49.2% | −5.9 |
| ranker, oracle Platt fitted on the test seasons | 51.1% | 49.2% | −2.0 |

The board being replaced overstated its leads by nearly nine points. The
overstatement is a property of the feature set, not of the ranker. And the oracle
row — a calibrator fitted on the answer, which no deployment can have — still
leaves 2 points, so roughly a third is the logistic link's shape in the tail and
the rest is season-to-season drift.

A quadratic-in-score calibrator closed the gap to −0.9 but **is not monotone** over
the observed score range, so it could reorder a card. Rejected on that ground
alone, not on its numbers. A cubic is monotone and closes it to −1.2, at a
slightly worse ECE.

What shipped instead is blunter and safer: **blend 20% toward the base rate.**
Monotone by construction, so it provably cannot change a single pick — it only
changes what the board *claims*, which is the part that was wrong.

The 0.20 was **not** read off the test seasons. Rolling-origin inside the training
seasons (fit 2021 → judge 2022, fit 2021-22 → judge 2023, fit 2021-23 → judge
2024) gave per-season lead gaps of −12.9, +3.9, −11.0 at zero shrink. The sign
flips, so minimising *mean absolute* gap just trades the one good season away and
runs to whatever the grid edge is. The right target is the **signed** bias, and
0.20 zeroes it (mean −0.23 across the three splits).

On the test seasons, consulted once, afterwards: **stated 48.3%, actual 49.2%** —
a point of *under*statement, the safe direction for a parlay.

## 6. What shipped

Fitted on 2021-24, judged on 2025-26, which that fit never saw:

| | ranker | logistic (replaced) |
|---|---|---|
| top-1 per game | **49.2%** (148/301) | 44.9% |
| lead picks stated vs actual | 48.3% / 49.2% | 53.8% / 44.9% |
| AUC | 0.6751 | 0.6875 |
| log loss | 0.4909 | 0.4865 |
| ECE | 0.0195 | 0.018 |

It loses on AUC and log loss, wins by 4.3 points on the only question the board
asks, and tells the truth about itself where the old model was nine points brave.

Largest weights, in standardised units: carries per game (+0.327), targets per
game (+0.292), home (+0.227), rushing yards per game (+0.163), games played
(+0.117). Volume, then venue.

One weight is worth singling out. **The game total's coefficient is exactly
zero** — not small, zero. It is constant within a game (all 1,424 of them), so it
cancels identically in every training pair, and the fit cannot identify it at
all. The formulation discards it automatically. The market's other two features
are not constant within a game and do carry weight: the implied *team* total
(+0.071) and the team's *margin* (+0.086) differ by side, and only those can say
which side will be doing the scoring.

This is worth noticing because it is the pairwise formulation auditing the
feature set for free. A pooled classifier will happily fit a coefficient to the
game total and be rewarded for it in training, because across games a 54-point
total really does mean more touchdowns than a 38-point one. That coefficient then
does nothing on the board except add noise, because the board only ever compares
players who share a total.

## 7. Everything downstream had to be re-measured

A model swap is not a weight swap. Four constants described the logistic and
would have silently gone on describing it.

**Per-pair correlation.** Re-measured under the ranker. The different-games
control came in at **1.015** — the closest to exactly independent either board has
produced, which is what makes the other two readable.

| pair type | college | NFL |
|---|---|---|
| same team | 0.842 | 0.826 |
| same game, opposed | **0.758** | **0.883** |

The same-team penalties agree almost exactly: two backs splitting one goal line is
the same problem in both codes. The opposed factors do not, and the gap is large.
Two scorers on opposite sides of a *college* game are strongly anti-correlated,
because college games are decided by blowouts and a blowout is one team scoring
five times and the other none. NFL games stay close, both offences keep taking
meaningful snaps, and the penalty is correspondingly milder. Applying college's
0.758 to an NFL slip under-prices every opposed pair on the card.

**Selection floors.** A floor is a threshold on a *scale*, and the scale moved —
the shrunk ranker tops out near 0.70 where the logistic reached 0.82. Carrying
0.55 across did not keep the bar the same, it raised it, and the board emptied:
nineteen buildable five-leg weeks became four, and fifteen and twenty legs became
unbuildable outright. Re-derived on the training seasons as the highest floor at
each size that still fills 70% of the weeks with enough games to fill it at all:

| legs | old | new | leg hit rate |
|---|---|---|---|
| 5 | 0.55 | 0.45 | 55.2% |
| 10 | 0.45 | 0.40 | 52.1% |
| 15 | 0.45 | 0.35 | 48.8% |
| 20 | 0.45 | 0.30 | 45.7% |

**Parlay claims**, rebuilt on the held-out seasons the way the board builds one:

| legs | stated | 1 in | weeks | won | expected |
|---|---|---|---|---|---|
| 5 | 6.32% | 16 | 19 | 2 | 1.20 |
| 10 | 0.121% | 823 | 19 | 0 | 0.02 |
| 15 | 0.00096% | 104,148 | 19 | 0 | 0.00 |
| 20 | 0.0000036% | 27,700,328 | 18 | 0 | 0.00 |

## 8. A test that was quietly wrong

Making the floors per-sport surfaced a bug in the parlay test, not in the builder.
The test allowed the one-per-game cap to be exceeded only when
`size > gamesAvailable × cap`. The binding constraint is not how many games are on
the slate — it is how many have a candidate **clearing that size's floor**. Those
are the same number on a Saturday, where fifty games make the floor irrelevant at
any size. On an NFL Sunday they are not: fourteen games, but only nine with a pick
over a ten-leg slip's 0.40 floor. The builder correctly doubled up; the test
called it a violation. Fixed to count games over the floor.

## 9. Reproducing it

```
research/nfl-td-scorer/
  fetch_nfl.py       nflverse schedule + market lines, ESPN box scores
  features_nfl.py    point-in-time features, mirroring nfl-td.server.ts exactly
  bakeoff_nfl.py     the 24 models, five metrics
  bakeoff_nfl_sig.py slate bootstrap, McNemar, per-season, seed sweep
  rank_study.py      ranker seed stability, pair-cap grid, calibration
  calib_study.py     is the overstatement the link or the drift?
  shrink_pick.py     rolling-origin selection of the shrink
  floor_pick.py      re-derived selection floors
  export_ranker.py   the shipped fit + every downstream constant, in one pass
  parity.py          500 Python-scored vectors for the TypeScript port
```

`bun scripts/test-nfl-ranker.ts` holds the TypeScript port to those 500 vectors.
Worst disagreement: **1.67e-16**.

The three vectors baked into the artefact would catch a gross wiring error but not
a subtle one — two adjacent features transposed can still reproduce three rows by
coincidence, and every page downstream then shows plausible percentages with
nothing to flag them. 500 rows spanning the probability range do not have that
escape, and the feature *order* is checked explicitly rather than inferred from
the probabilities agreeing.
