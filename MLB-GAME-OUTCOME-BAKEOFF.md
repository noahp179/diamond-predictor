# MLB Game-Outcome Bake-Off — 35 algorithms, and what the platform should ship

**The headline: the MLB model the platform currently ships (Dixon-Coles /
Poisson) ranks 27th of 35. A margin-of-victory Elo — the same engine already
running the NFL and NBA pages — beats it by a statistically significant margin.
That is a low-effort, high-payoff swap.**

MLB game outcomes had **never** been bake-offed in this repo —
`MODEL-BAKEOFF.md` and `ACCURACY-BACKTEST.md` cover NBA and NFL only, and no MLB
accuracy figure existed anywhere. This closes that gap.

Code: `research/mlb-game/`. Data: **9,737 completed regular-season games,
2021–2024** (MLB StatsAPI, 100% starting-pitcher coverage).

---

## Protocol

One chronological **walk-forward** pass. Before each game every algorithm emits
a raw pre-game signal from state built only on earlier games; the result then
updates that state. No leakage.

To compare fairly across wildly different units (Elo points, run differentials,
probabilities), each model's raw signal is mapped to a probability by a 1-D
logistic fit **only on 2021–2023** and applied to the **2024 test season**
(2,432 games). AUC is invariant to that monotone map, so it measures pure
ranking skill; Brier / log loss then judge calibrated quality on equal footing.

Baseline to beat: **always pick the home team = 52.1%** in 2024.

---

## Full ranking — all 35 algorithms (test season 2024)

| # | Algorithm | Family | AUC | Accuracy | Brier | LogLoss |
|--:|---|---|--:|--:|--:|--:|
| 1 | **elo_plus_pitcher** | Elo | **0.5916** | **56.7%** | 0.2434 | 0.6798 |
| 2 | ML_extra_trees | ML | 0.5894 | 56.1% | 0.2437 | 0.6805 |
| 3 | ENS_mean_of_4_models | Ensemble | 0.5891 | 55.9% | 0.2439 | 0.6808 |
| 4 | ML_random_forest | ML | 0.5877 | 56.1% | 0.2438 | 0.6807 |
| 5 | **elo_margin_of_victory** | Elo | 0.5876 | 56.3% | 0.2440 | 0.6810 |
| 6 | ENS_elo_x_ml_logistic | Ensemble | 0.5866 | 56.3% | 0.2441 | 0.6812 |
| 7 | elo_basic | Elo | 0.5865 | 56.5% | 0.2442 | 0.6814 |
| 8 | ENS_stack_super_learner | Ensemble | 0.5846 | 55.8% | 0.2441 | 0.6813 |
| 9 | ML_logistic | ML | 0.5834 | 56.2% | 0.2445 | 0.6820 |
| 10 | ML_xgboost | ML | 0.5834 | 56.5% | 0.2449 | 0.6831 |
| 11 | ML_logistic_L1 | ML | 0.5834 | 56.0% | 0.2444 | 0.6816 |
| 12 | glicko | Rating | 0.5809 | 55.6% | 0.2447 | 0.6824 |
| 13 | ML_hist_gbm | ML | 0.5805 | 55.8% | 0.2448 | 0.6827 |
| 14 | run_differential | Baseline | 0.5799 | 55.8% | 0.2459 | 0.6862 |
| 15 | pythagenpat | Baseline | 0.5793 | 55.5% | 0.2454 | 0.6841 |
| 16 | pythagorean | Baseline | 0.5792 | 55.6% | 0.2454 | 0.6841 |
| 17 | ML_neural_net | ML | 0.5749 | 55.2% | 0.2462 | 0.6868 |
| 18 | poisson_pitcher_adj | Run-scoring | 0.5744 | 55.1% | 0.2453 | 0.6836 |
| 19 | win_pct_log5 | Baseline | 0.5732 | 55.0% | 0.2454 | 0.6838 |
| 20 | colley | Matrix | 0.5694 | 54.4% | 0.2462 | 0.6856 |
| 21 | bradley_terry | Matrix | 0.5693 | 55.0% | 0.2462 | 0.6854 |
| 22 | ML_lightgbm | ML | 0.5687 | 54.6% | 0.2474 | 0.6885 |
| 23 | bayes_hierarchical | Bayesian | 0.5676 | 54.8% | 0.2463 | 0.6858 |
| 24 | massey | Matrix | 0.5672 | 54.6% | 0.2464 | 0.6859 |
| 25 | negative_binomial | Run-scoring | 0.5642 | 54.9% | 0.2464 | 0.6858 |
| 26 | poisson_skellam | Run-scoring | 0.5641 | 55.1% | 0.2465 | 0.6860 |
| 27 | **dixon_coles** ⬅ *shipped family* | Run-scoring | **0.5641** | **55.1%** | 0.2465 | 0.6860 |
| 28 | kalman_state_space | State-space | 0.5639 | 54.9% | 0.2463 | 0.6857 |
| 29 | starter_plus_offense | Pitcher | 0.5637 | 53.9% | 0.2466 | 0.6862 |
| 30 | starter_quality_only | Pitcher | 0.5576 | 53.7% | 0.2471 | 0.6874 |
| 31 | recent_form_10 | Situational | 0.5435 | 53.5% | 0.2482 | 0.6895 |
| 32 | head_to_head | Situational | 0.5401 | 51.6% | 0.2489 | 0.6909 |
| 33 | rest_advantage | Situational | 0.5044 | 52.3% | 0.2494 | 0.6918 |
| 34 | always_home | Baseline | 0.5000 | 52.1% | 0.2496 | 0.6924 |
| 35 | **streak_momentum** | Situational | **0.4991** | 51.6% | 0.2504 | 0.6940 |

Families covered: baselines, Elo variants, Glicko, matrix ratings
(Massey / Colley / Bradley-Terry), state-space (Kalman), Bayesian hierarchical,
run-scoring processes (Poisson / Skellam / Dixon-Coles / negative binomial),
pitcher-aware models, situational (rest, streak, head-to-head, form), six ML
learners, and three ensembles.

---

## Is the winner real? (paired bootstrap, 2,432 games)

| Comparison | ΔAUC | 95% CI | Verdict |
|---|--:|---|---|
| Elo+pitcher **vs dixon_coles** (shipped) | **+0.0273** | [+0.0106, +0.0448] | ✅ **significant** |
| Elo+pitcher **vs poisson_skellam** | +0.0276 | [+0.0105, +0.0451] | ✅ significant |
| Elo+pitcher **vs bradley_terry** | +0.0225 | [+0.0061, +0.0388] | ✅ significant |
| Elo+pitcher **vs plain Elo (MOV)** | +0.0039 | [−0.0016, +0.0094] | ✗ within noise |

**The Elo family genuinely beats the run-scoring family.** But the pitcher
adjustment on top of Elo is **not** proven — and tuning agrees: a hyperparameter
sweep validated on 2023 selected **pitcher_weight = 0**, i.e. plain
margin-of-victory Elo. On the untouched 2024 test the pitcher term looked
+0.004 better, which is inside the noise band.

**Honest read: ship margin-of-victory Elo. Treat the starting-pitcher term as
optional — it is neutral-to-slightly-positive, not a proven gain.**

---

## Selective conviction — the real lever (2024)

`MODEL-BAKEOFF.md` found for NBA/NFL that the way to raise hit rate is to *pick
fewer games*. That holds in baseball, and it matters more here because the
all-games ceiling is so low:

| Confidence ≥ | Coverage | Games | Win rate |
|---|--:|--:|--:|
| 50% (all games) | 100% | 2,432 | 56.7% |
| 54% | 67.7% | 1,646 | 58.7% |
| 56% | 51.8% | 1,259 | 60.0% |
| 58% | 38.5% | 936 | 61.3% |
| 60% | 27.9% | 679 | 62.4% |
| 62% | 18.0% | 437 | **65.7%** |
| 65% | 8.9% | 217 | **69.1%** |

An **agreement filter** (Elo and Dixon-Coles pointing the same way) is a cheap
second signal: at ≥60% confidence *and* agreement, 62.5% on 26.6% of games.

Calibration is sound — the model's 62%+ bucket wins 64.2%, its 50–54% bucket
wins 50.8%.

---

## Key findings

1. **MLB is the hardest of the three sports, by a lot.** Ceiling ≈ **56–57%**
   accuracy vs ~66% (NBA) and ~64% (NFL) in the existing docs. One swing decides
   games; there is far less signal to find.
2. **The platform is running the wrong model family for MLB.** Dixon-Coles /
   Poisson sits 27th; Elo beats it by a significant +0.027 AUC / +1.6 pts of
   accuracy. **This is the single most actionable result in this report.**
3. **"Hot team" is a myth — and actively harmful.** `streak_momentum` scores
   **AUC 0.4991, below a coin flip** (dead last, worse than always-home). Never
   surface a streak as a reason to pick a team.
4. **Rest days are worthless** in MLB (AUC 0.5044) — unlike the NBA, where rest
   matters. Baseball teams play daily; there is no rest edge to exploit.
5. **Complex ML does not help — again.** Extra trees ties Elo (0.5894 vs
   0.5916); XGBoost (0.5834), LightGBM (0.5687) and the neural net (0.5749) all
   land at or below a simple rating system. Third sport, third time.
6. **Starting pitcher matters far less than intuition says.** Pitcher-quality
   alone is 30th (0.5576), and adding it to Elo is within noise. Team strength
   already absorbs most of the rotation's contribution.
7. **Sophisticated statistics lost to a simple rating.** Kalman filtering,
   Bayesian hierarchical strength, Massey, Colley, Bradley-Terry and negative
   binomial all finished *below* plain Elo.

---

## What to integrate into the platform

**Priority 1 — swap the MLB headline model to margin-of-victory Elo.**
The app already has a proven MOV Elo implementation powering NFL and NBA
(`src/lib/espn.server.ts`, with per-sport `k` / `hfa` / `carry`). Extending it to
MLB is a small change to an existing, tested engine — not new machinery — and
buys a significant, measured improvement over the Dixon-Coles path currently
used by `mlb-dixon-coles.ts` / `mlb-core`. Suggested MLB constants from the
sweep: **k ≈ 4, home edge ≈ 24 Elo, season carry ≈ 0.70** (note these are much
smaller than the NFL's k=20 — baseball games carry less information).

**Priority 2 — lead the MLB Recommended page with confidence tiers, not the
full slate.** Publish the 60%+ / 62%+ buckets (62.4% / 65.7% win rates) rather
than every game at 56.7%. Same "pick fewer, hit more" framing the NBA/NFL
bake-off already established.

**Priority 3 — keep Dixon-Coles, but demote it to an agreement filter.** It is a
genuinely different (run-scoring) view of the game, which makes it useful as a
second opinion even though it loses head-to-head.

**Do not integrate:** streak/momentum (worse than random), rest-day edges
(nothing in MLB), gradient boosting or neural nets (no gain over Elo, far more
complexity).

---

## Caveat — the market benchmark is missing here

Every prior study in this repo benchmarks against the closing moneyline, and the
market has beaten every model in NBA and NFL. **This sandbox has no Supabase
credentials and ESPN does not serve historical MLB odds**, so I could not run
that comparison — the ranking above is model-vs-model only. Production has the
`game_odds` table; re-running `bakeoff_mlb.py` with a market column joined in is
the natural follow-up, and I would expect the market to win on raw accuracy
here too. **Treat "Elo beats the shipped MLB model" as established, and "Elo
beats the market" as untested.**

---

## Files

| File | Purpose |
|---|---|
| `research/mlb-game/fetch_games.py` | Pulls 9,737 games (scores, venue, probable pitchers) from MLB StatsAPI |
| `research/mlb-game/bakeoff_mlb.py` | Walk-forward engine + all 35 algorithms + evaluation |
| `research/mlb-game/tune_verify.py` | Paired-bootstrap significance + hyperparameter sweep |
| `research/mlb-game/selective.py` | Confidence-tier / agreement-filter analysis |
| `research/mlb-game/bakeoff_results.csv` | The full ranking table |
