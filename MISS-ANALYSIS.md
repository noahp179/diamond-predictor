# Why Picks Miss — and Can We See It Coming?

A failure analysis of every confident pick the models made on the 2026 hold-out
season, asking one question: **is there any pre-game condition that tells us a
pick is more likely to lose than its stated probability admits?**

Code: `research/mlb-props/miss_analysis.py`. Data: 378,820 (pick, market) rows
from the 2026 season the prop models never trained on, plus 9,009 game-model
picks from 2023–26.

---

## TL;DR

**No. Misses are not preemptively identifiable beyond the probability itself.**
Four separate candidate signals were tested and all four died out of sample:

| Candidate | In-sample look | Out-of-sample verdict |
|---|---|---|
| Miss-risk model on all pre-game features (props) | — | **AUC 0.559 vs 0.572 for the probability alone** — worse than doing nothing |
| Miss-risk model (game picks) | — | **AUC 0.509–0.514 vs 0.574** — no signal at all |
| Early-hook risk for pitcher props | predictable on its own (AUC 0.646) | **adds nothing among confident picks** (AUC 0.48 / 0.56 / 0.37) — already priced in |
| High run environment ("hot months") | month-level r = **−0.83** | **game-level r = −0.018**, sign flips season to season — the month correlation was an artifact of averaging into 6 points |

Refitting the hit probability with every available feature made the held-out log
loss **worse** (0.56702 → 0.56748). A month-of-season correction learned on
2023–24 and applied to 2025–26 improved log loss by **0.00001**.

**What we did learn is mechanical, not predictive.** Misses have two dominant
physical causes — plate appearances not received, and starters hooked early —
and both are already inside the model's features. Knowing the cause does not
give you a lever the model has not already pulled.

---

## The board being analysed

3,167 picks at 70%+ confidence (the parlay card's bar), of which 873 missed —
**27.6%**, against 26.4% expected. Roughly a point overconfident overall.

| Market | picks | stated | actual | gap |
|---|--:|--:|--:|--:|
| 1+ hits | 1,979 | 0.721 | 0.708 | −0.012 |
| 5+ strikeouts | 598 | 0.784 | 0.749 | **−0.035** |
| 16+ outs | 386 | 0.750 | 0.728 | −0.022 |
| 6+ strikeouts | 171 | 0.774 | 0.819 | +0.045 |
| 7+ strikeouts | 33 | 0.754 | 0.697 | −0.058 |

Only two of these gaps are worth a second look, and both are small relative to
their sample: the 5+ K market runs ~3.5 points hot, and 7+ K has 33 picks, which
is not a sample at all.

---

## 1. Anatomy — what actually went wrong

### Batters: it is a plate-appearance story

| PA received | picks | miss rate | share of all misses |
|---|--:|--:|--:|
| 3 | 59 | 47.5% | 4.9% |
| **4** | **919** | **39.4%** | **62.7%** |
| 5 | 892 | 19.3% | 29.8% |
| 6 | 84 | 13.1% | 1.9% |

**A fifth plate appearance halves the miss rate** (39.4% → 19.3%). Nearly
two-thirds of all batter misses come from 4-PA games. This is the single
clearest fact in the analysis — and it is also the least actionable, because
whether a hitter gets a fourth or fifth trip depends on how the game unfolds,
not on anything visible at first pitch. The pre-game proxy for it — lineup slot
— is already the model's largest coefficient.

One tempting sub-story does **not** survive: home teams that win skip the bottom
of the 9th, so home batters average 4.36 PA against 4.59 for road batters. But
their miss rates are 28.2% vs 29.8%, with overlapping confidence intervals. The
lost plate appearance is real; the lost bet is not.

### Pitchers: it is the hook

| Length of start | picks | miss rate | share of pitcher misses |
|---|--:|--:|--:|
| under 4.0 IP | 66 | **80.3%** | 17.9% |
| 4.0–4.2 IP | 118 | 57.6% | 23.0% |
| 5.0–5.2 IP | 300 | 36.7% | 37.2% |
| 6.0+ IP | 704 | **9.2%** | 22.0% |

A starter who goes six innings almost never busts a confident pick (9.2%); one
who is pulled before the fourth busts it four times out of five. **41% of all
pitcher-prop misses come from the 15% of starts that ended before the fifth
inning.**

### Game context explains almost nothing

Miss rate by combined runs: 28.9% / 28.2% / 27.5% / 30.4% / 25.4% across the
range. By final margin: 26.9% / 30.3% / 26.6%. Extra-inning games: 26.0% vs
27.7%. Nothing here separates.

---

## 2. Does any pre-game feature move the residual?

For every pre-game feature, confident picks were split into quintiles and the
mean residual (actual − predicted) computed with bootstrap CIs. A calibrated
model should sit at zero everywhere.

Twelve cells cleared zero out of 165 tested. **At 95% confidence, ~8 are
expected by chance alone**, and the ones that appeared are not monotone — the
strikeout-rate feature, for example, gives −0.053 in quintile 2 and +0.043 in
quintile 3, which is noise wearing a star. The largest spread found for batters
was 0.100 (opposing starter's hit rate), which looks meaningful until you note
that the quintile means run +0.040, +0.022, −0.051, −0.014, −0.059 — no
monotone trend, no mechanism, no replication.

---

## 3. The decisive test: can a model predict misses?

Fit a miss-risk model on the first 55% of the season and test on the rest.

**Props (train 1,658 confident picks → test 1,509):**

| Predictor of "this pick misses" | AUC | log loss |
|---|--:|--:|
| **baseline: 1 − model probability** | **0.5717** | **0.5670** |
| logistic on all pre-game features | 0.5586 | 0.5702 |
| hist-GBM on all pre-game features | 0.5383 | 0.6096 |

**Game picks (train 2023–24 → test 2025–26, 917 picks):**

| Predictor | AUC | log loss |
|---|--:|--:|
| **baseline: 1 − confidence** | **0.5736** | **0.6558** |
| logistic on all pre-game features | 0.5094 | 0.6636 |
| hist-GBM on all pre-game features | 0.5142 | 0.7188 |

In both cases the features actively *hurt*. The probability the model already
publishes is the best available miss predictor, and nothing improves on it.

Stated as calibration rather than ranking: refitting the hit probability with
every feature available moved held-out log loss from **0.56702 to 0.56748** —
i.e. backwards.

---

## 4. The two leads that looked real, and why they are not

### The early hook is predictable — but already priced

A model predicting "this starter fails to reach the fifth" from pre-game
features alone reaches **AUC 0.6455**, and the top risk quartile has a 47% hook
rate against 21% in the bottom. That looks like a flag worth shipping.

It is not, because the prop model already uses those same features. Restricted
to picks the model *already* rates at 70%+, hook risk predicts that market's
miss at AUC **0.48 (16+ outs), 0.56 (5+ K), 0.37 (6+ K)** — at or below chance.
The information has been spent; the model has already marked down the starters
who get pulled.

### The "hot months" effect is an averaging artifact

Aggregated to six month-level points, run environment and the confidence gap
correlate at **r = −0.83**: June and July are the highest-scoring months (9.16
and 9.13 runs per game vs 8.84–8.89 elsewhere) and also the two months where
favorites underperform their stated confidence. A tidy story — more scoring,
more variance, favorites convert less.

Computed pre-game, per game, on the actual expected run environment (team
scoring rates and park factor, strictly from prior games), the correlation is
**−0.018**. The quintile pattern is non-monotone, the top-minus-bottom
difference is +0.0045 [−0.063, +0.072], and the per-season differences are
−0.175, +0.008, +0.064, +0.065 — sign-flipping noise. On the never-inspected
2021–22 seasons the correlation is −0.018 as well.

Six points will correlate with almost anything. The game-level data, which has
2,133 points, says there is nothing there. And the practical test settles it: a
month correction learned on 2023–24 and applied to 2025–26 improved log loss by
**0.00001**.

---

## What this means for the parlay

Since no leg can be flagged as fragile in advance, the only levers that
actually work are the ones already on the card:

1. **The confidence bar.** It is not a flag, but it is a real dial — legs above
   75% miss 23% of the time, legs at 70–75% miss ~29%.
2. **Leg count.** With misses independent-ish and unpredictable, every added leg
   multiplies. This is why the slip cashes 27% of the time at ~6 legs and never
   at 23.
3. **Market choice.** 5+ strikeouts runs ~3.5 points hot at the high bar — the
   one market-level bias with enough sample to take seriously. Worth a small
   haircut when it appears on a slip.

What does **not** work, and should not be built: a "risk score" per leg. Three
independent attempts at one all landed below the baseline of simply trusting the
published probability.

---

## The honest frame

A model that is well calibrated has, by construction, no exploitable pattern in
its residuals — that is what calibration *means*. These props are well
calibrated (0.72 predicted → 0.708 actual at the top bucket), so finding nothing
is the expected result, not a failure of the search. The value of this analysis
is in ruling out the four most plausible flags cheaply, and in knowing that the
misses are mechanical: a fourth plate appearance instead of a fifth, a starter
pulled in the fourth. Those are things baseball decides after first pitch.

---

## Files

| File | Purpose |
|---|---|
| `research/mlb-props/miss_analysis.py` | The full analysis: anatomy, residual scan, predictive tests, mechanisms, game model |
| `research/mlb-props/miss_analysis_rows.csv` | Every confident pick with its outcome and what happened in the game |
