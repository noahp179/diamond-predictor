# NFL TD-Scorer — Model Bake-Off (18 algorithms ranked)

Follow-up to [`NFL-TD-SCORER-BACKTEST.md`](NFL-TD-SCORER-BACKTEST.md). The
question here: **can other algorithms beat the hand-built Poisson model, and how
do they all rank?** I built **18 algorithms across four families** and judged
every one on the **same held-out games (2023–2024)**, over the **same candidate
players per game**, with the **same metrics**. Code: `research/nfl-td-scorer/`
(`bakeoff.py`, `features.py`/`backtest.py`).

> **Next round:** [`NFL-TD-SCORER-ADVANCED.md`](NFL-TD-SCORER-ADVANCED.md) adds a
> hierarchical competing-risks model and a stacked super-learner that top this
> leaderboard — and shows why we've hit the signal ceiling.

---

## TL;DR — the ranking

- 🥇 **Logistic regression is the best overall** — best probability quality
  (AUC 0.701, Brier 0.1530, log loss 0.4789) and ~top pick accuracy (50.3%).
  Simple, calibrated, interpretable.
- A cluster of **simple ML models (random forest, naïve Bayes, logistic, kNN)**
  modestly beats the **incumbent Poisson (48.3%)** — by ~2–3 pts on pick
  accuracy and clearly on AUC/Brier.
- **Simple beats complex:** gradient boosting, hist-GBM and the neural net do
  **not** win — classic behavior on small, noisy tabular data.
- **Volume heuristics (~46.7%)** are the "reasonable floor"; **chasing recent
  TDs ("hot hand", 41.5%) is worse than volume**; random pick is 20.4%.
- The single biggest signal is **`carry_share`** — a player's *share of the
  team's carries* (the goal-line / workhorse role) — ahead of raw volume.

> **Read the ranking in tiers, not exact places.** Over 569 games, top-1 hit
> rate carries a **±3.4% (95%) noise band**, so the top ~10 models are a
> statistical near-tie on picks. The **probability metrics (AUC / Brier), computed
> over 9,612 predictions, are far tighter** and are where logistic regression
> separates as the reliable winner.

---

## What was compared

| Family | Models |
|---|---|
| **Heuristic** | base rate (no-skill floor), volume (touches), weighted volume, historical TD rate, hot hand (recent-TD EWMA) |
| **Statistical** | league-rate Poisson, player-rate Poisson, **Poisson allocation (the incumbent)** |
| **Machine learning** (trained on 2021–22) | logistic regression, logistic *without* the incumbent feature, gradient boosting, hist gradient boosting, random forest, extra trees, gaussian naïve Bayes, k-nearest neighbors, neural net (MLP) |
| **Ensemble** | mean of incumbent + logistic + hist-GBM |

---

## Method (why the comparison is fair)

- **One leak-free walk-forward pass** builds a 31-column feature matrix per
  player-game (usage, opportunity shares, efficiency, team/opponent ratings, and
  the incumbent's own outputs). Features use only prior games.
- **Split:** train ML on **2021–2022** (8,993 rows), test on **2023–2024**
  (9,612 rows / 569 games) — the same test window as the original backtest.
- **Same candidate set:** every model ranks the identical active, has-history
  players in each game, so they differ only in *how they score a player*.
- **Honest probabilities:** ML models are calibrated **out-of-fold** on the
  training seasons (isotonic via 4-fold CV); heuristic/statistical scores get an
  isotonic map fit on train. **AUC and pick metrics use the raw score ordering**,
  so calibration can't flatter them.

---

## Full ranking #1 — pick accuracy (did the #1 pick score a TD?)

| # | Model | Top-1 | Top-2 | AUC | Brier | LogLoss |
|---|---|---|---|---|---|---|
| 1 | random forest | **51.1%** | 70.5% | 0.695 | 0.1541 | 0.4852 |
| 2 | logistic (no incumbent feat) | 50.6% | 71.0% | 0.701 | 0.1530 | 0.4792 |
| 3 | gaussian naïve Bayes | 50.6% | **72.6%** | 0.693 | 0.1540 | 0.4803 |
| 4 | **logistic regression** | 50.3% | 71.7% | **0.701** | **0.1530** | **0.4789** |
| 5 | k-nearest neighbors | 50.1% | 71.2% | 0.681 | 0.1551 | 0.4834 |
| 6 | gradient boosting | 48.9% | 70.1% | 0.691 | 0.1549 | 0.4821 |
| 7 | extra trees | 48.9% | 71.2% | 0.701 | 0.1531 | 0.4847 |
| 8 | ensemble (incumbent+LR+GBM) | 48.5% | 71.0% | 0.698 | 0.1532 | 0.4821 |
| 9 | **Poisson allocation (incumbent)** | 48.3% | 68.9% | 0.680 | 0.1559 | 0.4867 |
| 10 | weighted volume | 47.5% | 69.2% | 0.661 | 0.1582 | 0.4911 |
| 11 | hist gradient boosting | 47.5% | 71.0% | 0.687 | 0.1550 | 0.4824 |
| 12 | player-rate Poisson | 47.1% | 69.8% | 0.694 | 0.1546 | 0.4899 |
| 13 | league-rate Poisson | 46.7% | 67.3% | 0.685 | 0.1559 | 0.4836 |
| 14 | volume (touches) | 46.7% | 68.2% | 0.679 | 0.1565 | 0.4856 |
| 15 | historical TD rate | 46.6% | 66.6% | 0.671 | 0.1572 | 0.4931 |
| 16 | neural net (MLP) | 45.2% | 66.1% | 0.682 | 0.1559 | 0.4974 |
| 17 | hot hand (recent) | 41.5% | 64.5% | 0.660 | 0.1594 | 0.4945 |
| 18 | base rate (no skill) | 20.4% | 38.0% | 0.502 | 0.1679 | 0.5185 |

## Full ranking #2 — probability quality (the statistically reliable ranking)

| # | Model | AUC | Brier | LogLoss | ECE | Top-1 |
|---|---|---|---|---|---|---|
| 1 | **logistic regression** | **0.701** | **0.1530** | **0.4789** | 0.017 | 50.3% |
| 2 | logistic (no incumbent feat) | 0.701 | 0.1530 | 0.4792 | 0.018 | 50.6% |
| 3 | extra trees | 0.701 | 0.1531 | 0.4847 | 0.022 | 48.9% |
| 4 | ensemble (incumbent+LR+GBM) | 0.698 | 0.1532 | 0.4821 | 0.014 | 48.5% |
| 5 | random forest | 0.695 | 0.1541 | 0.4852 | 0.022 | 51.1% |
| 6 | player-rate Poisson | 0.694 | 0.1546 | 0.4899 | 0.021 | 47.1% |
| 7 | gaussian naïve Bayes | 0.693 | 0.1540 | 0.4803 | 0.022 | 50.6% |
| 8 | gradient boosting | 0.691 | 0.1549 | 0.4821 | 0.023 | 48.9% |
| 9 | hist gradient boosting | 0.687 | 0.1550 | 0.4824 | 0.018 | 47.5% |
| 10 | league-rate Poisson | 0.685 | 0.1559 | 0.4836 | 0.008 | 46.7% |
| 11 | neural net (MLP) | 0.682 | 0.1559 | 0.4974 | 0.012 | 45.2% |
| 12 | k-nearest neighbors | 0.681 | 0.1551 | 0.4834 | 0.023 | 50.1% |
| 13 | **Poisson allocation (incumbent)** | 0.680 | 0.1559 | 0.4867 | 0.016 | 48.3% |
| 14 | volume (touches) | 0.679 | 0.1565 | 0.4856 | 0.009 | 46.7% |
| 15 | historical TD rate | 0.671 | 0.1572 | 0.4931 | 0.020 | 46.6% |
| 16 | weighted volume | 0.661 | 0.1582 | 0.4911 | 0.007 | 47.5% |
| 17 | hot hand (recent) | 0.660 | 0.1594 | 0.4945 | 0.028 | 41.5% |
| 18 | base rate (no skill) | 0.502 | 0.1679 | 0.5185 | 0.005 | 20.4% |

---

## What drives the best model

Standardized logistic-regression coefficients and random-forest importances agree
on the signal:

| Logistic (std. coef.) | | Random forest (importance) | |
|---|---|---|---|
| `carry_share` | **+0.46** | `proj_touches` | 0.107 |
| `proj_rush_yds` | +0.27 | `carry_share` | 0.082 |
| `target_share` | +0.18 | `anytime_rate` | 0.074 |
| `proj_rec_yds` | +0.16 | `proj_rec_yds` | 0.065 |
| `anytime_rate` | +0.12 | `proj_rush_yds` | 0.061 |
| `opp_def_rush` | +0.12 | `proj_targets` | 0.059 |

**Read:** *share of the team's opportunity* (especially **carry_share** — the
goal-line/workhorse role) is the strongest signal, ahead of raw volume; recent
rushing/receiving yardage, the player's own shrunk scoring rate, and the
opponent's rush-defense softness follow. (Raw `proj_carries` even flips slightly
negative in the logistic model once share and yards are included — the *share* is
what carries the goal-line information.)

---

## Key findings

1. **A plain logistic regression is the most accurate and best-calibrated model** —
   and it wins **even without** the incumbent Poisson as a feature (row 2), so
   it's not just stacking: ML extracts a bit more signal than the hand-built
   functional form.
2. **The incumbent Poisson is solid but mid-pack.** It's essentially a good,
   fixed-weight special case of what logistic learns freely from the data. Its
   edge is *interpretability*, not raw accuracy.
3. **Complexity didn't pay.** Gradient boosting, hist-GBM and the MLP land at or
   below the simple models. With a noisy binary target and ~20 features, flexible
   models mostly fit noise.
4. **"Hot hand" is a trap.** Ranking by recent TDs (41.5%) is *worse* than
   ranking by volume — touchdowns don't persist game-to-game; opportunity does.
5. **Everything from ~47% up beats pure volume (46.7%)** but not by much on the
   single top pick — the gains are larger and more reliable in *probability
   quality* (AUC/Brier), which is what powers the likelihood + confidence outputs.

---

## Recommendation

Adopt **logistic regression** as the primary scorer (best accuracy + calibration
+ interpretable coefficients + trivial to serve), and **keep the Poisson
allocation model as an interpretable cross-check** and as a feature. The
gradient-boosted / neural models add nothing here and aren't worth the
complexity. If this is ever productionized, the highest-value next inputs remain
the same as before: **implied team totals from the odds market** and **real
goal-line / red-zone usage** — those would lift *every* model on this list.

---

## Files

| File | Purpose |
|---|---|
| `research/nfl-td-scorer/backtest.py` | Walk-forward engine; emits the shared feature matrix (`collect_features=True`) |
| `research/nfl-td-scorer/bakeoff.py` | Defines all 18 models, trains/evaluates them on the shared test set, prints both rankings |
| `research/nfl-td-scorer/bakeoff_results.csv`, `bakeoff_metrics.json` | Saved numbers behind the tables above |
| `research/nfl-td-scorer/features.csv` | The 18,605-row leak-free feature matrix (regenerable) |
