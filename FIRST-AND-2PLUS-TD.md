# Two narrow touchdown markets

The NFL board now answers three questions off the same eighteen features:
**anytime**, **the game's first touchdown**, and **two or more**. The two new
ones ship at five and ten legs only.

They are long shots, and the page is built to say so rather than to sell them.

---

## 1. First touchdown: the bake-off

Twenty-four models, the same field and the same discipline as the anytime
bake-off. Fitted 2021-24, judged on 2025-26 (301 games, 68 slates).

**Two things make this a harder question than anytime.** There is exactly one
winner per game instead of several, and sometimes there is none the board could
have named:

| how the game's first touchdown was scored | games |
|---|---|
| passing | 811 |
| rushing | 543 |
| interception return | 36 |
| fumble return | 13 |
| kickoff return | 8 |
| punt return | 8 |
| blocked punt / blocked FG / own fumble | 10 |
| *no touchdown in the game at all* | 10 |

So **5.3% of first touchdowns go to a defender or a returner** — no candidate on
the board was even eligible. Those games are kept in training and scoring. Delete
them and you fit on a filtered world where every game has an offensive first
scorer, and every probability comes out too high by about that much. The ceiling
on per-game top-1 is therefore **91.4%**, not 100%.

The leaderboard, against a **5.6% random baseline**:

| model | top-1 | vs logistic | 95% CI | ECE |
|---|---|---|---|---|
| poisson rate → P(≥1) | 16.3% | +0.7 | [−0.6, +2.1] | 0.1636 |
| ordinal 0/1/2+ | 15.9% | +0.4 | [−1.1, +1.9] | 0.1634 |
| **logistic L2** | **15.6%** | — | — | **0.0028** |
| linear discriminant | 15.6% | +0.0 | [−1.2, +1.4] | 0.0136 |
| extra trees | 15.3% | −0.3 | [−2.7, +2.1] | 0.0013 |
| within-game pairwise ranker | 15.3% | −0.3 | [−1.8, +1.1] | — |
| hist gradient boosting | 12.0% | −3.7 | [−7.0, −0.4] | 0.0060 |
| control: random | 6.3% | −9.2 | [−14.2, −3.9] | 0.0009 |

**Nothing beat the logistic.** Not one interval excludes zero on the winning
side. The Poisson's +0.7 rests on **four discordant games** (McNemar p = 0.63) —
and its calibration error is 0.164 on a 5% base rate, meaning it ranks plausibly
and then states numbers that are nowhere near right. A board that prints a
percentage on every leg and multiplies five of them cannot ship that.

Note that the pairwise ranker, which won the anytime bake-off outright, does
*not* win here. Its edge there came from training on within-game comparisons,
and with one winner per game there are far fewer useful pairs to learn from.

**Shipped: L2 logistic.** Held out: **15.6% top-1** (47 of 301) against 5.6%
random and a 91.4% ceiling, AUC 0.6855, ECE 0.0025.

## 2. Two or more touchdowns

`MULTI-TD.md` already established the shape of this market before anything was
built: the model ranks it *better* than it ranks anytime (AUC 0.79 vs 0.68),
because multi-touchdown games concentrate in an identifiable type, but the best
candidate in a game converts only about one time in seven.

The ranker was tried here too and **lost** — 13.6% top-1 against the logistic's
14.3%. Same reason as first-touchdown: a within-game ranker needs within-game
pairs, and at a 3.7% base rate there are barely any games with two of them.

**Shipped: L2 logistic.** Held out: **14.3% top-1** (43 of 301) against a 3.7%
base rate, AUC 0.7908, ECE 0.0017.

## 3. A calibration mistake worth recording

Both models shrink toward the base rate, with the shrink chosen by rolling
origin inside the training seasons. The anytime board picks that shrink by
zeroing the signed bias **on the lead pick per game**, because that is what it
publishes.

Carrying that criterion over was wrong, and measurably so. These models exist
*only* to fill slips, and the legs a slip takes are not the same population as
the lead picks — a lead-pick average is dragged down by games whose best
candidate is a 4% long shot that no slip would ever touch. Tuned on lead picks,
the 2+ model looked well calibrated (13.4% stated against 14.3% actual) while
the region a slip actually draws from was understated by 18% per leg:

| | stated | actual | ratio | compounded over 5 legs |
|---|---|---|---|---|
| p ≥ 0.08 | 14.36% | 17.74% | 1.235 | ×2.87 |
| p ≥ 0.12 | 18.18% | 21.43% | 1.179 | ×2.28 |
| p ≥ 0.20 | 25.04% | 25.45% | 1.017 | ×1.09 |

A five-leg slip is the product of five legs, so an 18% per-leg error becomes a
**2.3× error in the headline price**. Re-selecting the shrink on the leg
population fixed it; the residual is season drift, not bias.

## 4. One leg per game, and this time it is arithmetic

On the anytime board, stacking two legs from one game is a priced choice — both
players can score, so the slip is merely correlated. On **first touchdown it is
impossible**: exactly one player opens the scoring. Verified across all 1,424
games, none has two.

So `maxPerGame` is **forced to 1** for that market rather than defaulted, and the
relaxation pass that normally widens the cap by one to fill a thin slate is
blocked from doing it. Offering the "legs from one game" control there would be
offering a setting that silently does nothing, so the page replaces it with the
reason.

A consequence: every first-touchdown pair is in a different game, which is the
independence case, so that market needs **no correlation correction at all**.

For 2+, two players on one team can both score twice, so it does need one — but
its own two seasons contain a handful of co-scoring pairs (the control ratio came
out at 1.6 on 38 events, which is noise, not a measurement). It borrows the
anytime board's factors instead, which are measured on ~100× the pairs and
describe the same mechanism. The artefact records `pair_borrowed: true` rather
than passing them off as its own.

## 5. What a slip is actually worth

Held-out seasons, built the way the board builds one:

| market | legs | floor | weeks buildable | stated | won | expected |
|---|---|---|---|---|---|---|
| First TD | 5 | 0.15 | 17 | 1 in 1,620 | 0 | 0.010 |
| First TD | 10 | 0.10 | 17 | 1 in 27,388,491 | 0 | 0.000 |
| 2+ TDs | 5 | 0.15 | 16 | 1 in 2,097 | 0 | 0.008 |
| 2+ TDs | 10 | 0.08 | 18 | 1 in 89,803,332 | 0 | 0.000 |

**Zero wins is not a verdict here.** Over seventeen held-out weeks a 1-in-1,620
slip was expected to land 0.010 times. The backtest cannot tell you whether the
price is right at this length, and the card says exactly that beneath the number
rather than letting a zero read as failure.

Fifteen and twenty legs are deliberately not offered. At these base rates they
are numbers with nothing attached to them, and a first-touchdown slip cannot
have more legs than the slate has games anyway.

## 6. Live, on the 2026-09-20 slate

| market | top pick | 5 legs | 10 legs |
|---|---|---|---|
| Anytime | Kenneth Walker III 65.1% | 1 in 17 | 1 in 1,518 |
| First TD | Bijan Robinson 26.3% | 1 in 1,484 | 1 in 23,242,096 |
| 2+ TDs | Kenneth Walker III 26.9% | 1 in 2,440 | 1 in 125,768,951 |

The live slips land close to their backtested prices (first TD 1 in 1,484 against
1,620 backtested), which is the cheapest available check that the deployed model
and the fitted one are the same thing.

## 7. Reproducing it

```
research/nfl-td-scorer/
  fetch_first_td.py     first scorer per game, by athlete id from the core API
  bakeoff_first.py      the 24 models on the first-TD label
  bakeoff_first_sig.py  slate bootstrap, McNemar, and the calibration screen
  export_first_td.py    the shipped first-TD model and its parlay evidence
  export_two_plus.py    the shipped 2+ model, correlation and parlay evidence
  parity_markets.py     500 Python-scored vectors per market for the TS port
```

`bun scripts/test-nfl-markets.ts` holds both ports to those vectors (worst
disagreement 1.11e-16) and checks the shipped constants are consistent: sizes are
5 and 10 only, floors do not rise with size, every offered size carries evidence,
first TD is capped at one leg per game, and every observed zero is consistent
with its expected count.
