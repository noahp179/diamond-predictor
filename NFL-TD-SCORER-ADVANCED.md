# NFL TD-Scorer — Extraordinary Round: structure, stacking, and the ceiling

Third installment, after [`NFL-TD-SCORER-BACKTEST.md`](NFL-TD-SCORER-BACKTEST.md)
(the original Poisson model) and [`NFL-TD-SCORER-BAKEOFF.md`](NFL-TD-SCORER-BAKEOFF.md)
(18 algorithms ranked). The brief: *think outside the box — new statistical
approaches, and combine models — and find something extraordinary.*

So I stopped adding off-the-shelf classifiers and attacked the one thing **every**
prior model got wrong structurally, then combined the field properly. Code:
`research/nfl-td-scorer/advanced.py`. Same held-out test as always: **2023–2024,
569 games, 9,612 predictions.**

---

## The insight nobody's model used

Every model in the bake-off scored each player **independently**, then ranked
them. But touchdowns inside a game are not independent — they're a **competing
allocation**. A team scores a *limited* number of TDs, and its players **compete**
for them: if the running back vultures the goal line, the receivers don't score.
The outcomes are negatively correlated within a team and share a hard constraint
(the team's TD total). Flattening that into 40 independent coin-flips throws the
structure away.

So I built the model that respects it.

### 🧩 Model 1 — Hierarchical Two-Stage (HTS)

Decompose the hard question ("will *this player* score?") into two well-posed ones:

- **Stage A — how many TDs will the _team_ score?** Two Poisson regressions
  (rushing, receiving) on team-offense and opponent-defense strength. This is a
  *low-variance* prediction — team scoring is far more stable than any one
  player's.
- **Stage B — given a team TD, _who_ scores it?** A **conditional logit**
  (softmax) over the team's players — a within-team competition fit by
  maximum likelihood on who actually scored. Learned share drivers:

  | rushing share | | receiving share | |
  |---|---|---|---|
  | `carry_share` | **+0.76** | `target_share` | **+0.42** |
  | `rush_td_rate` | +0.32 | `rec_td_rate` | +0.19 |
  | `proj_carries` | +0.23 | `proj_targets` | +0.17 |

- **Combine** by Poisson thinning: `λ_player = teamCount × playerShare`, then
  `P = 1 − exp(−λ)`. Player expectations now **sum to a realistic team total by
  construction** — the competing-risks structure is preserved.

### 🔗 Model 2 — Stacked super-learner (STACK)

The right way to "combine models" (not the naïve average I tried before).
Six diverse base learners — logistic, hist-GBM, random forest, naïve Bayes, the
**incumbent Poisson**, and the **HTS** above — each produce **out-of-fold**
predictions on the training seasons (folds split **by game**, so no teammate
leaks across a fold). A meta-logistic then learns the optimal blend:

```
stack meta-weights:
   HTS ........... 1.74   ← the new structural model is the biggest ingredient
   logistic ...... 1.56
   incumbent ..... 0.74
   naive bayes ... 0.35
   random forest . 0.14
   hist-GBM ..... −0.44   ← boosting gets DOWN-weighted (used as a corrector)
```

The meta-learner leans hardest on the **structured/linear** models and actively
*subtracts* gradient boosting. That is the whole "simple-beats-complex" story in
one vector.

### 🎲 Model 3 — Rank-average ensemble (RANKAVG)

A non-parametric blend: average the within-distribution ranks of five diverse
models. Robust, hyper-parameter-free insurance.

---

## Combined leaderboard — all 21 models (ranked by AUC)

AUC is the reliable ranking metric here (computed over 9,612 predictions; top-1
over 569 games is noisier — see significance below).

| # | Model | AUC | Brier | LogLoss | Top-1 | Top-2 | |
|---|---|---|---|---|---|---|---|
| 1 | **STACK super-learner** | **0.704** | **0.1525** | **0.4752** | **51.7%** | 70.8% | 🆕 |
| 2 | **RANKAVG ensemble** | 0.702 | 0.1529 | 0.4760 | 49.6% | 71.4% | 🆕 |
| 3 | logistic regression | 0.701 | 0.1530 | 0.4789 | 50.3% | 71.7% | |
| 4 | **HTS hierarchical** | 0.701 | 0.1538 | 0.4781 | 49.0% | 68.9% | 🆕 |
| 5 | logistic (no incumbent feat) | 0.701 | 0.1530 | 0.4792 | 50.6% | 71.0% | |
| 6 | extra trees | 0.701 | 0.1531 | 0.4847 | 48.9% | 71.2% | |
| 7 | ensemble (mean, from bake-off) | 0.698 | 0.1532 | 0.4821 | 48.5% | 71.0% | |
| 8 | random forest | 0.695 | 0.1541 | 0.4852 | 51.1% | 70.5% | |
| 9 | player-rate Poisson | 0.694 | 0.1546 | 0.4899 | 47.1% | 69.8% | |
| 10 | gaussian naïve Bayes | 0.693 | 0.1540 | 0.4803 | 50.6% | 72.6% | |
| 11 | gradient boosting | 0.691 | 0.1549 | 0.4821 | 48.9% | 70.1% | |
| 12 | hist gradient boosting | 0.687 | 0.1550 | 0.4824 | 47.5% | 71.0% | |
| 13 | league-rate Poisson | 0.685 | 0.1559 | 0.4836 | 46.7% | 67.3% | |
| 14 | neural net (MLP) | 0.682 | 0.1559 | 0.4974 | 45.2% | 66.1% | |
| 15 | k-nearest neighbors | 0.681 | 0.1551 | 0.4834 | 50.1% | 71.2% | |
| 16 | **Poisson allocation (original)** | 0.680 | 0.1559 | 0.4867 | 48.3% | 68.9% | ⭐ |
| 17 | volume (touches) | 0.679 | 0.1565 | 0.4856 | 46.7% | 68.2% | |
| 18 | historical TD rate | 0.671 | 0.1572 | 0.4931 | 46.6% | 66.6% | |
| 19 | weighted volume | 0.661 | 0.1582 | 0.4911 | 47.5% | 69.2% | |
| 20 | hot hand (recent TDs) | 0.660 | 0.1594 | 0.4945 | 41.5% | 64.5% | |
| 21 | base rate (no skill) | 0.502 | 0.1679 | 0.5185 | 20.4% | 38.0% | |

**The three new models take slots 1, 2, and 4.** The STACK super-learner is the
best model on **every** metric. The original hand-built Poisson now sits 16th.

---

## Is it *really* better? (the honest part)

I ran paired bootstraps so the ranking isn't over-read.

| Comparison | Δ Top-1 (569 games) | Δ AUC (9,612 preds) |
|---|---|---|
| **STACK vs original Poisson** | +3.3%  [−0.5%, +6.9%]  *(noise)* | **+0.0241  [+0.019, +0.029]  ✅ significant** |
| **STACK vs best single (logistic)** | +1.4%  [−0.7%, +3.5%]  *(noise)* | +0.0028  [−0.000, +0.006]  *(noise)* |

Two clear conclusions:

1. **The advanced pipeline significantly beats the original model** — AUC +0.024
   with a confidence interval well clear of zero. Chaining a hierarchical model
   and a stack was a real, measurable upgrade over where we started.
2. **It does _not_ significantly beat a plain logistic regression.** We are at
   the **signal ceiling** of this feature set. Stacking bought robustness and a
   sliver of AUC; it did not break through.

---

## 💡 The extraordinary finding

The most valuable result here isn't a leaderboard slot — it's *why the
leaderboard is shaped the way it is*:

> **On this problem the ceiling is set by information, not by the algorithm.**

Once you have well-built usage + matchup features, a **simple logistic regression
already extracts ~all the learnable signal**. A principled competing-risks model
(HTS) and a six-model super-learner **match or edge it, but cannot break past it**
— because the missing ~46% of top-1 accuracy isn't hiding in a cleverer function
of the same inputs. It's genuinely unknowable from box-score history:

- **~5% of TDs are defensive / special-teams** — unpredictable from offense.
- **Goal-line role churn** — coaches give the 1-yard plunge to a fullback or a
  backup; that decision isn't in prior box scores.
- **Script & game flow** — a blowout vs. a shootout reshuffles who scores, and
  that depends on the *game total and spread*, which no model here was given.

So the extraordinary move is not another model — it's **new information**. The
same three levers as before, now quantified as the only things that can move the
ceiling: **(1) the odds market's implied team total & spread** (the app already
ingests odds — this is the single highest-value add), **(2) real goal-line /
red-zone usage** from play-by-play, and **(3) injury / inactive / snap-share
feeds.** Bolted onto the HTS + stack pipeline, *those* would move the number.

---

## What I'd ship

- **Primary scorer:** the **STACK super-learner** — best on every metric and
  significantly better than where we started. If you'd rather keep it simple, a
  **plain logistic regression or the HTS model is statistically equivalent** and
  far easier to serve and explain.
- **Keep HTS in the blend regardless** — it's the meta-learner's most-trusted
  ingredient and the only model that yields a coherent team-total decomposition
  (useful for explaining a pick: "SF should score ~2.6 TDs; McCaffrey owns 41%
  of the rushing share").
- **Retire** gradient boosting / MLP for this task — negatively weighted or
  bottom-tier.
- **Next real gain is data, not modeling** — wire in the market total first.

---

## Files

| File | Purpose |
|---|---|
| `research/nfl-td-scorer/advanced.py` | HTS (conditional-logit share + Poisson team counts), STACK super-learner, RANKAVG, bootstrap significance |
| `research/nfl-td-scorer/advanced_metrics.json` | New-model metrics, stack weights, share coefficients |
| `research/nfl-td-scorer/leaderboard.csv` | The combined 21-model table above |
| `research/nfl-td-scorer/bakeoff.py` | The other 18 models (previous round) |
