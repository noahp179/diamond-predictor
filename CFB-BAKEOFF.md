# 24 Algorithms for "Who Scores a Touchdown" — and an Argument About How to Judge Them

Everything here is fitted on **2021–24** and scored on **2025 and 2026-to-date**
— 21,503 candidate player-games across 1,130 games and 88 slates. No test
season touches any fit, scaler or calibrator. Code: `research/cfb/bakeoff_*.py`.

---

## TL;DR

**Nothing beat the shipped logistic regression by enough to ship.** That is the
honest headline, and it took four rounds of testing to be confident of it.

| judged on                                | winner                        | value            | shipped logistic |
| ---------------------------------------- | ----------------------------- | ---------------- | ---------------- |
| **AUC** (the conventional answer)        | stack: logistic+boost+poisson | 0.7004           | 0.6918           |
| **top-1 per game** (what the card shows) | extra trees                   | **58.1%**        | 56.3%            |
| **calibration (ECE)**                    | hierarchical team×share       | **0.0048**       | 0.0166           |
| **log loss**                             | hist gradient boosting        | 0.5047           | 0.5119           |
| **5-leg parlay**                         | stack                         | 40.0% (20 slips) | 31.6% (19 slips) |

Five metrics, five different winners, and **not one of them is the shipped
model** — yet the shipped model stays. Three findings explain why:

1. **Only one model's edge survives a proper significance test.** Extra trees
   is +1.9 points of top-1 with a 95% interval of [+0.5, +3.3]. Every other
   model's interval includes zero.
2. **That one model cannot ship.** The forest is 782,570 tree nodes — about
   **30MB** of JSON against the current 4KB — and it has no coefficients, so it
   would silently destroy the per-leg reasoning on the TD and parlay boards.
3. **The nonlinearity it found is interactions, not curves** — and a 137-term
   interaction logistic captures 83% of it in 3KB. But its top-1 edge is _not_
   significant either, and its 5-leg parlay rate is half the shipped model's.

The one free improvement worth taking: **Platt scaling** cuts calibration error
by a quarter (0.0166 → 0.0123) at a cost of two numbers in the model file, with
log loss and ranking untouched.

---

## 1. The methodological argument

The standard way to rank models on a binary target is AUC over every row. That
is the wrong objective here, and not by a little.

AUC asks: _across all 21,503 candidates, how well are scorers ordered above
non-scorers?_ The product asks something far narrower: _of the two or three
names on this game's card, is the top one right?_ A model can order the whole
field slightly better and still lose the only comparison a reader ever sees.

So every model is scored five ways and the ranking reported per metric, never
collapsed into one. `top1` is per-**game** and `parlay5` per-**slate**, so a
model that is confidently wrong about the favourite gets punished where AUC
would shrug.

It matters. The AUC ranking and the top-1 ranking **disagree at the top**: the
stack and hist gradient boosting win AUC; extra trees, fourth on AUC, wins
top-1 by 1.4 points over either.

---

## 2. What was compared

Not fifteen flavours of gradient boosting. Four families, and the interesting
ones are last.

**Heuristics** (no fitting at all — if a regression can't beat these, it's decoration)

| model                                               | AUC    | top-1 |
| --------------------------------------------------- | ------ | ----- |
| rank by scoring rate                                | 0.6543 | 54.5% |
| expected TDs (carries×rush rate + catches×rec rate) | 0.6627 | 53.4% |
| rank by touches                                     | 0.6479 | 48.8% |
| rank by carry share                                 | 0.5887 | 48.1% |
| **control: random**                                 | 0.4953 | 24.4% |

"Rank by how often he has scored" gets 54.5% — within 1.8 points of the shipped
model and within 3.6 of the best thing here. That is the honest scale of the
whole exercise.

**Linear** — logistic L1/L2/elastic-net (0.6918, 56.3–56.5%), LDA and ridge
(0.6920, 56.7%), Gaussian naive Bayes (0.6787, 55.8%).

**Nonlinear** — extra trees (0.6980, **58.1%**), hist gradient boosting (0.7000,
56.7%), random forest (0.6955, 57.2%), neural net 64×32 (0.6965, 56.3%), kNN
k=200 (0.6898, 56.9%), depth-6 tree (0.6778, 55.7%), AdaBoost (0.6930, 54.7%).

**Reformulated** — models that change the _question_, not the fitting method:

| model                          | what it does differently                       | AUC        | top-1 | ECE        |
| ------------------------------ | ---------------------------------------------- | ---------- | ----- | ---------- |
| poisson rate → P(≥1)           | touchdowns are a rate, not a coin flip         | 0.6909     | 56.1% | 0.024      |
| hierarchical team×share        | team scores _k_; player takes a share          | 0.6903     | 56.9% | **0.0048** |
| ordinal 0/1/2+                 | two-TD games carry information binary discards | 0.6917     | 56.4% | 0.018      |
| within-game pairwise ranker    | optimise the comparison the card makes         | 0.6684     | 53.3% | —          |
| stack (logistic+boost+poisson) | out-of-fold blend of three formulations        | **0.7004** | 56.8% | 0.019      |

Two results worth dwelling on:

**The pairwise ranker failed, and it was my best idea.** The board only needs
the _order_ within a game, so training on within-game pairs (scorer vs
non-scorer, learning on the feature difference) should optimise exactly the
metric that matters. It came 21st of 24 on that metric — 53.3%, significantly
_worse_ than the shipped model. Directly optimising the target comparison lost
to modelling the probability and sorting it.

**The hierarchical model has the best calibration of anything tested** (0.0048
against the shipped 0.0166) while being 3rd on top-1. Composing "how many
touchdowns does this team score" with "what share does this player take" is
how football actually allocates scoring, and it shows up as honesty rather than
as accuracy.

---

## 3. Which differences are real

1,130 games sounds like a lot. It isn't, and the naive interval is too narrow:
games on one slate share a week, weather and the state of every team's usage
sample. So the bootstrap resamples **whole Saturdays**, not games.

**Every model against the shipped logistic, paired by slate:**

| model                       | top-1 | difference | 95% CI           | verdict |
| --------------------------- | ----- | ---------- | ---------------- | ------- |
| extra trees                 | 58.1% | +1.9       | **[+0.5, +3.3]** | real    |
| random forest               | 57.2% | +0.9       | [−1.1, +2.9]     | noise   |
| kNN (k=200)                 | 56.9% | +0.6       | [−1.2, +2.5]     | noise   |
| hierarchical team×share     | 56.9% | +0.7       | [−0.6, +2.0]     | noise   |
| stack                       | 56.8% | +0.6       | [−1.3, +2.7]     | noise   |
| LDA / ridge                 | 56.7% | +0.5       | [−0.3, +1.4]     | noise   |
| hist gradient boosting      | 56.7% | +0.5       | [−1.8, +2.9]     | noise   |
| within-game pairwise ranker | 53.3% | −2.9       | [−5.5, −0.6]     | worse   |
| rank by touches             | 48.8% | −7.4       | [−9.8, −4.7]     | worse   |

**Exactly one model clears zero.** McNemar agrees: on the 97 games where extra
trees and the shipped model disagree, the split is 59–38 (two-sided p = 0.042).

Ten seeds confirm it isn't luck: the full forest beat the shipped model on
**10 of 10**, mean **+1.65**, sd 0.25, range +1.24 to +2.12. (The +1.9 above is
seed 0, which every other table here also uses; the ten-seed mean is the
fairer single number for a randomised fit.)

But the per-season split is a caution rather than a confirmation:

|                    | 2025 (n=952) | 2026 (n=178) |
| ------------------ | ------------ | ------------ |
| extra trees        | 57.9%        | 59.6%        |
| logistic (shipped) | 55.6%        | **60.1%**    |

The forest's whole edge is in 2025. In 2026 it is 0.5 points behind — on 178
games, where the noise is ±3–4 points, so this is not evidence against it. It
is a reason not to treat +1.9 as settled.

---

## 4. Why the winner can't ship

Two hard constraints, both discovered by trying:

**Size.** The live board runs the model in TypeScript from a JSON file: sixteen
coefficients, a mean, a standard deviation — about 4KB. The forest is 782,570
nodes, roughly **30MB**. Shrinking it costs most of the edge:

| forest                      | nodes   | ~JSON     | top-1 vs shipped |
| --------------------------- | ------- | --------- | ---------------- |
| 300 trees, leaf 20          | 782,570 | 30MB      | +1.77            |
| 100 trees, leaf 20          | 259,681 | 10MB      | +1.18            |
| 50 trees, leaf 100          | 19,519  | 762KB     | +0.94            |
| 30 trees, leaf 20, depth 8  | 6,594   | **258KB** | +0.94            |
| 20 trees, leaf 100, depth 8 | 2,515   | 98KB      | +0.44            |

(Those small-forest figures are 3-seed averages and within ±0.25–0.5 of each
other — the curve is flatter than it looks.)

**Explanation.** A forest has no coefficients. The per-leg reasoning added to
the TD and parlay boards is read directly out of them — a feature's push on the
log-odds is `coef × (x − mean) / std`. Swapping in a forest doesn't degrade that
feature, it deletes it.

**A blend keeps both, and doesn't work.** Averaging the shipped logistic with a
258KB forest peaks at +0.78 ± 0.40 top-1 while **doubling** calibration error
(0.0166 → 0.0337) and worsening log loss. Paying for ranking with calibration is
not a trade this board should make — it displays the probability, and the parlay
page multiplies twenty of them together.

---

## 5. The near miss: interactions, not curves

If the forest's edge is nonlinear structure, a _linear_ model can have it —
expand the features and the model stays linear in its own basis, keeps
coefficients, and serialises to kilobytes.

| model                     | params  | ~size   | top-1     | AUC    | ECE        |
| ------------------------- | ------- | ------- | --------- | ------ | ---------- |
| plain logistic (shipped)  | 17      | <1KB    | 56.3%     | 0.6918 | 0.0166     |
| spline logistic (4 knots) | 81      | 2KB     | 55.6%     | 0.6939 | 0.0081     |
| spline logistic (6 knots) | 113     | 2KB     | 54.6%     | 0.6946 | 0.0060     |
| **pairwise interactions** | **137** | **3KB** | **57.5%** | 0.6966 | **0.0069** |
| extra trees (reference)   | 782,570 | 30MB    | 57.8%     | 0.6984 | 0.0188     |

**Splines made it worse.** Per-feature curvature is not what the forest found —
six knots cost 1.7 points. **Interactions captured 83% of the forest's top-1
gain in 3KB**, with better calibration than the forest or the shipped model.
The strongest terms are football, not artefacts:

```
carry_share × elo_margin   +0.108   carries matter more when you're favoured
cpg × is_home              +0.101   volume at home
rpg × team_rec_tdpg        +0.102   catches on a team that throws touchdowns
rec_ypg × elo_margin       -0.115   receiving yards matter less in a blowout
```

And it still doesn't ship:

- paired bootstrap: **+1.28, 95% CI [−0.22, +2.94]** — includes zero
- McNemar: 77–63, p = 0.272
- 2026: 59.0% against the shipped model's 60.1%
- 5-leg parlay: **15.8% against 31.6%** (3 wins vs 6 in 19 slips — small, but the wrong direction)

Better AUC and better calibration, on an unproven top-1 edge and a worse parlay
rate. Not enough.

---

## 6. A measurement trap worth recording

Isotonic calibration appeared to gain **+1.4 points of top-1** while halving
calibration error. Both cannot be true: isotonic regression is monotone, and a
monotone transform **cannot reorder** the players within a game.

It was tie-breaking. Isotonic collapsed 21,486 distinct probabilities into
**116**, so most players in a game shared a value and `idxmax` picked whichever
came first in the dataframe. Break the ties by the raw probability and the gain
vanishes exactly:

|            | distinct values | top-1 (ties → first) | top-1 (ties broken properly) |
| ---------- | --------------- | -------------------- | ---------------------------- |
| raw        | 21,486          | 56.3%                | 56.3%                        |
| + isotonic | **116**         | 57.7%                | **56.3%**                    |
| + Platt    | 21,485          | 56.3%                | 56.3%                        |

Any evaluation that sorts on a coarsely-quantised score is measuring its own row
order. Worth knowing generally, and a reason to prefer Platt here regardless:
116 distinct probabilities would also wreck the parlay page, which ranks
candidates and multiplies twenty of them.

---

## 7. The one change worth making

|                    | ECE        | log loss | AUC    | top-1 | ranking resolution |
| ------------------ | ---------- | -------- | ------ | ----- | ------------------ |
| logistic (shipped) | 0.0166     | 0.5119   | 0.6918 | 56.3% | 21,486 values      |
| **+ Platt**        | **0.0123** | 0.5117   | 0.6918 | 56.3% | 21,485 values      |
| + isotonic         | 0.0068     | 0.5227   | 0.6904 | 56.3% | 116 values         |

Platt scaling cuts calibration error by a quarter for **two extra numbers** in
the model file, with log loss, AUC and ranking untouched. The NFL touchdown
model already carries `platt_a` / `platt_b`; the college one never got them.

Isotonic halves the error instead, but costs log loss and destroys the ranking
resolution both boards depend on.

**Not applied yet, deliberately.** The forward ledger started recording under
`cfb-td-logistic-v1` on 2026-09-13. Changing the model means bumping the model
version and starting that record over, so it is worth doing once, with intent —
not as a footnote to a bakeoff.

---

## 8. Reproducing it

```bash
cd research/cfb
python3 bakeoff_big.py       # all 24 models, five metrics
python3 bakeoff_sig.py       # paired bootstrap by slate, McNemar, per season
python3 bakeoff_deploy.py    # seed stability and deployable forest size
python3 bakeoff_blend.py     # logistic x forest blends
python3 bakeoff_splines.py   # splines vs interactions vs the forest
python3 bakeoff_final.py     # the interaction model, tested properly
```

Runtime is about five minutes end to end. `bakeoff_big.py` needs
`data/features.csv` and `data/player_games.csv` from `fetch_espn.py`.
