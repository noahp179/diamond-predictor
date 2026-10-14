# Anytime and first goalscorer: model vs simulator vs hybrid

A walk-forward backtest of three ways to price "player scores" for starters in the
Premier League, La Liga, Bundesliga, Serie A and Ligue 1, plus the Champions League.
Everything is tested on the same held-out matches and the same candidate players.

## Bottom line

* **Anytime, five leagues: ship the hybrid.** It is one pooled logistic regression
  that stacks the shipped `goal1` model with the simulator's closed form. On 2025-26
  it beats the shipped model in every league, and the pooled gain is significant:
  log loss −0.0022 [−0.0032, −0.0011], AUC 0.764 → 0.770, calibration unchanged
  (ECE 0.007). The simulator alone ranks the weakest of the three, but it is not far
  behind.
* **First, fix how the live site computes the shipped model's features.** The live
  port folds this season only and uses the last-seen slot (often `SUB`). Computing
  the features the way the coefficients were fitted, with the same coefficients and
  no refit, is worth as much as the hybrid: log loss −0.0029 [−0.0042, −0.0017],
  AUC 0.764 → 0.773. A hybrid built on top of those corrected features gets within
  0.001 log loss of our best model.
* **Best overall is our own gradient-boosted model (`gbm`).** It was best in all five
  leagues on 2025-26 and significant pooled against everything. Shipping it needs a
  tree exporter (the CFB TD forest is a precedent). Its edge over the corrected-feature
  hybrid is small (log loss −0.0011, Brier difference not significant).
* **The site's current scorer shares under-price every starter by about 35%.** The
  shares behind the Champions League simulator (`uclSquad`) are taken per team goal
  across the whole squad. The announced XI's shares therefore sum to 0.53 on average,
  but starters actually score 82% of a team's goals (84% of its non-own goals).
  Replacing the share with *goals per team goal while on the pitch × expected minutes
  share* fixes this. In the 2025-26 Champions League that cuts log loss from 0.318 to
  0.300 and ECE from 0.040 to 0.011.
* **First goalscorer:** the hybrid (`hybrid_first`) was best in all five leagues on
  2025-26, and the pooled gain is significant against both the anytime-derived model
  and the closed-form simulator. Those two tie with each other. The closed form
  matches the real engine at 100k runs.
* **Use the closed forms rather than the engine.** At 100k simulations the engine gives
  the same first-goal probabilities and the same top pick in about 99% of matches. For
  anytime it plays about 7.6% more goals than the expected goals it is given, which
  lifts anytime prices by about 7%. At 1k simulations the top pick changes in 8–15% of
  matches.

## Data

* **Source.** ESPN's public API (`fetch.py`). Date-range scoreboard queries now return
  HTTP 400, so fixtures are read one month at a time (`dates=YYYYMM`). There are 9,980
  completed match summaries for 2021-22 to 2026-10-13. Each one is compacted to
  rosters (starters and bench, sub flags, slot position, box-score stats, and each
  player's own substitution/goal/red-card plays with clock) plus key events.
* **Minutes.** ESPN has no minutes column, so they are reconstructed from substitution
  and red-card clocks (`build.py`). A stoppage-time substitution covers half of the
  45'/90' minute.
* **Exposure (`expo`).** This is the share of a match's goal intensity a player was on
  the pitch for. Each minute is weighted by the simulator's fitted minute effects
  (`src/lib/ucl-sim.json`), in which 45' and 90' carry their stoppage time.
* **Outcome.** The label is 1+ non-own goal in regulation time, stoppage included and
  extra time excluded. It agrees with ESPN's `totalGoals ≥ 1` on 99.998% of rows; the
  8 disagreements are Champions League extra-time goals. Every 90-minute score
  reconstructs from the player goal logs (≥ 99.94% per competition).
* **First goal.** This is the first scoring key event in periods 1–2. If it is an own
  goal (2.9% of matches), nobody wins; a 0-0 (6.2%) also means nobody wins. In 1,500
  sampled matches the own-goal markers agree with the roster flags every time.
* **Other inputs.** The cross-league Elo, the goal events in every competition (for
  the site's shares) and the Champions League goal mapping are all read from
  `research/ucl/data` and `research/ucl/results`, unchanged.

## Candidates and splits

The population is identical for every method. It is every player who **started** the
match and played more than 0 minutes **and** passes the live board's own gates:

* at least 3 match-day squads in the live season form (`MIN_APPS = 3`);
* start rate ≥ 0.5;
* his latest team is this team;
* both teams have ≥ 3 games.

That way the shipped model has a price for every candidate.

| season | starters | candidates | dropped by the gates | matches | EPL / LaLiga / Bund. / Serie A / Ligue 1 |
|---|---|---|---|---|---|
| 2024-25 (fit) | 38,543 | 28,505 | 10,038 | 1,665 | 6,368 / 6,023 / 5,022 / 6,030 / 5,062 |
| **2025-26 (test)** | 38,522 | **28,084** | 10,438 | 1,661 | 6,205 / 5,968 / 5,027 / 5,923 / 4,961 |
| 2026-27 to Oct 13 (test) | 6,534 | 3,221 | 3,313 | 205 | 690 / 911 / 440 / 597 / 583 |

There is no Champions League props model, so the gates do not apply there: every
starter is a candidate (4,158 in 2025-26 over 189 matches; 594 in 2026-27 over 27).

**Splits.**

* Everything that is fitted is fitted on 2024-25 or earlier.
* The shipped model was trained on ≤ 2023-24, so 2024-25 is out of sample for it.
* The sim's goal mapping for season S uses seasons S−5 … S−1.
* The `gbm` was trained on 2022-23 and 2023-24, with its tree count picked on 2024-25,
  then refit on all three seasons.
* The test sets are 2025-26 and 2026-27 to date.

**As-of rule.** Every input uses only matches on earlier calendar days, as it would
stand on the morning of the match.

## Methods

### 1. model — the shipped `goal1` logistic

`p = Platt(σ(b₀ + Σ βᵢ (xᵢ − μᵢ)/σᵢ))`, using the 30 features, coefficients and Platt
terms in `src/lib/soccer-props-model.json`.

The features are built **exactly as the live site builds them**. `features.py` is a
port of `foldSeason` / `priorSeason` / `featuresFor` / `scoreMarket` in
`soccer-props.server.ts`:

* this season's rows before the match day (with last season prepended while there are
  fewer than 600 rows);
* last season's totals;
* the last-seen position and formation place;
* the live gates.

Two checks back this up:

* **Parity.** `parity_props.ts` runs five slates through the site's own TypeScript.
  The largest difference over 413 probabilities is 8e-17.
* **Same data the model was built on.** `validate_model.py` runs the research
  pipeline's own `build()` on our data with the shipped coefficients. It reproduces
  the confirmation numbers stored in the model file: n is identical in all five
  leagues and AUC agrees to within 0.0002.

### 2. sim — the simulator's closed form

`P(anytime) = Σ_g P(G = g) · [1 − (1 − s·m)^g]`, where:

* **G**, the team's goals, is the team's marginal of a Dixon-Coles score matrix.
* **Team expected goals** come from the cross-league Elo of `research/ucl` (tuned
  parameters, pre-match ratings). These are mapped per league by a Poisson GLM,
  `ln λ = a + b·gap/400` (sign-flipped for the away side), fitted on the five
  previous seasons, plus a fitted ρ.
* **Champions League expected goals** come from `research/ucl/backtest_ucl.py`'s
  walk-forward mapping, reproduced to 1e-15 against `backtest_matches.csv`. 2026-27
  uses the shipped `ucl-model.json` mapping, which is out of sample for it.
* **Why not the site's own domestic model.** It is an Elo → H/D/A softmax and produces
  no goals, so it cannot supply λ.

Four share definitions were tried. The one with the best **2024-25** log loss was
chosen before 2025-26 was looked at.

| variant | s | m | 2024-25 log loss |
|---|---|---|---|
| `sim_site` (= the live engine) | the site's share: recency-weighted non-own goals for the club in all competitions, 400 days, half-life 180 d, `(g + 6·prior)/(T + 6)` with priors F .10 / M .035 / D .012 / G 0 (unknown .02), normalised over the squad to 1 − 0.028 | 1 | 0.2833 |
| `sim_site_m` (the formula read literally) | site share | m_start | 0.2885 |
| **`sim_on` (chosen → "sim")** | goals per **team goal scored while he was on the pitch**, same weights, shrunk `(g + 6·prior_on)/(T_on + 6)` with prior_on F .258 / M .089 / D .031 / G 0 (measured 2021-24) | **m_start**: recency-weighted mean exposure over his past starts, shrunk (k = 2 starts) to F .81 / M .85 / D .93 / G .99 | **0.2719** |
| `sim_xi` | the site's shares rescaled so the announced XI sums to 0.824 (the starters' share of team goals, 2021-24) | 1 | 0.2792 |

The backtest has no historical rosters, so the site's squad is approximated by
everyone named in the club's match-day squads in the previous 120 days plus today's
squad.

`sim_site` is under-priced because its XI shares sum to about 0.53. `sim_site_m`
counts minutes twice: the site's share already includes the time a player is off the
pitch, and multiplying by m removes it again.

### 3. hybrid — logistic stack, fitted on 2024-25

`p = σ(c₀ + c₁·logit(model) + c₂·logit(sim) + c₃·ln λ_team + c₄·m_start)`

* **Live features** (`results/backtest.json → ship.hybrid`): c = 0.5180, 0.5009,
  0.4760, −0.0670, −0.5794.
* **Corrected (research-style) features** (`recommendation.anytime_domestic.hybrid_research`):
  c = 0.0337, 0.6194, 0.3571, −0.1167, −0.0130.

Per-league intercepts made no difference in 5-fold CV over 2024-25 matchdays
(0.268233 vs 0.268232), so the stack is pooled.

### 4. gbm — our own model

This is sklearn `HistGradientBoostingClassifier`:

* 110 trees, learning rate 0.04, 15 leaves, min leaf 200, L2 1.0.
* Inputs: the model's 30 as-of features plus the sim inputs (s_site, s_on, s_xi,
  m_start, λ_team, λ_opp, P(team scores)), penalty share (from penalty flags in the
  goal logs), goals/shots/shots-on-target per 90, starts, position, formation place
  and home/away.

`gbm_lite` drops the domestic model's features. It is trained on domestic and
Champions League data together, so it can price the Champions League.

## Anytime results — 2025-26 (held out)

"Said" means the mean predicted probability of the picks.

* **top-1/match:** each match's highest-priced candidate.
* **top-5/day:** the five highest per (league, calendar date), which is what a board
  shows.
* **BSS:** Brier skill against the test season's own base rate.
* **ECE:** 10 equal-count bins.

| league | method | n | base | Brier | BSS | log loss | AUC | ECE | top-1/match hit vs said | top-5/day hit vs said |
|---|---|---|---|---|---|---|---|---|---|---|
| **pooled** | model | 28084 | 0.0923 | 0.07628 | +0.0895 | 0.26710 | 0.7642 | 0.0073 | 0.306 vs 0.311 (n=1661) | 0.263 vs 0.271 (n=2815) |
| | sim | | | 0.07672 | +0.0842 | 0.27022 | 0.7602 | 0.0146 | 0.306 vs 0.349 | 0.267 vs 0.301 |
| | hybrid | | | 0.07573 | +0.0960 | 0.26494 | 0.7700 | 0.0071 | 0.308 vs 0.322 | 0.269 vs 0.280 |
| | gbm | | | **0.07522** | **+0.1021** | **0.26228** | **0.7787** | **0.0028** | 0.317 vs 0.331 | 0.279 vs 0.287 |
| EPL | model | 6205 | 0.0993 | 0.08214 | +0.0814 | 0.28367 | 0.7599 | 0.0154 | 0.313 vs 0.273 (n=361) | 0.262 vs 0.249 (n=545) |
| | sim | | | 0.08252 | +0.0772 | 0.28717 | 0.7534 | 0.0164 | 0.294 vs 0.357 | 0.273 vs 0.321 |
| | hybrid | | | 0.08153 | +0.0882 | 0.28134 | 0.7639 | 0.0124 | 0.294 vs 0.303 | 0.273 vs 0.274 |
| | gbm | | | 0.08100 | +0.0942 | 0.27816 | 0.7724 | 0.0086 | 0.307 vs 0.339 | 0.286 vs 0.304 |
| La Liga | model | 5968 | 0.0900 | 0.07148 | +0.1271 | 0.24978 | 0.8013 | 0.0143 | 0.344 vs 0.387 (n=358) | 0.283 vs 0.317 (n=685) |
| | sim | | | 0.07203 | +0.1203 | 0.25321 | 0.7928 | 0.0099 | 0.335 vs 0.350 | 0.280 vs 0.282 |
| | hybrid | | | 0.07104 | +0.1324 | 0.24843 | 0.8017 | 0.0126 | 0.355 vs 0.366 | 0.288 vs 0.298 |
| | gbm | | | 0.07106 | +0.1322 | 0.24782 | 0.8044 | 0.0082 | 0.355 vs 0.349 | 0.304 vs 0.287 |
| Bundesliga | model | 5027 | 0.0989 | 0.08203 | +0.0793 | 0.28589 | 0.7400 | 0.0105 | 0.302 vs 0.337 (n=291) | 0.266 vs 0.304 (n=470) |
| | sim | | | 0.08238 | +0.0753 | 0.28915 | 0.7375 | 0.0238 | 0.344 vs 0.371 | 0.289 vs 0.329 |
| | hybrid | | | 0.08146 | +0.0856 | 0.28389 | 0.7453 | 0.0121 | 0.320 vs 0.345 | 0.268 vs 0.309 |
| | gbm | | | 0.08063 | +0.0950 | 0.28047 | 0.7575 | 0.0093 | 0.344 vs 0.338 | 0.283 vs 0.301 |
| Serie A | model | 5923 | 0.0854 | 0.07297 | +0.0661 | 0.26093 | 0.7411 | 0.0110 | 0.274 vs 0.266 (n=361) | 0.241 vs 0.224 (n=640) |
| | sim | | | 0.07324 | +0.0626 | 0.26250 | 0.7418 | 0.0213 | 0.263 vs 0.324 | 0.236 vs 0.282 |
| | hybrid | | | 0.07226 | +0.0751 | 0.25755 | 0.7499 | 0.0078 | 0.271 vs 0.287 | 0.248 vs 0.247 |
| | gbm | | | 0.07170 | +0.0823 | 0.25437 | 0.7635 | 0.0085 | 0.277 vs 0.307 | 0.253 vs 0.262 |
| Ligue 1 | model | 4961 | 0.0879 | 0.07284 | +0.0913 | 0.25553 | 0.7776 | 0.0078 | 0.293 vs 0.293 (n=290) | 0.261 vs 0.262 (n=475) |
| | sim | | | 0.07354 | +0.0826 | 0.25954 | 0.7683 | 0.0168 | 0.300 vs 0.345 | 0.261 vs 0.306 |
| | hybrid | | | 0.07246 | +0.0961 | 0.25391 | 0.7812 | 0.0100 | 0.303 vs 0.312 | 0.263 vs 0.279 |
| | gbm | | | 0.07171 | +0.1054 | 0.25080 | 0.7898 | 0.0083 | 0.303 vs 0.325 | 0.267 vs 0.290 |

**Paired bootstrap.** Matchdays (league, date) are resampled 2,000 times. Each cell
is the other method minus the reference, with its 95% CI; positive means the reference
is better.

| league | reference | vs | ΔBrier | ΔLog loss |
|---|---|---|---|---|
| pooled | gbm | model | +0.00106 [+0.00067, +0.00145] | +0.00482 [+0.00346, +0.00625] |
| pooled | gbm | sim | +0.00150 [+0.00120, +0.00181] | +0.00795 [+0.00640, +0.00951] |
| pooled | gbm | hybrid | +0.00051 [+0.00026, +0.00075] | +0.00266 [+0.00164, +0.00369] |
| pooled | **hybrid** | model | +0.00054 [+0.00029, +0.00079] | +0.00216 [+0.00113, +0.00317] |
| pooled | **hybrid** | sim | +0.00099 [+0.00072, +0.00127] | +0.00529 [+0.00429, +0.00631] |
| EPL | hybrid | model / sim | +0.00061 [+0.00012, +0.00111] / +0.00099 [+0.00042, +0.00155] | +0.00233 [+0.00000, +0.00468] / +0.00583 [+0.00372, +0.00800] |
| La Liga | hybrid | model / sim | +0.00043 [−0.00018, +0.00107] / +0.00099 [+0.00040, +0.00154] | +0.00135 [−0.00042, +0.00328] / +0.00479 [+0.00282, +0.00666] |
| Bundesliga | hybrid | model / sim | +0.00057 [+0.00002, +0.00113] / +0.00092 [+0.00034, +0.00150] | +0.00200 [−0.00051, +0.00446] / +0.00526 [+0.00258, +0.00786] |
| Serie A | hybrid | model / sim | +0.00071 [+0.00014, +0.00130] / +0.00098 [+0.00031, +0.00162] | +0.00338 [+0.00102, +0.00595] / +0.00495 [+0.00255, +0.00723] |
| Ligue 1 | hybrid | model / sim | +0.00039 [−0.00018, +0.00097] / +0.00108 [+0.00045, +0.00170] | +0.00162 [−0.00083, +0.00418] / +0.00563 [+0.00311, +0.00812] |
| per league | gbm | model | all positive; CI excludes 0 in EPL, Bundesliga, Serie A, Ligue 1 (La Liga +0.0020 [−0.0007, +0.0045]) | |
| per league | gbm | hybrid | positive except La Liga (+0.0006 [−0.0015, +0.0026]) | |

**Pooled calibration, 2025-26.** Each cell is mean predicted → observed rate, in 10
equal-count bins of 2,808–2,809 rows.

| bin | model | sim | hybrid | gbm |
|---|---|---|---|---|
| 1 | 0.001→0.000 | 0.000→0.000 | 0.000→0.000 | 0.001→0.000 |
| 2 | 0.025→0.028 | 0.010→0.026 | 0.019→0.022 | 0.023→0.021 |
| 3 | 0.036→0.040 | 0.020→0.037 | 0.030→0.039 | 0.032→0.030 |
| 4 | 0.045→0.038 | 0.035→0.052 | 0.042→0.045 | 0.039→0.043 |
| 5 | 0.055→0.053 | 0.052→0.051 | 0.055→0.048 | 0.048→0.049 |
| 6 | 0.068→0.065 | 0.072→0.069 | 0.071→0.064 | 0.061→0.065 |
| 7 | 0.086→0.097 | 0.100→0.082 | 0.093→0.089 | 0.086→0.084 |
| 8 | 0.116→0.119 | 0.142→0.128 | 0.130→0.119 | 0.132→0.131 |
| 9 | 0.170→0.194 | 0.206→0.189 | 0.191→0.202 | 0.195→0.190 |
| 10 | 0.306→0.290 | 0.332→0.288 | 0.310→0.293 | 0.317→0.309 |

The sim is too extreme: it is low at the bottom and high at the top, and its top picks
are over-stated by about 4 points. The model and the hybrid are close to the diagonal
everywhere. Every method's top-1 hit rate is within 0.5–4.3 points of what it said.

**What the live feature port costs.** On the 27,324 test rows where the research
pipeline's `build()` also has a row (log loss / AUC):

| model (live features) | model (research features, same coefficients) | sim | hybrid (live) | hybrid (research features) | gbm |
|---|---|---|---|---|---|
| 0.26792 / 0.7636 | 0.26498 / 0.7728 | 0.27086 / 0.7601 | 0.26562 / 0.7697 | 0.26389 / 0.7746 | 0.26283 / 0.7790 |

* Research features vs live features, same model: Δ log loss 0.00293 [0.00170, 0.00417].
* gbm vs the research-feature hybrid: 0.00106 [0.00005, 0.00203]; Brier difference
  0.00015 [−0.00013, 0.00042].

### 2026-27 to date (205 matches; early season, small)

| pooled | n | Brier | log loss | AUC | ECE | top-1 hit vs said | top-5/day hit vs said |
|---|---|---|---|---|---|---|---|
| model | 3221 | 0.08269 | 0.28435 | 0.7671 | 0.0105 | 0.288 vs 0.318 | 0.269 vs 0.271 |
| sim | | 0.08326 | 0.28893 | 0.7555 | 0.0143 | 0.302 vs 0.335 | 0.267 vs 0.279 |
| hybrid | | 0.08207 | 0.28209 | 0.7696 | 0.0093 | 0.288 vs 0.319 | 0.267 vs 0.270 |
| gbm | | 0.08242 | 0.28155 | 0.7760 | 0.0133 | 0.312 vs 0.327 | 0.256 vs 0.279 |

The ordering is the same as 2025-26, but nothing is significant except hybrid vs sim
(Δ log loss 0.0068 [0.0031, 0.0105]). Hybrid vs model is 0.0023 [−0.0013, 0.0056].
Per-league tables are in `results/tables.md`.

### Champions League (no props model; every starter)

| 2025-26 (n = 4,158; 189 matches) | Brier | log loss | AUC | ECE | top-1 hit vs said | top-5/day hit vs said |
|---|---|---|---|---|---|---|
| sim_site (what the site's engine prices) | 0.08912 | 0.31830 | 0.7625 | 0.0401 | 0.413 vs 0.331 | 0.448 vs 0.338 |
| sim_site_m | 0.09078 | 0.32757 | 0.7577 | 0.0497 | 0.392 vs 0.282 | 0.430 vs 0.291 |
| **sim_on** | 0.08677 | 0.29957 | 0.7686 | 0.0112 | 0.418 vs 0.394 | 0.430 vs 0.400 |
| sim_xi | 0.08728 | 0.30634 | 0.7639 | 0.0199 | 0.386 vs 0.429 | 0.491 vs 0.430 |
| sim_stack (fit on 2024-25 UCL) | 0.08683 | 0.29775 | 0.7701 | 0.0138 | 0.407 vs 0.349 | 0.412 vs 0.360 |
| gbm_lite | **0.08520** | **0.29062** | **0.7850** | **0.0078** | 0.439 vs 0.374 | 0.467 vs 0.390 |

Bootstrap with gbm_lite as the reference (Δ log loss):

| vs | Δ log loss [95% CI] |
|---|---|
| sim_site | +0.0277 [0.0178, 0.0373] |
| sim_on | +0.0089 [0.0055, 0.0125] |
| sim_stack | +0.0071 [0.0039, 0.0103] |

2026-27 (27 matches) gives the same ordering. In the Champions League every method
except `sim_xi` under-says its top-1 picks: favourites' strikers there score more often
than these models expect.

## First goalscorer

### Definition and methods

The first goal is the first goal of regulation time. An own goal first, or a 0-0,
means no player wins. The candidates are the same as above.

* **sim (closed form).** `P(first) = λ_t/(λ_t + λ_o) · (1 − e^{−(λ_t+λ_o)}) · s`,
  where the share s already leaves out the 2.8% own goals.
  * `sim_first` uses s = on-pitch share × m_start.
  * `sim_site_first` uses the site's shares.
* **model_first.** The shipped props model has no first-goal market, so its anytime
  probability is converted with a logistic regression fitted on 2024-25:
  `σ(−0.5520 + 0.8894·logit(p_any) + 0.0718·logit(λ_t/(λ_t+λ_o)) − 0.6231·ln(λ_t+λ_o))`.
* **hybrid_first.** A logistic regression fitted on 2024-25:
  `σ(0.9771 + 0.4024·logit(p_any) + 0.4990·logit(sim_first) − 0.3074·ln λ_t − 0.2983·ln λ_o − 1.6248·m_start)`.

### Results

**Domestic, 2025-26.**

| league | method | n | base | Brier | BSS | log loss | AUC | ECE | top-1/match hit vs said |
|---|---|---|---|---|---|---|---|---|---|
| pooled | model_first | 28084 | 0.0392 | 0.03617 | +0.0388 | 0.14804 | 0.7592 | 0.0045 | 0.140 vs 0.138 (n=1661) |
| | sim_first | | | 0.03604 | +0.0425 | 0.14802 | 0.7610 | 0.0039 | 0.140 vs 0.146 |
| | sim_site_first | | | 0.03645 | +0.0314 | 0.15583 | 0.7479 | 0.0144 | 0.143 vs 0.112 |
| | **hybrid_first** | | | **0.03592** | **+0.0455** | **0.14615** | **0.7695** | **0.0020** | 0.146 vs 0.144 |
| EPL | model / sim / site / hybrid | 6205 | 0.0406 | .03763 / .03757 / .03786 / .03751 | | .15422 / .15540 / .16261 / .15340 | .745 / .742 / .731 / .749 | | .122/.115, .122/.147, .139/.115, .119/.128 |
| La Liga | ″ | 5968 | 0.0404 | .03647 / .03629 / .03685 / .03612 | | .14573 / .14536 / .15398 / .14367 | .796 / .796 / .783 / .803 | | .176/.189, .170/.161, .168/.124, .182/.182 |
| Bundesliga | ″ | 5027 | 0.0416 | .03882 / .03868 / .03909 / .03860 | | .15918 / .16042 / .16928 / .15798 | .728 / .723 / .712 / .734 | | .120/.143, .134/.144, .137/.116, .124/.143 |
| Serie A | ″ | 5923 | 0.0363 | .03396 / .03392 / .03421 / .03374 | | .14303 / .14213 / .14981 / .14044 | .734 / .746 / .727 / .753 | | .125/.117, .114/.135, .116/.098, .130/.129 |
| Ligue 1 | ″ | 4961 | 0.0369 | .03395 / .03365 / .03421 / .03358 | | .13780 / .13643 / .14314 / .13488 | .794 / .793 / .781 / .806 | | .159/.125, .166/.142, .159/.106, .176/.139 |

**Domestic bootstrap, hybrid_first as the reference.** Every league shows the same sign.

| vs | ΔBrier [95% CI] | ΔLog loss [95% CI] |
|---|---|---|
| model_first | +0.00025 [0.00015, 0.00034] | +0.0019 [0.0011, 0.0026] |
| sim_first | +0.00011 [0.00004, 0.00019] | +0.0019 [0.0012, 0.0026] |
| sim_site_first | +0.00053 [0.00039, 0.00067] | +0.0097 [0.0081, 0.0113] |

The log-loss CI against model_first excludes 0 in La Liga, Serie A and Ligue 1, and
the one against sim_first excludes 0 in all five leagues.

**Domestic, 2026-27.** hybrid_first is still best pooled (0.14901). The lead over
model_first is not significant: +0.0010 [−0.0012, +0.0034].

**Champions League, 2025-26 (n = 4,158).**

| method | log loss | AUC | top-1 hit vs said |
|---|---|---|---|
| sim_first | 0.14852 | 0.773 | 0.201 vs 0.162 |
| sim_site_first | 0.15658 | 0.762 | 0.201 vs 0.132 |
| sim_stack_first | 0.14798 | 0.775 | 0.201 vs 0.166 |

sim_stack_first and sim_first are tied (Δ 0.0005 [−0.0003, 0.0014]).

### Engine check (`engine_check.ts` → `engine_compare.py`)

The site's actual `runBatch` was run on 200 random 2025-26 fixtures, 1,000 and
100,000 matches per fixture, for both share definitions. Each side was given a `rest`
scorer for the bench's share, because `pickScorer` hands any unassigned remainder to
the last scorer in the list. The table is scored on the 3,478 candidates in those
fixtures.

| market | shares | method | mean p | Brier | log loss | AUC | top-1 hit vs said | mean \|Δ\| vs closed | same top-1 as closed |
|---|---|---|---|---|---|---|---|---|---|
| anytime | on-pitch | closed form (DC) | 0.0954 | 0.07308 | 0.25817 | 0.7739 | 0.295 vs 0.345 | — | — |
| | | engine 1k | 0.1018 | 0.07371 | 0.26041 | 0.7710 | 0.305 vs 0.367 | 0.0085 | 92% |
| | | engine 100k | 0.1018 | 0.07336 | 0.25902 | 0.7739 | 0.300 vs 0.366 | 0.0064 | 98.5% |
| anytime | site | closed form | 0.0670 | 0.07429 | 0.26886 | 0.7660 | 0.310 vs 0.285 | — | — |
| | | engine 1k | 0.0712 | 0.07415 | 0.26850 | 0.7658 | 0.290 vs 0.301 | 0.0063 | 92% |
| | | engine 100k | 0.0716 | 0.07410 | 0.26740 | 0.7660 | 0.315 vs 0.303 | 0.0046 | 99.5% |
| first goal | on-pitch | closed form | 0.0357 | 0.03355 | 0.13710 | 0.7858 | 0.145 vs 0.144 | — | — |
| | | engine 1k | 0.0366 | 0.03368 | 0.13896 | 0.7765 | 0.135 vs 0.148 | 0.0040 | 85.5% |
| | | engine 100k | 0.0366 | 0.03354 | 0.13706 | 0.7860 | 0.150 vs 0.148 | 0.0010 | 98.5% |
| first goal | site | closed form | 0.0246 | 0.03392 | 0.14174 | 0.7827 | 0.155 vs 0.115 | — | — |
| | | engine 1k | 0.0251 | 0.03386 | 0.14280 | 0.7853 | 0.160 vs 0.118 | 0.0032 | 87.5% |
| | | engine 100k | 0.0252 | 0.03390 | 0.14137 | 0.7832 | 0.155 vs 0.118 | 0.0007 | 99% |

* **First goal.** At 100k the engine reproduces the closed form, so 100k vs closed
  form changes no metric meaningfully.
* **Anytime.** On these domestic fixtures the engine plays **3.04 goals per match
  against 2.82 expected** (+7.6%). Its minute and game-state constants were fitted on
  European matches, where the same effect was +3.7%. Every anytime price therefore
  rises by about 7% relative. That helps the under-priced site shares slightly and
  hurts the calibrated on-pitch shares slightly; ranking is unchanged.
* **1k simulations.** These add visible noise: the top pick differs from the closed
  form in 8–15% of matches, and log loss is worse by 0.001–0.002.
* **Poisson vs Dixon-Coles marginal.** These are identical for anytime (mean |Δ|
  1e-5).

## Recommendation

| market | five leagues | Champions League |
|---|---|---|
| anytime | **Hybrid, pooled.** First correct the live feature port (career totals since 2021-22, lineup slot not `SUB`), then use the `hybrid_research` coefficients. Until then, use `ship.hybrid`. Optional upgrade: `gbm`. | **On-pitch share × m_start** in the scorer markets (`sim_on`) instead of the site's per-squad shares. `gbm_lite` is better if a tree model ships. |
| first goal | `hybrid_first` | `sim_first` closed form with on-pitch shares |

All constants are in `results/backtest.json` under `recommendation`, `ship` and
`first_goal.fitted`. They include:

* the stack coefficients;
* the sim's priors (on-pitch share prior by position, m_start priors, k = 6, k_m = 2
  starts, half-life 180 d, 400-day window);
* the own-goal share;
* the per-league goal-mapping fits for 2025-26 and 2026-27.

## Caveats and data problems

* **One test season.** The pooled gains are a few thousandths of log loss. They are
  significant pooled, but per league several CIs include 0. 2026-27 is too short to
  confirm anything.
* **The live board is empty around matchdays 3–4.** The early-season rule
  (`thisSeason.rows < 600`) switches to this-season-only form after about matchday 2.
  From then until teams have 3 games and players 3 appearances this season, nobody
  passes `MIN_APPS` or the team gate. That is why the gates drop 51% of 2026-27
  starters, against about 27% in a full season. Promoted clubs' players are not priced
  until their third match. This is a live-site issue, separate from the model.
* **No historical rosters.** The site's shares use the live ESPN roster, which also
  zeroes injured players. Our proxy (named in a match-day squad in the last 120 days,
  plus today's squad) slightly changes the normalisation. It cannot explain the 0.53
  vs 0.82 gap: that gap is structural, because per-squad shares are not conditioned on
  the lineup.
* **Minutes, exposure and the on-pitch share use league and Champions League matches
  only.** Domestic cups and the other European competitions are not in `data/`. The
  site's shares do use every competition in `research/ucl/data`. Clubs outside the big
  five therefore have thinner on-pitch history in the Champions League.
* **Late Champions League fixtures.** `research/ucl/data` ends on 2026-10-12, so the
  9 Champions League matches on 2026-10-13 were priced from the final replay ratings.
  Every earlier match was already in that replay, so this is still as-of.
* **Lineups are assumed known.** The candidates are actual starters, and m_start and
  the sim are conditioned on the XI. A board published before lineups would price
  *likely* starters and do somewhat worse with every method.
* **BSS reference.** BSS uses the test season's own base rate, which slightly flatters
  the reference.

## Reproduce

Run from `research/soccer-scorers`. The data lands in `data/`, which is gitignored.

```
python3 fetch.py              # ~4 min, 9,980 summaries (8 threads)
python3 build.py              # tidy tables + checks
python3 features.py           # walk-forward inputs (~4 min)
python3 validate_model.py     # research-pipeline reproduction check
npx tsx research/soccer-scorers/parity_props.ts           # (repo root) TS parity of the live port
OMP_NUM_THREADS=2 python3 evaluate.py                       # anytime metrics, ~15 min
python3 first_goal.py         # first goal + engine fixture sample
npx tsx research/soccer-scorers/engine_check.ts --variant on --n 100000    # (repo root) also: --variant site, --n 1000
python3 engine_compare.py && python3 research_hybrid.py && python3 finalize.py
```

**Outputs**

* `results/backtest.json` — all metrics, CIs, calibration tables, constants, and the
  `first_goal`, `engine_check` and `recommendation` keys.
* `results/tables.md` and `results/tables_first_goal.md` — every table, including
  per-league ones, all variants and 2026-27.
* `results/test_predictions.csv.gz` — every test-season prediction.
* `results/*.log` — the run logs.
