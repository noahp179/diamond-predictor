# Deep Edge Hunt — New Data, 13 Algorithms, Exhaustive Rule Mining

[MISS-ANALYSIS.md](MISS-ANALYSIS.md) found nothing, but it only re-sliced
features the model already had — and a calibrated model has no exploitable
pattern in its own features by construction. So this round brings in
**information the models have never seen** and attacks it every way available.

New data collected (`research/mlb-props/fetch_context.py`): temperature, sky
condition, wind speed and direction, roof type, the home-plate umpire, batter
and pitcher handedness, opponent bullpen fatigue, travel distance, day vs night.
6,572 games, 100% coverage on weather and umpires.

**Design:** prop models refit on **2024 only**, so 2025 and 2026 are both fully
out of sample. Discover on 2025, confirm on 2026. Effects are measured **relative
to the same season's baseline** — the whole board runs slightly hot out of
sample, so "negative vs zero" is not a finding.

---

## TL;DR — three candidate edges survived, one is usable today

| Finding | Effect on the confidence gap | 2025 | 2026 | Usable pre-game? |
|---|--:|--:|--:|---|
| **Switch hitters underperform** | **−0.041** [−0.072, −0.010] | −0.014 | −0.092 | **Yes** |
| **Calm wind (≤3 mph)** | **−0.028** [−0.049, −0.007] | −0.025 | −0.032 | **No** — weather only publishes at first pitch |
| **Day games** | **−0.035** [−0.053, −0.016] | −0.051 | −0.010 | Yes, but fading |
| Everything else (12 families) | — | — | — | flips sign or one season only |

And the negatives, which are most of the story:

- **13 learners, none beat the baseline.** Best AUC 0.5582 (naïve Bayes, with a
  ruinous 0.798 log loss) against 0.5499 for simply trusting the probability.
  Every calibrated learner is *worse*.
- **Exhaustive rule mining is a masterclass in overfitting.** 804 rules, top lift
  **+0.379** on the discovery season — and the permutation bar (best lift the
  same search finds on *shuffled labels*) is **±0.087**. In the confirmation
  season that +0.379 rule returns **+0.053**.
- **Player-level bias looked like the big one — and it was model staleness.**
  Split-half persistence is strong (batters r = +0.416, p = 0.005; pitchers
  r = +0.690, p = 0.003) and out-of-sample quartiles are monotone. But refit the
  model on recent data and the effect collapses from a 9-point spread to
  +0.029 [−0.020, +0.082]. **Not an edge — a retraining schedule.**
- **Umpires:** split-half r = +0.192, permutation p = 0.080. Suggestive, short of
  significant. (Will Little's picks ran −0.407 over 189 of them, which is either
  a strike zone or a coincidence; on this data you cannot tell.)

---

## 1. The new-information scan

Twelve context families, each split into buckets, each bucket's residual measured
against the rest of that season, with bootstrap CIs on the difference.

Pooled over both seasons (residuals season-demeaned so a season-level offset
cannot drive the pooling):

| Condition | legs | effect | 95% CI | 2025 | 2026 | verdict |
|---|--:|--:|---|--:|--:|---|
| calm wind (≤3 mph) | 2,453 | **−0.028** | [−0.049, −0.007] | −0.025 | −0.032 | **consistent + significant** |
| switch hitter | 934 | **−0.041** | [−0.072, −0.010] | −0.014 | −0.092 | **consistent + significant** |
| day game | 4,064 | **−0.035** | [−0.053, −0.016] | −0.051 | −0.010 | consistent, fading |
| precipitation | 258 | +0.111 | [+0.061, +0.158] | n/a | +0.134 | one season only |
| wind blowing out | 3,086 | +0.016 | [−0.003, +0.035] | +0.010 | +0.025 | nothing |
| long trip (>800 mi) | 1,098 | +0.014 | [−0.014, +0.042] | +0.014 | +0.014 | nothing |
| indoors (dome/roof shut) | 1,428 | +0.012 | [−0.014, +0.037] | +0.041 | −0.028 | flips |
| cold (≤55 °F) | 489 | +0.012 | [−0.029, +0.052] | +0.065 | −0.040 | flips |
| LvL matchup | 530 | −0.024 | [−0.065, +0.016] | −0.014 | −0.041 | nothing |
| RvR matchup | 2,279 | +0.001 | [−0.021, +0.022] | +0.014 | −0.022 | flips |

Four of ten are pooled-significant against ~0.5 expected by chance, so some of
this is real — but note how many of the *intuitive* stories die. Cold weather,
domes, wind blowing out, long road trips, tired bullpens: all flip sign between
seasons.

### The one that pays, if you can get the data

**Switch hitters hit 66.0% against a stated 72.1%** — a 6-point shortfall on
9.6% of all confident legs. Everything else hits 71.8% against 73.8%. The
mechanism is plausible: the prop models have **no handedness feature at all**,
so a switch hitter's aggregate rate is applied without knowing that his platoon
split, his usual defensive position and his batted-ball profile differ from the
right-handed regulars the model is mostly fitted on.

Dropping switch-hitter legs from a 6-leg slip is worth roughly **+66% in
relative win probability** (0.718⁶ vs 0.660⁶). That is the largest single lever
this entire investigation turned up.

**Calm wind** is the most *consistent* effect (−0.025 then −0.032, almost
identical) but it cannot be acted on: MLB StatsAPI publishes weather only once
the game starts. Acting on it needs an outside forecast feed — a concrete,
cheap next step if you want it.

---

## 2. Thirteen algorithms, all beaten by doing nothing

Train on 2025, test on 2026, predicting "this confident pick misses", with old
features *and* all the new context:

| Model | AUC | log loss |
|---|--:|--:|
| **BASELINE — 1 − published probability** | **0.5499** | **0.5945** |
| gaussian naïve Bayes | 0.5582 | 0.7979 |
| kNN (k=100) | 0.5422 | 0.6051 |
| extra trees | 0.5396 | 0.5953 |
| elastic net | 0.5342 | 0.5983 |
| logistic L2 | 0.5341 | 0.5984 |
| logistic L1 | 0.5324 | 0.5981 |
| MLP (32,16) | 0.5249 | 0.6080 |
| decision tree (d2) | 0.5235 | 0.5952 |
| hist-GBM | 0.5201 | 0.6171 |
| gradient boosting | 0.5176 | 0.5998 |
| random forest | 0.5121 | 0.5986 |
| decision tree (d4) | 0.5119 | 0.6076 |
| SVM (rbf) | 0.5038 | 0.6077 |

Naïve Bayes edges the baseline on AUC by 0.008 — inside noise — while being
catastrophically miscalibrated. Every model that produces usable probabilities
is worse than the published number. And the depth-2 tree, asked to find the
simplest possible rule, splits on… the probability itself.

---

## 3. Rule mining, and why its results should scare you

Every 1- and 2-condition rule over discretised context (804 rules with support
≥150), ranked by lift on the miss rate.

| Rule | 2025 n | miss | lift | 2026 n | miss | lift |
|---|--:|--:|--:|--:|--:|--:|
| calm wind AND light-workload starter | 163 | 0.669 | **+0.379** | 89 | 0.337 | +0.053 |
| cool temp AND light-workload starter | 172 | 0.669 | **+0.379** | 96 | 0.281 | −0.003 |
| light-workload starter AND short rest | 196 | 0.628 | **+0.338** | 93 | 0.237 | −0.048 |
| light-workload starter AND day game | 192 | 0.625 | **+0.335** | 110 | 0.336 | +0.052 |

A rule with a **+38-point** lift — picks missing 67% of the time instead of 29% —
that returns +5 points, −0.3 points and −4.8 points the following season.

The permutation control is the honest number: run the same search on **shuffled
outcomes** and the best lift it finds is **±0.087** (95th percentile 0.109).
Nearly every "discovery" above is inside what pure noise produces. Two rules
technically held their sign into 2026, both variations on "workhorse starters
are safer" — which the model already knows, since innings-per-start is one of
its features.

---

## 4. The player-bias story: a real effect with the wrong explanation

This looked like the jackpot. A player's residual over their earlier picks
predicts their later picks:

- batters: split-half r = **+0.416** (permutation p = 0.005)
- pitchers: split-half r = **+0.690** (permutation p = 0.003)

And strictly causal expanding-window quartiles were monotone out of sample:

| prior-bias quartile | legs | stated | actual | gap |
|---|--:|--:|--:|--:|
| 1 (worst) | 793 | 0.732 | **0.677** | −0.055 |
| 2 | 793 | 0.737 | 0.701 | −0.035 |
| 3 | 793 | 0.741 | 0.733 | −0.008 |
| 4 (best) | 793 | 0.748 | **0.786** | +0.037 |

A 9-point spread in realised hit rate between top and bottom quartile, at
identical stated probabilities. Adding the bias term lifted ranking AUC from
0.5513 to **0.5834**.

**Then the control killed it.** All of the above uses a model trained on 2024
only — one to two seasons stale. Refit on 2024+2025 and measure the same
quartiles *within* 2026, and the spread falls to **+0.029 [−0.020, +0.082]** —
gone.

So the effect is real but it is not a player edge; it is **model decay**. Players
whose true rate drifted away from their 2024 form look "systematically
mispriced" only because the model is out of date. The operational lesson is
worth having: **a prop model one to two seasons stale develops a 9-point
player-level spread; a current one has 2.9 points and is not significant.**
Retrain every season, and the whole phenomenon disappears.

---

## Follow-up: the handedness feature was built, tested, and rejected

The obvious conclusion from the switch-hitter finding was "add handedness as a
feature." That was built properly — each batter's season-to-date rate against
the hand tonight's starter throws with (`vs_hand_h_pa`, `vs_hand_tb_pa`,
`vs_hand_hr_pa`, sample size), the matchup flags (platoon edge, same-handed,
switch, bats-left, starter-throws-left) and, for pitchers, the opposing lineup's
left-handed share — and A/B tested head to head on the 2026 hold-out
(`research/mlb-props/platoon_ab.py`).

**It does not help.**

| | batters (12 markets) | starters (4 markets) |
|---|--:|--:|
| mean ΔAUC | **−0.0004** | **−0.0005** |
| mean Δlog loss | −0.00007 | −0.00024 |
| markets improved | 2 of 12 | 1 of 4 |

Nor does it repair the thing that motivated it: the switch-hitter gap on 1+ hits
moves from −0.028 to −0.025, while everyone else drifts from −0.011 to −0.020.

The sanity check explains why. On this data the platoon advantage barely exists
for the markets we price: batters holding the handedness edge got a hit in
**60.3%** of games, same-handed batters in **61.5%** — backwards from the
textbook, and both within noise of each other. The classical platoon split lives
in slugging and walk rates, not in "did he get one hit", and 1+ hits is where our
confident legs actually are.

The columns are still built by `features.py` (as `PLATOON_FEATURES`) so the
experiment reproduces, but they are deliberately **not** in the shipped model.
The switch-hitter caution on the parlay card therefore stays what it is — an
empirical flag on a bias we can measure but cannot yet explain or model away.

## What to actually do

1. **Keep the switch-hitter flag** as the interim measure it is: 66.0% realised
   against 72.1% stated across two seasons, with the caveat that the two seasons
   disagree in magnitude by a factor of six.
2. **Retrain annually.** The staleness result quantifies the cost of not doing
   it.
3. **If you want the wind signal, buy a forecast feed.** The effect is the most
   reproducible one found (−0.025 / −0.032) and MLB's own weather field is empty
   until first pitch.
4. **Do not build a per-leg risk score from these features.** Thirteen
   algorithms and 804 mined rules all failed to beat the published probability
   out of sample.

---

## Honest limits

- Four of ten pooled tests were significant against ~0.5 expected by chance, so
  the *set* is informative, but any individual one could still be noise —
  especially the switch-hitter effect, whose two seasons disagree in magnitude
  by a factor of six (−0.014 vs −0.092).
- Two seasons of hold-out is 9,762 confident legs. That detects effects of ~3
  points, not 1.
- The umpire result (r = +0.192, p = 0.080) is the one I would most want more
  data on. It is the right shape for a real effect and simply under-powered at
  84 umpires.

---

## Files

| File | Purpose |
|---|---|
| `research/mlb-props/fetch_context.py` | Collects weather, roof, umpires, handedness, travel |
| `research/mlb-props/deep_edge_hunt.py` | Family scan, 13-algorithm sweep, rule mining with permutation control |
| `research/mlb-props/data/game_context.csv` | Per-game weather / umpire / venue context |
