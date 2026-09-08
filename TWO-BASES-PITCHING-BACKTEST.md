# 2+ Total Bases — the starter, his hand, and the bullpen

[TWO-BASES.md](TWO-BASES.md) built a model for one market and, along the way,
threw two things out: a **bullpen** block (pooled ERA, K rate, hit rate,
home-run rate) and a **platoon** block (the hitter's own record against the hand
tonight's starter throws with). Both moved AUC by less than a thousandth, the
platoon block into the red.

Those are the two most obvious handicapping factors in baseball, and "we tried
it and it did nothing" is only worth believing if the thing tried was built
properly. This is the rebuild and the backtest: the **starting pitcher's own
platoon split**, the **bullpen's own platoon split**, **how many of a hitter's
plate appearances actually reach the bullpen**, and the algorithm bake-off run
again over the result.

Code: `research/mlb-tb2/handed_features.py` (the features),
`handed_bakeoff.py` (the backtest), `handed_sanity.py` (the diagnosis).
Results: `handed_bakeoff.json`, `handed_sanity.json`.

---

## TL;DR

- **None of it helps.** Four new blocks, twenty-one features, on top of the
  shipped model: the best single block is worth **+0.0002 AUC** with a 95%
  bootstrap band of [−0.0004, +0.0009], and all four together are worth
  **−0.0005**. Greedy forward selection keeps one block and stops.
- **It is not because the features are broken.** The starter's split, measured
  on its own, is monotone and real: hitters facing the fifth of starters worst
  against their hand go 2+ bases **37.1%** of the time against **32.8%** for the
  best fifth, and the feature carries a solo AUC of **0.5188** — for one number,
  that is a lot.
- **It is because the shipped model already has it.** Regress each new feature
  on the 44 that ship and the model recovers **69%** of the starter's strikeout
  split, **68%** of the bullpen's bases-allowed rate, **55%** of how many trips
  come against the starter. The signal is real, already priced, and arrives a
  second time as noise.
- **Handedness itself is the weakest part.** On the held-out season the platoon
  edge is worth *nothing at all*: hitters with the platoon advantage went
  **34.95%**, hitters without it **35.15%**. The tilt-size feature
  (`sp_split_gap`) has a solo AUC of 0.4903 — the wrong side of a coin flip.
- **The logistic wins again**, for the fifth time in this repo. Ten algorithms
  and a blend of two of them: the three linear fits tie at the top on AUC, and
  every tree, neighbour and network is worse.
- **Nothing ships.** The recommendation is to keep the model exactly as it is.

---

## The three things the dropped blocks never had

**Who throws the pitch.** The shipped model sees the starter's overall strikeout
rate and the hitter's overall bases per plate appearance. Neither is split by
hand, so a left-hander with a 30-point platoon gap and one with none are the same
number to it. `sphand` builds the *starter's own* split — bases, hits, home runs
and strikeouts allowed per plate appearance to batters of the hand this hitter
swings from tonight — plus `sp_split_gap`, the distance between that and his
overall rate, which is the **size** of his tilt rather than its direction.

**How many trips are actually against him.** A starter is not 27 outs. If he
faces `bf` batters starting from the top of the order, the hitter in slot *i*
gets `floor((bf − i)/9) + 1` of his plate appearances against the starter and the
rest against relief. A leadoff hitter against a starter who goes five sees him
three times and the bullpen twice; the nine hole sees him twice and the bullpen
twice. `expo` builds that from the starter's recent workload, which is knowable
at noon.

**The bullpen's own hand.** A pen that throws 40% of its batters faced left is a
different opponent to a left-handed hitter than to a right-handed one. `penhand`
carries the pen's split, its left-handed share of batters faced, and the share of
it holding the platoon advantage over this hitter.

Then `blend` mixes the first and third in the proportion from the second: one
exposure-weighted number for the staff this hitter will actually face.

### How a box score gets split between the starter and the pen

Box scores do not say which pitcher a plate appearance came against. The same
lineup-position arithmetic solves it: the starter's `bf` batters faced are the
first `bf` turns through the order, so slot *i* is charged to him
`floor((bf − i)/9) + 1` times and the remainder of that hitter's line to the
bullpen. Pinch hitters, a starter pulled mid-inning, and an irregular turnover
all break it at the edges — but it is right for the large majority of turns, and
much closer than the alternative the dropped bullpen block used, which was to
charge nobody in particular.

Everything is built by the repo's usual strictly chronological walk — a row for
game *G* only sees games that finished before *G* — every rate is shrunk to the
league mean, and switch hitters are given the hand they would actually bat from
against tonight's starter.

---

## The backtest

Fit on 2024–25, tested on the 2026 season the fit never saw. **87,348 training
rows, 38,724 held-out rows**, one per lineup starter per game, base rate 35.0%.

Two baselines rather than one, because the question is whether this beats what
ships, not whether it beats nothing:

| | features | AUC | Brier |
|---|--:|--:|--:|
| Player Props model | 34 | 0.5758 | 0.2240 |
| **2+ bases model as shipped** | **44** | **0.5784** | **0.2238** |

> These are a whisker above the numbers in TWO-BASES.md (0.5744 / 0.5770). The
> data was re-downloaded for this run and the 2026 season is now complete —
> 38,724 held-out rows against 37,303 — so every number here is on a slightly
> larger hold-out. The comparison inside this file is like for like.

### One block at a time, on the shipped model

The band is a 95% bootstrap on the delta, which at this scale is the only way to
tell a finding from a rounding error.

| block | cols | AUC | delta | 95% band | verdict |
|---|--:|--:|--:|---|---|
| **blend** (exposure-weighted staff) | 3 | 0.5786 | **+0.0002** | [−0.0004, +0.0009] | best, and still not distinguishable from zero |
| penhand (the pen's split) | 7 | 0.5784 | +0.0000 | [−0.0007, +0.0010] | nothing |
| sphand (the starter's split) | 7 | 0.5783 | −0.0001 | [−0.0007, +0.0006] | nothing |
| expo (starter vs relief exposure) | 4 | 0.5778 | −0.0005 | [−0.0009, −0.0002] | **worse, band excludes zero** |
| platoon, old flat version | 9 | 0.5779 | −0.0005 | [−0.0009, +0.0001] | replicates TWO-BASES.md |
| bullpen, old flat version | 5 | 0.5779 | −0.0005 | [−0.0012, +0.0002] | replicates TWO-BASES.md |
| *all four new blocks* | 21 | 0.5779 | −0.0005 | [−0.0017, +0.0005] | worse than any one of them |
| handedness both sides (old + sphand) | 16 | 0.5780 | −0.0004 | — | two blind alleys do not make a road |

The old blocks landing at −0.0005 on freshly downloaded data, having landed at
−0.0002 and −0.0006 in the original run, is the control: the pipeline reproduces.

### Greedy forward selection

```
+ blend  -> 0.5786   (47 features)
  stop: best remaining is +penhand at 0.5784, no better than 0.5786
```

One block survives, worth **+0.0002 [−0.0004, +0.0008]** — a band that contains
zero, three features for nothing.

### Ten algorithms and a blend, on the winning feature set

| model | AUC | Brier | log loss | top-1 | top-5 |
|---|--:|--:|--:|--:|--:|
| **logistic** | **0.5786** | 0.2238 | 0.6391 | 0.472 | 0.447 |
| logistic C=0.1 | 0.5786 | 0.2238 | 0.6391 | 0.472 | 0.448 |
| logistic L1 | 0.5786 | 0.2238 | 0.6391 | 0.491 | 0.450 |
| logistic + hist-GBM, 50/50 | 0.5775 | 0.2243 | 0.6402 | 0.454 | 0.470 |
| hist-GBM | 0.5744 | 0.2258 | 0.6438 | 0.503 | 0.458 |
| extra trees | 0.5737 | 0.2325 | 0.6614 | 0.460 | 0.472 |
| random forest | 0.5711 | 0.2596 | 0.7585 | 0.534 | 0.461 |
| gradient boosting | 0.5705 | 0.2268 | 0.6461 | 0.460 | 0.433 |
| gaussian naïve Bayes | 0.5671 | 0.2256 | 0.6433 | 0.472 | 0.429 |
| kNN (k=200) | 0.5613 | 0.2258 | 0.6435 | 0.429 | 0.447 |
| MLP (neural net) | 0.5574 | 0.2282 | 0.6490 | 0.485 | 0.438 |

The three linear fits are indistinguishable — the L1 keeps 43 of 47 features, so
even the sparse one declines to throw the new columns away, it just shrinks them
to nothing. Blending the logistic with the gradient-boosted tree makes it worse
on AUC, which is what a blend does when one of the two ingredients is weaker on
every axis that matters.

Note the tree models' **top-1** column: the random forest picks the day's single
best hitter at 53.4% against the logistic's 47.2%. On one pick per slate that is
about 190 bets across a season, and the AUC gap says the ranking underneath it is
worse. It is a real number and it is not a reason to switch models.

### The winner, in full

| | AUC | Brier | log loss | top-1 | top-3 | top-5 | top-10 |
|---|--:|--:|--:|--:|--:|--:|--:|
| props 34 | 0.5758 | 0.2240 | 0.6397 | 0.515 | 0.474 | 0.479 | 0.439 |
| **2+ bases as shipped** | 0.5784 | 0.2238 | 0.6391 | **0.521** | 0.483 | **0.464** | **0.448** |
| + starter / pen / handedness | **0.5786** | 0.2238 | 0.6391 | 0.472 | **0.485** | 0.447 | 0.445 |

The new model is a rounding error ahead on AUC and **behind on three of the four
board-accuracy numbers that a person reading the page actually experiences**.
The day's single best pick drops from 52.1% to 47.2%.

Calibration, held out:

| predicted | n | mean predicted | actual |
|---|--:|--:|--:|
| 20–25% | 1,829 | 23.4% | 23.0% |
| 25–30% | 7,100 | 27.8% | 27.2% |
| 30–35% | 9,548 | 32.5% | 32.1% |
| 35–40% | 10,026 | 37.5% | 38.5% |
| 40–45% | 6,933 | 42.2% | 40.5% |
| 45–50% | 2,553 | 47.0% | 44.0% |
| 50%+ | 657 | 52.7% | 50.2% |

Tiers, and the American price at which each is exactly a push:

| Tier | n | hit rate | breakeven |
|---|--:|--:|--:|
| Strong | 3,210 | 45.3% | +121 |
| Solid | 20,830 | 38.2% | +162 |
| Lean | 14,684 | 28.3% | +254 |

Both tables are the shipped model's shape to within noise — same tightness
through the middle, same mild over-confidence above 45%.

Month by month on the hold-out, shipped → with the new blocks:

| month | n | shipped | new | delta |
|---|--:|--:|--:|--:|
| 2026-03 | 1,006 | 0.5350 | 0.5402 | +0.0052 |
| 2026-04 | 7,128 | 0.5821 | 0.5819 | −0.0002 |
| 2026-05 | 7,520 | 0.5864 | 0.5855 | −0.0009 |
| 2026-06 | 7,085 | 0.5762 | 0.5765 | +0.0003 |
| 2026-07 | 6,651 | 0.5759 | 0.5772 | +0.0013 |
| 2026-08 | 7,524 | 0.5753 | 0.5754 | +0.0002 |
| 2026-09 | 1,810 | 0.5808 | 0.5802 | −0.0005 |

Four months up, three down, the largest move in the smallest month. There is no
period of the season where knowing the pitcher's hand pays.

---

## Why it does not help — which is not the same as "there is nothing there"

A block that adds nothing has two possible explanations: the effect is not real,
or it is real and the model already has it. `handed_sanity.py` separates them on
the held-out season with no model involved at all.

### The starter's split is real

Hit rate by fifth of `sp_tb_pa_h`, the bases per plate appearance this starter
has allowed to batters of this hitter's hand:

| quintile | starter's rate allowed | n | 2+ bases |
|---|--:|--:|--:|
| Q1 (toughest) | 0.3153 | 7,748 | **32.8%** |
| Q2 | 0.3354 | 7,742 | 34.4% |
| Q3 | 0.3467 | 7,748 | 35.3% |
| Q4 | 0.3564 | 7,743 | 35.6% |
| Q5 (softest) | 0.3792 | 7,743 | **37.1%** |

Monotone, 4.3 points end to end, on 38,724 rows. The feature works.

### The model already knows it

Regress each new feature on the 44 features that ship, and read off the R²:

| feature | R² already explained |
|---|--:|
| `sp_k_pa_h` — starter's strikeout rate vs this hand | **0.690** |
| `pen_tb_pa_h` — bullpen's bases allowed vs this hand | **0.677** |
| `staff_k_pa` — exposure-weighted staff strikeout rate | 0.661 |
| `sp_pa_exp` — trips against the starter | 0.546 |
| `staff_tb_pa` — exposure-weighted staff bases | 0.543 |
| `sp_h_pa_h` | 0.518 |
| `sp_tb_pa_h` | 0.469 |
| `pen_lhp_share` — how left-handed the pen is | 0.115 |
| `sp_bf_trend` — how deep the starter goes | 0.104 |
| `pen_edge_share` | 0.095 |
| `sp_split_gap` — the size of the starter's tilt | 0.086 |

The features the model has most of are the ones that carry signal; the features
it has least of are the ones that carry none. `sp_split_gap` is 91% new
information and worth nothing — solo AUC **0.4903**. That pattern is the whole
finding: what is knowable about the pitcher a hitter faces is already in the
shipped features under other names (the starter's strikeout rate, the opponent's
bases allowed, the hitter's own rates), and what is genuinely new about splitting
it by hand is noise.

### Handedness, on its own, is worth nothing

| split | n | 2+ bases |
|---|--:|--:|
| platoon edge (opposite hands) | 24,191 | **34.95%** |
| same hand | 14,533 | **35.15%** |
| switch hitter | 4,218 | 33.55% |

The platoon advantage is *backwards* here by two tenths of a point — noise, but
noise centred on zero rather than on the effect everybody assumes. For **2+ total
bases specifically** this is less surprising than it sounds: the platoon edge
shows up most in walks and in power, and a walk is zero bases. The market where
handedness matters is not this one.

This replicates [EDGE-HUNT.md](EDGE-HUNT.md) and `mlb-props/platoon_ab.py`, which
found the same thing across all twelve batter markets, and it now survives having
been rebuilt from the pitcher's side as well as the hitter's.

### Bullpen exposure is mostly the batting order wearing a hat

Hit rate by fifth of `pen_share`, the fraction of a hitter's night expected
against relief:

| quintile | pen_share | n | 2+ bases |
|---|--:|--:|--:|
| Q1 | 0.2944 | 8,162 | 38.4% |
| Q2 | 0.3282 | 8,018 | 40.7% |
| Q3 | 0.4785 | 8,273 | 27.6% |
| Q4 | 0.5016 | 7,937 | 32.9% |
| Q5 | 0.5690 | 6,334 | 35.9% |

That is not a bullpen effect, it is the lineup: `pen_share` is a step function of
the batting slot, so the quintiles are mostly sorting leadoff hitters from the
bottom of the order, and the shipped model's largest coefficient is already the
batting slot. Holding exposure high and varying only the *quality* of the pen:

| pen quality quartile (high-exposure half) | pen's bases allowed | n | 2+ bases |
|---|--:|--:|--:|
| Q1 (best pens) | 0.3410 | 4,609 | 33.3% |
| Q2 | 0.3491 | 4,608 | 31.4% |
| Q3 | 0.3552 | 4,607 | 33.2% |
| Q4 (worst pens) | 0.3717 | 4,607 | 34.4% |

1.1 points from the best pens to the worst, non-monotone in the middle. The
original conclusion stands, and now has a mechanism attached: bullpen quality is
already inside the opponent's bases-allowed feature, and *which* relievers appear
is decided by the game state rather than by anything knowable at noon.

---

## What this changes

Nothing, and that is the result. The shipped 2+ bases model stays as it is: 44
features, no handedness, no bullpen, no exposure weighting. The three `blend`
columns are the only ones with a positive point estimate and their band contains
zero, so shipping them would be buying three features' worth of complexity and
one more thing to compute at serve time in exchange for a number that cannot be
distinguished from luck — and, on the board accuracy a reader actually sees, a
worse top of the card.

The value of the run is in what it rules out. "The model ignores handedness" and
"the model can't see the bullpen" are the first two objections anybody raises to
a prop model, and they are now answered twice each: once flat, once built the way
the game is played, both times against the same held-out season, with the raw
effects measured next to the model deltas so the reason is visible rather than
asserted.

---

## Reproducing it

```bash
cd research/mlb-props
python3 fetch_props.py      # box scores, 2024-26         (~4 min)
python3 fetch_context.py    # handedness, weather, umpires (~1 min)
python3 features.py         # the shipped 34 + platoon columns

cd ../mlb-tb2
python3 fetch_weather.py    # Open-Meteo archive, for temp_fc
python3 features_tb2.py     # the shipped model's extra blocks
python3 handed_features.py  # the four new blocks       (~6 min)
python3 handed_bakeoff.py   # the backtest and the zoo (~25 min)
python3 handed_sanity.py    # the raw effects and the R2 table
```

`handed_bakeoff.py --quick` drops the three slowest algorithms and finishes in
about ten minutes.
