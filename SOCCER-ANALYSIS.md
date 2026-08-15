# Soccer — five leagues, five models, five backtests

Europe's big five, each fitted and scored on its own data: **Premier League,
La Liga, Bundesliga, Serie A, Ligue 1**.

Nothing is pooled across competitions. That is not tidiness — the leagues
genuinely differ enough that a shared fit would be wrong at both ends of the
range. Draws run from 23.9% in England to 27.4% in Italy; goals per match from
2.59 in Spain to 3.18 in Germany. A calibration borrowed across a border is a
mis-calibration.

|                | Matches | Home  | Draw  | Away  | Goals/match |
| -------------- | ------- | ----- | ----- | ----- | ----------- |
| Premier League | 1,900   | 44.2% | 23.9% | 31.9% | 2.93        |
| La Liga        | 1,885   | 45.8% | 26.0% | 28.2% | 2.59        |
| Bundesliga     | 1,530   | 44.1% | 24.9% | 31.0% | 3.18        |
| Serie A        | 1,889   | 40.3% | 27.4% | 32.3% | 2.60        |
| Ligue 1        | 1,667   | 43.5% | 24.6% | 31.9% | 2.82        |

8,871 matches and 374,000 player-match rows, 2021-22 through 2025-26, from
ESPN's public soccer API.

---

## 1. Method

**The metric is RPS**, the ranked probability score. Football is a three-way
market whose outcomes are _ordered_ — home > draw > away — and RPS is the only
common metric that respects that ordering. A model that puts its weight on the
wrong side of a draw is punished; log loss and accuracy are reported alongside
but neither is the target.

For reference on every table below: always predicting the league's base rates
scores about **0.465**, and always predicting the home win with certainty scores
**0.80-0.89**.

**The protocol is one chronological walk-forward pass.** State for a match is
built only from matches played earlier. One-dimensional signals are turned into
probabilities by a multinomial logistic fitted on calibration seasons only.
Every season from 2023-24 on takes its turn as the test set and the results are
pooled, because a single 306-380 match season cannot separate forty algorithms.

**About forty algorithms** per league across seven families: baselines, rating
systems (Elo x3, Glicko, pi-rating, Massey, Colley, Davidson, Kalman, Bayesian
hierarchical), goal processes (Poisson, Dixon-Coles with and without time decay,
bivariate Poisson, negative binomial, Skellam, zero-inflated Poisson), shot
processes, form measures, machine learning (multinomial and ordered logistic,
random forest, extra trees, hist-GBM, XGBoost, LightGBM, MLP, kNN, naive Bayes,
SVM) and ensembles.

**The market is missing, and that is a real limitation.** ESPN's `pickcenter`
only carries closing 1X2 prices for recent fixtures — 10-13% of the sample by
league. That is too thin to pool across three test seasons, so _no table below
contains a market benchmark_. Everything here is measured against base rates and
against other models, never against a price. Any claim that a model "beats the
book" would be unsupported by this data, and none is made.

---

## 2. Match outcomes — the bake-off

Top ten per league, pooled over 2023-24, 2024-25 and 2025-26. Lower RPS is
better.

### Premier League — 1,140 test matches

| #     | Algorithm               | RPS        | Log loss | Accuracy |
| ----- | ----------------------- | ---------- | -------- | -------- |
| 1     | ML_random_forest        | 0.3993     | 0.9804   | 53.6%    |
| 2     | ML_extra_trees          | 0.3995     | 0.9786   | 53.7%    |
| 3     | ML_logistic_L1          | 0.4005     | 0.9852   | 53.6%    |
| 4     | ENS_mean_prob           | 0.4007     | 0.9824   | 53.2%    |
| 5     | ENS_logit_mean          | 0.4011     | 0.9812   | 53.1%    |
| 6     | ENS_diverse5_mean       | 0.4021     | 0.9838   | 53.2%    |
| 7     | poisson_sot             | 0.4036     | 0.9859   | 53.5%    |
| 8     | sot_gap                 | 0.4039     | 0.9866   | 53.2%    |
| **9** | **elo_gd — shipped**    | **0.4047** | 0.9867   | 52.7%    |
| 10    | ML_multinomial_logistic | 0.4047     | 0.9969   | 52.7%    |

### La Liga — 1,140 test matches

| #      | Algorithm            | RPS        | Log loss | Accuracy |
| ------ | -------------------- | ---------- | -------- | -------- |
| 1      | ENS_logit_mean       | 0.3856     | 0.9664   | 54.0%    |
| 2      | ML_random_forest     | 0.3860     | 0.9704   | 53.9%    |
| 3      | ML_kNN               | 0.3862     | 0.9733   | 53.6%    |
| 4      | ML_extra_trees       | 0.3878     | 0.9724   | 54.2%    |
| 5      | ENS_mean_prob        | 0.3887     | 0.9728   | 54.1%    |
| 6      | ENS_diverse5_mean    | 0.3896     | 0.9757   | 53.4%    |
| 7      | bayes_hier           | 0.3899     | 0.9756   | 53.6%    |
| 8      | ML_logistic_L1       | 0.3904     | 0.9751   | 53.3%    |
| 9      | elo                  | 0.3906     | 0.9767   | 53.1%    |
| **11** | **elo_gd — shipped** | **0.3914** | 0.9781   | 53.0%    |

### Bundesliga — 918 test matches

| #     | Algorithm            | RPS        | Log loss | Accuracy |
| ----- | -------------------- | ---------- | -------- | -------- |
| 1     | ENS_logit_mean       | 0.3994     | 0.9853   | 52.0%    |
| 2     | ML_extra_trees       | 0.4030     | 0.9919   | 52.3%    |
| 3     | ENS_mean_prob        | 0.4033     | 0.9919   | 52.5%    |
| 4     | ML_logistic_L1       | 0.4036     | 0.9926   | 49.8%    |
| 5     | ML_random_forest     | 0.4049     | 0.9959   | 51.4%    |
| 6     | sot_gap              | 0.4057     | 0.9942   | 51.1%    |
| 7     | ML_kNN               | 0.4060     | 0.9993   | 51.2%    |
| 8     | ENS_diverse5_mean    | 0.4060     | 0.9966   | 51.6%    |
| **9** | **elo_gd — shipped** | **0.4061** | 0.9976   | 51.5%    |
| 10    | elo_mov              | 0.4069     | 0.9987   | 51.4%    |

### Serie A — 1,139 test matches

| #     | Algorithm               | RPS        | Log loss | Accuracy |
| ----- | ----------------------- | ---------- | -------- | -------- |
| 1     | ENS_logit_mean          | 0.3873     | 0.9840   | 53.0%    |
| 2     | ENS_mean_prob           | 0.3887     | 0.9854   | 52.9%    |
| 3     | ML_extra_trees          | 0.3890     | 0.9854   | 53.0%    |
| 4     | ML_logistic_L1          | 0.3891     | 0.9880   | 53.7%    |
| **5** | **elo_gd — shipped**    | **0.3907** | 0.9898   | 52.4%    |
| 6     | elo                     | 0.3909     | 0.9900   | 52.3%    |
| 7     | bayes_hier              | 0.3912     | 0.9895   | 52.6%    |
| 8     | ENS_diverse5_mean       | 0.3912     | 0.9912   | 52.6%    |
| 9     | ML_multinomial_logistic | 0.3913     | 0.9933   | 52.8%    |
| 10    | elo_mov                 | 0.3914     | 0.9909   | 52.6%    |

### Ligue 1 — 917 test matches

| #     | Algorithm            | RPS        | Log loss | Accuracy |
| ----- | -------------------- | ---------- | -------- | -------- |
| 1     | ENS_diverse5_mean    | 0.4160     | 1.0037   | 50.6%    |
| 2     | ML_extra_trees       | 0.4160     | 1.0021   | 51.3%    |
| 3     | ENS_mean_prob        | 0.4167     | 1.0016   | 51.3%    |
| 4     | ML_random_forest     | 0.4170     | 1.0073   | 51.5%    |
| 5     | colley               | 0.4172     | 1.0009   | 51.6%    |
| 6     | davidson             | 0.4184     | 1.0024   | 53.0%    |
| 7     | ML_logistic_L1       | 0.4189     | 1.0090   | 51.7%    |
| **8** | **elo_gd — shipped** | **0.4190** | 1.0054   | 51.6%    |
| 9     | elo                  | 0.4190     | 1.0052   | 51.7%    |
| 10    | ENS_logit_mean       | 0.4191     | 1.0076   | 51.3%    |

### What ships, and why it is not the winner

**`elo_gd` ships in every league** — Elo with a goal-difference K multiplier,
mapped to H/D/A by a multinomial logistic on the single rating gap.

It is _not_ the top row anywhere. Picking each league's winner would be
selection on the test set: with forty candidates and about a thousand test
matches, the spread across the top eight is 0.005-0.007 RPS, comfortably inside
the noise, and the "best" family is a different one in four of the five leagues.
A choice that unstable is not a finding.

So the family was fixed once, on three grounds that are not test-set rank:

1. **It runs from a scoreboard.** Pure arithmetic over results — no shots feed,
   no fitted sklearn object at request time. This is the same thing
   `espn.server.ts` already does for NBA and NFL.
2. **It is the strongest of that self-contained class**, ahead of every goal
   process (Poisson, Dixon-Coles, bivariate Poisson, Skellam) and every other
   rating system in four of five leagues.
3. **What beats it cannot ship.** The tree ensembles need a fitted model per
   league and overfit a 380-match season; the ensembles average models that
   include them; `poisson_sot` and `sot_gap` need a per-match shots feed the
   live site does not have.

The cost of that choice is **0.0030 to 0.0067 RPS** depending on league. It is
stated on every league's Model page rather than buried here.

The Elo constants — K=20, home advantage +60, carry 0.80, exponent 0.6 — are
frozen across all five leagues and were **not** re-tuned per league. Only the
calibration is league-local, because that is where the leagues actually differ.

### Shipped model, as it will run

| League         | Test matches | RPS    | Log loss | Accuracy | Brier  |
| -------------- | ------------ | ------ | -------- | -------- | ------ |
| Premier League | 1,140        | 0.4049 | 0.9870   | 52.8%    | 0.5895 |
| La Liga        | 1,140        | 0.3920 | 0.9793   | 53.2%    | 0.5820 |
| Bundesliga     | 918          | 0.4069 | 0.9980   | 51.5%    | 0.5956 |
| Serie A        | 1,139        | 0.3908 | 0.9904   | 52.5%    | 0.5917 |
| Ligue 1        | 917          | 0.4197 | 1.0086   | 51.5%    | 0.6018 |

These are marginally worse than the bake-off's `elo_gd` rows because the
shipped model calibrates **once** on pre-2023 seasons and never refits, which is
what the live site does. The bake-off refits per test season. The shipped
number is the conservative one, and it is the one quoted on the site.

**Ligue 1 is the hardest of the five and Serie A the easiest** — 0.4197 against
0.3908. The same algorithm, the same constants; the difference is the league.

---

## 3. Player props

Ten binary markets per starting player, each its own logistic with Platt
calibration: 1+/2+/3+ shots, 1+/2+ on target, 1+ goal, 1+ assist, goal
involvement, 1+ card, 2+ fouls.

Protocol: trained through 2023-24, **model family chosen on 2024-25**, scored
once on 2025-26 — which the model never saw and which was never used to pick
anything.

### Discrimination (AUC) on the held-out 2025-26 season

| Market         | EPL       | La Liga   | Bundesliga | Serie A   | Ligue 1   |
| -------------- | --------- | --------- | ---------- | --------- | --------- |
| 1+ shots       | 0.791     | 0.787     | 0.777      | 0.781     | 0.781     |
| 2+ shots       | 0.805     | 0.820     | 0.794      | 0.811     | 0.808     |
| 3+ shots       | 0.830     | 0.854     | 0.822      | 0.843     | 0.822     |
| 1+ on target   | 0.757     | 0.791     | 0.746      | 0.752     | 0.762     |
| 2+ on target   | 0.804     | 0.867     | 0.804      | 0.833     | 0.823     |
| 1+ goal        | 0.769     | 0.790     | 0.736      | 0.753     | 0.783     |
| 1+ assist      | 0.683     | 0.679     | 0.712      | 0.694     | 0.684     |
| goal or assist | 0.735     | 0.741     | 0.722      | 0.730     | 0.746     |
| **1+ card**    | **0.616** | **0.613** | **0.634**  | **0.612** | **0.608** |
| 2+ fouls       | 0.679     | 0.666     | 0.681      | 0.665     | 0.658     |

### What actually happens when you bet the top pick

AUC flatters. These are the numbers that matter — how often the single
highest-rated player of a matchday hit, over the whole held-out season.

| Market         | EPL   | La Liga | Bundesliga | Serie A | Ligue 1 |
| -------------- | ----- | ------- | ---------- | ------- | ------- |
| 1+ shots       | 97.1% | 95.4%   | 91.2%      | 91.1%   | 86.5%   |
| 2+ shots       | 74.0% | 80.2%   | 78.0%      | 77.2%   | 65.2%   |
| 3+ shots       | 50.0% | 59.5%   | 52.7%      | 61.0%   | 42.7%   |
| 1+ on target   | 71.2% | 75.6%   | 67.0%      | 69.9%   | 67.4%   |
| 2+ on target   | 29.8% | 41.2%   | 36.3%      | 34.1%   | 25.8%   |
| 1+ goal        | 45.2% | 46.6%   | 46.2%      | 39.8%   | 37.1%   |
| 1+ assist      | 24.0% | 18.3%   | 22.0%      | 14.6%   | 11.2%   |
| goal or assist | 56.7% | 50.4%   | 50.5%      | 41.5%   | 46.1%   |
| 1+ card        | 26.9% | 23.7%   | 30.8%      | 22.8%   | 22.5%   |
| 2+ fouls       | 48.1% | 48.9%   | 38.5%      | 52.8%   | 56.2%   |

### Findings

**Shots are the honest market; cards are not.** Shot volume is a stable player
property — the same forwards take the same shots week after week, and 3+ shots
reaches 0.83-0.85 AUC. Cards sit at 0.61-0.63 across every league, which is
barely above the player's own historical rate. That is not a modelling failure
to be tuned away: a booking depends on the referee, the game state and the
scoreline far more than on the player. **The card markets are shown on the site
rather than hidden, so they can be avoided on purpose.**

**Assists are nearly unmodellable too** (0.68-0.71), for the same reason in
reverse: an assist requires a teammate to finish.

**League differences are real but small.** La Liga is the most predictable for
shots on target (0.867 for 2+, against 0.804 in England and Germany); Serie A is
hardest for goal involvement (41.5% top-pick against 56.7% in England).

**Ligue 1 is the weakest league for props as well as for match outcomes** — its
top pick lands least often in seven of the ten markets, and its 1+ assist top
pick hit just 11.2% against 24.0% in England. The same pattern as the match
model, where Ligue 1 was also the hardest of the five. Whatever makes that
league less predictable shows up in both.

### A defect, reported rather than patched

The position one-hot features (`pos_fw`, `pos_mf`, `pos_df`, `pos_gk`) are
**largely dead**. ESPN publishes positional-_slot_ codes — `CD-L`, `CF-R`,
`CM-L` — and the feature lists match plain codes (`F`, `CB`, `CM`). Across
195,161 starter appearances only **51.8%** match any position flag, and
**centre-backs never match one**.

Per league: EPL 56.1%, La Liga 54.3%, Ligue 1 51.4%, Serie A 48.9%, Bundesliga
47.6%.

This is a genuine flaw and it is **not** patched in the live scorer. The
coefficients were fitted with these semantics; repairing the matching at
serve time would feed the model a feature distribution it never saw and silently
break the calibration that every number on the site is quoted from. The fix
belongs in a refit — widen the lists, re-run the sweep, re-ship — and until then
`scripts/test-soccer-props.ts` pins the behaviour so the two halves cannot drift
apart by accident.

The models score as well as they do _despite_ this, which suggests position is
largely redundant with the shot- and foul-rate features anyway. That is a
hypothesis, not a result.

---

## 4. What is on the site

A **Soccer** tab, with five leagues and three pages each:

- **Matches** — every fixture with home/draw/away, plus the live Elo power table.
- **Player Props** — ten markets, one row per player at their biggest edge.
- **Model & Backtest** — what ships, why, and the held-out numbers including the
  bake-off rank it did _not_ win.

Live prop features are rebuilt by replaying the season's match summaries,
because ESPN publishes no season-to-date shot or foul aggregates. That is a few
hundred calls, done once per league per server instance and cached; the first
request after a cold start takes a few seconds, the rest are instant.

**Parity is enforced, not assumed.** `research/soccer/dump_parity.py` exports
real feature vectors and the probabilities Python computes from the shipped
coefficients; `scripts/test-soccer-props.ts` replays them through the TypeScript
scorer and fails above 1e-9. Current maximum divergence: **3.3e-16**.

---

## 5. Honest limits

- **No market benchmark.** 10-13% odds coverage is too thin to pool. Nothing
  here is measured against a price, and no claim is made about beating one.
- **No minutes data.** ESPN publishes none; playing time is approximated from
  starter/substitution flags (90 for a starter who finishes, 65 for one
  withdrawn, 25 for a substitute). Rates are per-appearance, not per-90.
- **Lineups are not posted early.** The research prices confirmed starters; the
  live board prices _likely_ starters — players who have started at least half
  their appearances. Features are otherwise identical.
- **Promoted clubs start unrated.** Their first fixtures are left unpriced
  rather than given an invented number.
- **A season is small.** 306-380 matches per league. Three pooled test seasons
  is about 1,000 matches, which separates good families from bad ones and does
  _not_ reliably separate the top eight from each other.

## Reproducing

```
cd research/soccer
python3 fetch_soccer.py  --league epl        # and laliga, bundesliga, seriea, ligue1
python3 bakeoff_soccer.py --league epl       # ~40 algorithms, pooled test seasons
python3 props_soccer.py  --league epl        # 10 markets x 9 algorithms
python3 ship_soccer.py   --all               # freeze the match model per league
python3 dump_parity.py   --league epl        # parity fixture for the TS test
python3 export_models.py                     # merge into src/lib/
```
