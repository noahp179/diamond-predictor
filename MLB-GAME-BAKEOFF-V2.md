# MLB Game Model — Round 2: Does Anything Beat What We Ship?

[Round 1](MLB-GAME-OUTCOME-BAKEOFF.md) bake-offed 35 algorithms on 2021–24 and
found the then-shipped Dixon-Coles model ranked 27th; a margin-of-victory Elo
won the swap and is what the app runs today (`sim-elo-v2` in
`src/lib/mlb-sim.ts`). This round asks the follow-up question properly:

1. **Now that Elo ships, does anything beat it?** Including the shipped model
   itself in the race, replayed constant-for-constant.
2. **Does aggregating models help?** Fifteen ensemble strategies, not the two
   hand-picked blends round 1 tried.
3. **Was round 1's ranking even stable?** One test season is ~1,700 games.

Code: `research/mlb-game/bakeoff_v2.py`, `confidence_check.py`, `corr_check.py`.

---

## TL;DR

- **Nothing beats the shipped model.** Over a pooled walk-forward test of
  **9,009 games (2023–2026)** the shipped Elo ranks **6th of 46**, and the five
  above it beat it by at most **+0.0019 AUC — every one inside the noise band**
  (paired bootstrap CI crosses zero). It also posts the **best accuracy on the
  entire board (56.4%)** and near-best calibration (ECE 0.005).
- **Aggregation does not help here.** All fifteen ensembles land in a 0.003-AUC
  huddle around the shipped model. The reason is measurable: the models'
  log-odds correlate **0.745 on average**, and some pairs are effectively the
  same model (Colley vs Bradley-Terry: **1.00**; Massey vs Bayesian
  hierarchical: **0.99**). Averaging thirteen views of the same run differential
  gives you one view.
- **A one-season leaderboard is mostly noise.** `elo_plus_pitcher` finished
  **1st in 2024 and 2025 — and 26th in 2026**. That is why round 1's exact
  ordering should never have been read closely; its headline (Elo ≫ Dixon-Coles)
  survives, its rank ordering does not.
- **The model's confidence is real and worth leading with.** The three most
  confident picks per day won **62.1%** across 2023–26, against 56.4% for all
  its picks and 52.7% for always taking the home team — which is what the
  re-ranked Best Odds page now shows first.
- **Recommendation: no model swap.** The shipped Elo is at the ceiling of what
  this feature set supports. Ship nothing; keep the verification.

---

## Protocol

**Data:** 13,877 completed regular-season games, **2021 → 2026-08-04**, from MLB
StatsAPI (scores, venue, both starting pitchers). One chronological walk-forward
pass: before each game every algorithm emits a signal from state built only on
earlier games, then the result updates that state.

**Evaluation:** each of the four seasons 2023–2026 takes its turn as the test
set, calibrated only on the seasons before it, and the four test sets are pooled
(9,009 games). Raw signals map to probabilities through a 1-D logistic fit on
calibration seasons only; AUC is invariant to that monotone map, so it measures
pure ranking skill, while Brier / log loss / ECE judge the calibrated numbers.
Ensemble weights are fit on **season-wise out-of-fold** probabilities, so no
stacking weight ever sees a probability fit on its own label.

**The shipped model in the race:** `SHIPPED_elo_v2` replays
`mlb-sim.ts computeElo` exactly — K=6, home field +24, between-season carry 0.75,
FiveThirtyEight-style margin multiplier `(margin+1)^0.7 / (7.5 + 0.006·eloDiff)`.

---

## Result — pooled walk-forward, 2023–2026 (9,009 games)

Top of the board (full table in `bakeoff_v2_pooled.csv`; always-home = 52.7%):

| # | Algorithm | AUC | Accuracy | Brier | LogLoss | ECE |
|--:|---|--:|--:|--:|--:|--:|
| 1 | elo_plus_pitcher | 0.5813 | 56.2% | 0.2441 | 0.6811 | 0.010 |
| 2 | AGG_diverse_families | 0.5805 | 55.7% | 0.2442 | 0.6814 | 0.008 |
| 3 | AGG_logit_mean_top3 | 0.5799 | 56.2% | 0.2443 | 0.6816 | 0.010 |
| 4 | AGG_shipped_elo × best ML | 0.5799 | 56.1% | 0.2442 | 0.6814 | 0.004 |
| 5 | AGG_logit_mean_top5 | 0.5798 | 56.2% | 0.2442 | 0.6814 | 0.007 |
| **6** | **SHIPPED_elo_v2** | **0.5794** | **56.4%** | 0.2443 | 0.6816 | 0.005 |
| 7 | elo_margin_of_victory | 0.5794 | 56.0% | 0.2444 | 0.6818 | 0.013 |
| 8 | AGG_bayesian_model_avg | 0.5793 | 55.8% | 0.2443 | 0.6816 | 0.009 |
| … | … | … | … | … | … | … |
| 16 | ML_extra_trees | 0.5785 | 55.8% | 0.2444 | 0.6818 | 0.006 |
| 21 | ML_random_forest | 0.5760 | 55.6% | 0.2448 | 0.6827 | 0.016 |
| 31 | ML_xgboost | 0.5641 | 55.2% | 0.2477 | 0.6888 | 0.029 |
| 33 | dixon_coles *(what round 1 replaced)* | 0.5636 | 55.0% | 0.2462 | 0.6855 | 0.014 |
| 40 | ML_lightgbm | 0.5609 | 54.7% | 0.2492 | 0.6922 | 0.041 |
| 46 | rest_advantage | 0.4924 | 52.8% | 0.2493 | 0.6916 | 0.004 |

### Is anything above it actually better?

Paired bootstrap on the AUC difference vs the shipped model, 2,000 resamples:

| Challenger | ΔAUC | 95% CI | Verdict |
|---|--:|---|---|
| elo_plus_pitcher | +0.0019 | [−0.0018, +0.0057] | not significant |
| AGG_diverse_families | +0.0012 | [−0.0027, +0.0050] | not significant |
| AGG_logit_mean_top3 | +0.0005 | [−0.0018, +0.0029] | not significant |
| AGG_shipped_elo × best ML | +0.0005 | [−0.0015, +0.0023] | not significant |
| AGG_logit_mean_top5 | +0.0004 | [−0.0015, +0.0022] | not significant |
| elo_margin_of_victory | +0.0001 | [−0.0024, +0.0026] | not significant |

**Every interval crosses zero.** There is no swap to make.

---

## The aggregation question, answered

Fifteen strategies were tested: mean of probabilities, mean of log-odds, median,
trimmed mean, rank-average, top-3 / top-5 / top-10 log-odds means, inverse-log-loss
weighting, tempered Bayesian model averaging, non-negative least-squares weights,
logistic and ridge stacks on the top-10 log-odds, one-model-per-family diversity
averaging, and the shipped recipe generalized (shipped Elo × best ML model).

They finish between **0.5771 and 0.5805** — a 0.003 spread, with the shipped
single model sitting inside it. Why so flat:

| pair | correlation of log-odds |
|---|--:|
| Colley vs Bradley-Terry | **1.00** |
| Massey vs Bayesian hierarchical | 0.99 |
| shipped Elo vs Elo margin-of-victory | 0.98 |
| Kalman vs Dixon-Coles | 0.96 |
| **mean over all 13 rating families** | **0.745** |

Thirteen algorithms, but not thirteen opinions — they are all reading the same
run differential through different arithmetic. Ensembling pays when members make
*different* mistakes; here they make the same one. The only genuinely
decorrelated members (run differential at 0.42–0.60 against the Elo family) are
also the weakest, so adding them costs as much as it gains.

The two aggregations that do edge ahead of the raw mean are the ones that *stop
averaging*: top-3 / top-5 (0.5799 / 0.5798) and one-per-family (0.5805). Both
still tie the shipped model.

---

## How unstable is a one-season leaderboard?

Rank of each model by test season (46 models):

| Model | 2023 | 2024 | 2025 | 2026 | mean | swing |
|---|--:|--:|--:|--:|--:|--:|
| AGG_logit_mean_top5 | 8 | 2 | 11 | 11 | 8.0 | 9 |
| AGG_shipped_elo × best ML | 11 | 3 | 14 | 5 | 8.2 | 11 |
| **elo_plus_pitcher** | 6 | **1** | **1** | **26** | 8.5 | **25** |
| AGG_diverse_families | 13 | 17 | 2 | 9 | 10.2 | 15 |
| AGG_logit_mean_top3 | 3 | 9 | 10 | 22 | 11.0 | 19 |
| **SHIPPED_elo_v2** | 15 | 11 | 16 | **8** | 12.5 | **8** |

The "winner" of a single season swings 25 places the next year. The shipped
model has the **smallest swing in the top group** — it is never first and never
bad, which is the profile you want in production. On its own, the 2026 season
would have crowned `ML_random_forest` (AUC 0.5622 vs shipped 0.5586, CI
[−0.0110, +0.0180]) — a coin flip dressed as a discovery.

---

## Confidence check — validating the new Best Odds default

The Best Odds page now leads with **model confidence** (the surest picks,
payout ignored). Replaying the shipped Elo over 2023–26 and bucketing its picks:

| Model confidence | picks | predicted | actually won | breakeven price |
|---|--:|--:|--:|--:|
| 50–53% | 2,365 | 0.514 | 0.524 | −110 |
| 53–56% | 2,032 | 0.545 | 0.547 | −121 |
| 56–59% | 1,811 | 0.574 | 0.559 | −127 |
| 59–62% | 1,310 | 0.604 | 0.572 | −134 |
| 62–65% | 745 | 0.634 | 0.617 | −161 |
| 65%+ | 746 | 0.678 | 0.676 | −208 |

And the page's actual view — the day's most confident picks:

| Picks per day | n | hit rate |
|---|--:|--:|
| top 1 | 682 | **62.9%** |
| top 2 | 1,356 | 62.7% |
| top 3 | 2,025 | **62.1%** |
| top 5 | 3,336 | 59.9% |
| all picks | 9,009 | 56.4% |

Season by season the top-3 rate is 60.2% / 61.8% / 66.1% / 59.7% — no single
year carrying it. Confidence is mildly **over**-stated in the 56–62% band
(predicted 0.60, actual 0.57) and honest at the extremes.

**Caveat that matters for betting:** these are win rates, not profits. A pick
that wins 62% at a −180 price still loses money. The page says "safest, not
+EV" for exactly this reason.

---

## Still missing: the market benchmark

As in round 1, there is no historical MLB moneyline in this sandbox (ESPN does
not serve it and the `game_odds` table lives in production Supabase). Every
comparison here is model-vs-model. In NBA and NFL the closing line beat every
model tested, and it would probably beat this one too — **"the shipped Elo is
the best model we have" is established; "it beats the market" is untested.**

---

## Recommendation

1. **Keep `sim-elo-v2`. No swap.** Nothing on a 46-model board — including
   fifteen ensembles and seven ML learners — beats it by a significant margin on
   9,009 walk-forward games, and it leads the board on raw accuracy.
2. **Do not chase single-season winners.** Any future bake-off should pool at
   least three test seasons before ranking anything; the swing table shows what
   one season buys you.
3. **The next real gain is information, not algorithms** — the same conclusion
   the [NFL TD](NFL-TD-SCORER-RANKINGS.md), [MLB HR](MLB-HR-HITTER-BACKTEST.md)
   and [MLB props](MLB-PROPS-BACKTEST.md) studies reached. For game outcomes
   that means the closing line, park-and-weather detail, and confirmed lineups —
   not a better learner.

---

## Files

| File | Purpose |
|---|---|
| `research/mlb-game/fetch_games.py` | Pulls 13,877 games 2021–2026 from StatsAPI |
| `research/mlb-game/bakeoff_v2.py` | Rolling walk-forward test, shipped model + 15 aggregations |
| `research/mlb-game/confidence_check.py` | Confidence-bucket and top-N-per-day validation |
| `research/mlb-game/corr_check.py` | Model-correlation matrix (why ensembling is flat) |
| `research/mlb-game/bakeoff_v2_pooled.csv` | Pooled leaderboard |
| `research/mlb-game/bakeoff_v2_per_season.csv` | Per-season results behind the swing table |
