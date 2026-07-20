# NFL Anytime-TD-Scorer — Full Ranking of All 25 Algorithms

The capstone. Four rounds of modeling, every algorithm judged on the **same
held-out games (2023–2024, 569 games, 9,612 predictions)**, over the **same
candidate players per game**, with the **same metrics**. This is the complete,
ranked scoreboard.

📊 **Interactive version (sortable/filterable):**
https://claude.ai/code/artifact/2e594f73-3771-43f6-b3c4-931b85540da2

Prior write-ups: [`NFL-TD-SCORER-BACKTEST.md`](NFL-TD-SCORER-BACKTEST.md) (round 1),
[`NFL-TD-SCORER-BAKEOFF.md`](NFL-TD-SCORER-BAKEOFF.md) (round 2),
[`NFL-TD-SCORER-ADVANCED.md`](NFL-TD-SCORER-ADVANCED.md) (round 3).

---

## The ranking metric

Rank is by **AUC** — how reliably a model rates an actual scorer above a
non-scorer. Over 9,612 predictions its confidence interval is tight (~±0.008),
so it separates models honestly. **Top-1 hit rate** (did the single #1 pick
score?) is the intuitive "accuracy," but over 569 games it carries a **±3.4%
noise band**, so treat small top-1 gaps as ties. Brier / log loss measure
probability quality (both calibrated out-of-fold).

---

## 🏆 The complete leaderboard (all 25, by AUC)

| # | Model | Family | AUC | Brier | LogLoss | Top-1 | Top-2 |
|--:|---|---|--:|--:|--:|--:|--:|
| 1 | **STACK + market** | Ensemble | **0.708** | **0.1521** | **0.4741** | 51.5% | 71.7% |
| 2 | HTS + market | Hierarchical | 0.707 | 0.1529 | 0.4758 | 49.9% | 70.5% |
| 3 | Market-Poisson (total × share) | Statistical | 0.706 | 0.1530 | 0.4761 | 48.9% | 69.8% |
| 4 | logistic + market | ML | 0.704 | 0.1526 | 0.4755 | 50.3% | 70.3% |
| 5 | STACK super-learner (6) | Ensemble | 0.704 | 0.1525 | 0.4752 | 51.7% | 70.8% |
| 6 | RANKAVG ensemble (5) | Ensemble | 0.702 | 0.1529 | 0.4760 | 49.6% | 71.4% |
| 7 | logistic regression | ML | 0.701 | 0.1530 | 0.4789 | 50.3% | 71.7% |
| 8 | HTS hierarchical (team × share) | Hierarchical | 0.701 | 0.1538 | 0.4781 | 49.0% | 68.9% |
| 9 | logistic (no incumbent feat) | ML | 0.701 | 0.1530 | 0.4792 | 50.6% | 71.0% |
| 10 | extra trees | ML | 0.701 | 0.1531 | 0.4847 | 48.9% | 71.2% |
| 11 | ensemble (mean: inc+LR+GBM) | Ensemble | 0.698 | 0.1532 | 0.4821 | 48.5% | 71.0% |
| 12 | random forest | ML | 0.695 | 0.1541 | 0.4852 | 51.1% | 70.5% |
| 13 | player-rate Poisson | Statistical | 0.694 | 0.1546 | 0.4899 | 47.1% | 69.8% |
| 14 | gaussian naïve Bayes | ML | 0.693 | 0.1540 | 0.4803 | 50.6% | 72.6% |
| 15 | gradient boosting | ML | 0.691 | 0.1549 | 0.4821 | 48.9% | 70.1% |
| 16 | hist gradient boosting | ML | 0.687 | 0.1550 | 0.4824 | 47.5% | 71.0% |
| 17 | league-rate Poisson | Statistical | 0.685 | 0.1559 | 0.4836 | 46.7% | 67.3% |
| 18 | neural net (MLP) | ML | 0.682 | 0.1559 | 0.4974 | 45.2% | 66.1% |
| 19 | k-nearest neighbors | ML | 0.681 | 0.1551 | 0.4834 | 50.1% | 71.2% |
| 20 | **Poisson allocation** ⭐ *(the original)* | Statistical | 0.680 | 0.1559 | 0.4867 | 48.3% | 68.9% |
| 21 | volume (touches) | Heuristic | 0.679 | 0.1565 | 0.4856 | 46.7% | 68.2% |
| 22 | historical TD rate | Heuristic | 0.671 | 0.1572 | 0.4931 | 46.6% | 66.6% |
| 23 | weighted volume | Heuristic | 0.662 | 0.1582 | 0.4911 | 47.5% | 69.2% |
| 24 | hot hand (recent TDs) | Heuristic | 0.660 | 0.1594 | 0.4945 | 41.5% | 64.5% |
| 25 | base rate (no skill) | Heuristic | 0.502 | 0.1679 | 0.5185 | 20.4% | 38.0% |

**The four market-enhanced models sweep the top four.** The original hand-built
Poisson — round 1 — sits at #20, now beaten by everything built since.

---

## How the ceiling moved, round by round

| Round | What was added | Best model | Best AUC | Δ |
|---|---|---|---|---|
| 1 | Hand-built usage × matchup Poisson | Poisson allocation | 0.680 | — |
| 2 | 18-algorithm bake-off | logistic regression | 0.701 | +0.021 |
| 3 | Hierarchical model + stacking | STACK super-learner | 0.704 | +0.003 |
| 4 | **Market implied team total** | **STACK + market** | **0.708** | +0.004 |

Rounds 2→3 barely moved (better algorithms on the same information). Round 4
moved it with **new information** — and did so significantly.

---

## Best in each family

| Family | Best member | AUC | Verdict |
|---|---|---|---|
| **Ensemble** | STACK + market | **0.708** | Champion — combining diverse models + market |
| **Hierarchical** | HTS + market | 0.707 | Structure + market; most interpretable top-tier |
| **Statistical** | Market-Poisson | 0.706 | A *trivial* market-total × share model ties the ML stack |
| **ML** | logistic + market | 0.704 | Simple linear model, market-fed |
| **Heuristic** | volume (touches) | 0.679 | The "reasonable floor" you must beat |

---

## Round 4 in detail — did the market break the ceiling? (yes, significantly)

I added the closing **spread + total** (from nflverse), turned them into each
team's **implied total** = `total/2 + team_margin/2`, and re-ran the strongest
models with vs. without it. Paired, clustered-by-game bootstraps:

| Model | AUC without market | AUC with market | Δ AUC (95% CI) | Verdict |
|---|--:|--:|---|---|
| logistic | 0.701 | 0.704 | +0.0032 [+0.0009, +0.0054] | ✅ significant |
| HTS hierarchical | 0.701 | 0.707 | +0.0062 [+0.0039, +0.0084] | ✅ significant |
| STACK super-learner | 0.704 | 0.708 | +0.0043 [+0.0025, +0.0059] | ✅ significant |

All three intervals clear zero — the market's ranking lift is **real**, not
noise. (Top-1 deltas stay within the ±3.4% game-level band, as always.) Tellingly,
**Market-Poisson** — market implied-total × usage share, no learning on the
scoring side — scores **0.706**, matching the entire no-market ML stack. Once
the logistic model can see the market, `team_exp_rush_td` (my EWMA team estimate)
flips to a **negative** coefficient: the market total supersedes it.

---

## The four findings, across all 25 models

1. **Volume is most of the signal.** The top driver everywhere is `carry_share`
   (share of the team's carries — the goal-line role), ahead of raw volume.
   Everything above AUC 0.68 is a variation on "who gets the ball near the goal line."
2. **Simple beat complex.** A plain logistic regression (0.701) matched or beat
   gradient boosting, hist-GBM, a neural net, and kNN. The super-learner gave
   boosting a *negative* weight. Noisy target + ~20 features rewards simplicity.
3. **Structure earned its keep.** The hierarchical competing-risks model (predict
   the team's TD total, then who wins it) tied the best single model and was the
   **most-trusted ingredient** in the stack (meta-weight 1.74 vs logistic's 1.56).
4. **Only information broke the ceiling.** Better algorithms on the same features
   plateaued at ~0.701–0.704; the market total pushed a **significant** further
   step. The limit was information, not modeling.

---

## Recommendation

- **Ship the STACK + market** as the primary scorer — best on every probability
  metric. For a simpler production path, **logistic + market** or **HTS + market**
  are statistically equivalent and far easier to serve and explain.
- **Keep HTS in any blend** — it's the meta-learner's favorite and the only model
  that yields a coherent, explainable team-total decomposition.
- **Retire** gradient boosting, the MLP, and "hot hand" (chasing recent TDs at
  0.660 is *worse* than plain volume).
- **Next gains are data, not models:** goal-line / red-zone play-by-play usage and
  injury-adjusted snap shares are the remaining levers.

---

## Files

| File | Purpose |
|---|---|
| `research/nfl-td-scorer/master_leaderboard.csv` | The 25-model table above |
| `research/nfl-td-scorer/market.py` | Market implied-total features + with/without significance tests |
| `research/nfl-td-scorer/advanced.py` | Hierarchical model + stacked super-learner (vectorized conditional logit) |
| `research/nfl-td-scorer/bakeoff.py` | The 18-model bake-off |
| `research/nfl-td-scorer/market_metrics.json`, `bakeoff_metrics.json`, `advanced_metrics.json` | Saved numbers |
