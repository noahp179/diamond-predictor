# MLB Home-Run-Hitter Model — Full Report

The MLB analog of the [NFL TD-scorer expedition](NFL-TD-SCORER-RANKINGS.md):
build a model for **which batter(s) are most likely to hit a home run in a
game**, backtest it, and exhaustively search for anything better — many
algorithms plus the premium batted-ball-quality features (Statcast). Code:
`research/mlb-hr/`.

---

## TL;DR

- Built a leak-free, season-to-date **home-run-hitter model** and backtested it
  on **2024 (48,298 batter-game predictions, 2,429 games)**.
- **Home runs are much harder to predict than touchdowns** — best **AUC ≈ 0.62**
  (vs 0.70 for NFL TDs). The single most-likely batter homers **~20%** of the
  time; one of the **top 5 homers ~57%** of the time.
- **Same story as the NFL:** simple models win, complex ones overfit. Logistic
  regression / extra trees ≈ 0.62; **XGBoost, LightGBM, and the neural net are
  far worse** (0.51–0.57).
- **The premium feature (Statcast barrel% / xISO) adds only +0.0048 AUC —
  within noise.** Expected-ISO is a *cleaner* power measure than box-score HR
  rate (it becomes the top driver), but the predictable signal was already
  captured, so the net gain is marginal — exactly like NFL red-zone.

**The ceiling is set by the irreducible randomness of the event, not the model.**

---

## Data & features

**Source:** MLB's official Stats API (`statsapi.mlb.com`) — one box score per
game. **97,754 batter-games / 41,427 pitcher-games** across 2023–2024. Ground
truth = the batter hit ≥1 HR (box score).

A chronological walk builds each batter's and pitcher's history (carried across
seasons so power is stable from opening day). Features, all pre-game:

| group | features |
|---|---|
| **power** | career HR/PA (shrunk to league), isolated power, recent-form HR/PA (EWMA) |
| **opportunity** | recent PA/game, lineup slot, games of history, career PA |
| **matchup** | opposing starter's HR-allowed rate, **park HR factor**, home/away |

The signal is real but modest — HR rate by lineup slot runs **15.1% (slot 3) →
7.4% (slot 9)**, and the logistic leans on career HR rate, park, plate-appearance
volume, and slot.

---

## The model sweep (test 2024)

Ranked by AUC. Base rate 10.6%; over 48k predictions the AUC noise band is
roughly **±0.013 (95%)**, so the top four are a statistical tie.

| # | Model | AUC | ΔAUC | Top-1 | Top-3 | Top-5 |
|--:|---|--:|--:|--:|--:|--:|
| 1 | extra trees | 0.6240 | +0.0035 | 19.8% | 42.2% | 56.8% |
| 2 | logistic L1 | 0.6217 | +0.0012 | 20.1% | 42.7% | 57.2% |
| 3 | **logistic (baseline)** | 0.6205 | — | 19.8% | 42.8% | 57.1% |
| 4 | STACK (LR+HGB+RF+XGB) | 0.6196 | −0.0010 | 18.4% | 41.6% | 57.1% |
| 5 | gaussian naïve Bayes | 0.6126 | −0.0079 | 20.0% | 43.1% | 56.7% |
| 6 | random forest | 0.6116 | −0.0089 | 18.0% | 40.3% | 55.5% |
| 7 | hist-GBM | 0.6047 | −0.0158 | 13.9% | 36.4% | 52.5% |
| 8 | kNN | 0.5942 | −0.0263 | 17.6% | 39.3% | 54.7% |
| 9 | gradient boosting | 0.5753 | −0.0452 | 10.2% | 28.9% | 45.7% |
| 10 | XGBoost | 0.5733 | −0.0473 | 12.9% | 32.5% | 47.8% |
| 11 | LightGBM | 0.5677 | −0.0528 | 12.0% | 32.6% | 47.5% |
| 12 | MLP (neural net) | 0.5175 | −0.1030 | 11.0% | 30.3% | 44.2% |

Same shape as the NFL board: a cluster of simple models at the top, gradient
boosting and neural nets well below them (they fit the noise in a rare, high-variance target).

---

## The premium-feature experiment — does Statcast beat box-score power?

The batted-ball-quality metrics (barrel rate, expected ISO / wOBA from
baseball-savant) are the theoretical best HR predictors — the MLB analog of NFL
red-zone usage. Added as each batter's **prior-season** Statcast profile
(leak-free, 92% coverage):

| model | AUC | ΔAUC | Top-1 | Top-3 | Top-5 |
|---|--:|--:|--:|--:|--:|
| box-score model (baseline) | 0.6205 | — | 19.8% | 42.8% | 57.1% |
| **+ Statcast (barrel / xISO / xwOBA)** | 0.6253 | **+0.0048** | 20.0% | 43.4% | 57.6% |
| Statcast-only (no box power) | 0.6169 | −0.0036 | 19.6% | 42.7% | 56.6% |

**Verdict: a marginal, non-significant lift (+0.0048, inside the ±0.013 band).**
Interesting nuance: with Statcast in, **xISO becomes the single strongest driver
(coef 0.194) and demotes box-score career HR rate (0.183 → 0.062)** — expected-ISO
is a *better-measured* version of the same "how much power" signal. But because
it mostly *replaces* rather than *adds*, the net gain is small. Statcast-only is
even slightly worse, confirming the two are largely redundant.

---

## Key findings

1. **HR is a coin-flippier event than a TD.** Ceiling AUC ~0.62 vs ~0.70; top-1
   ~20% vs ~50%. A batter gets ~4 chances and converts ~3% of them; the outcome
   is dominated by variance no model can see.
2. **Simple beats complex — again.** Logistic and extra trees tie for best;
   XGBoost, LightGBM and the MLP overfit and land far below.
3. **The "obvious" premium feature helps only marginally — again.** Statcast
   barrel/xISO (+0.0048) mirrors NFL red-zone (−0.0004): the predictable part of
   the signal is already in the simple features.
4. **Best drivers:** career HR rate / xISO (power), plate-appearance volume and
   lineup slot (opportunity), and park HR factor. Opposing-starter HR rate and
   home/away add little (park already encodes venue; batters also face the pen).

## Same lesson as the NFL, across two very different sports

| | NFL TD scorer | MLB HR hitter |
|---|---|---|
| Best model | logistic + market | logistic (+ Statcast, tiny edge) |
| Ceiling AUC | ~0.70 | ~0.62 |
| Top-1 hit rate | ~50% | ~20% |
| Complex models (XGB/NN) | worse | worse |
| "Premium" feature | red zone: −0.0004 | Statcast: +0.0048 |
| Verdict | information ≫ algorithm | information ≫ algorithm |

In both, a **plain regularized logistic regression is at the ceiling**, extra
model capacity fits noise, and the only real lever is *new information* — for
MLB the untapped one would be **live HR prop odds** (the market's own per-batter
line) or pitch-level matchup data, not a fancier learner.

---

## Recommendation

- If shipped, use **logistic regression** on the box-score features (optionally
  + prior-season Statcast xISO for a ~half-point AUC edge). Do **not** use
  gradient boosting or a neural net — measurably worse here.
- Set expectations honestly in any UI: HR is high-variance, so lead with the
  **top-3 / top-5** (43% / 57%) rather than a single pick (~20%).
- This report is the analysis + backtest. Wiring an **"HR Hitters" tab** into the
  MLB page — the analog of the NFL TD Scorers tab — is the natural next step;
  say the word and I'll build it (same live-from-StatsAPI pattern, with a model
  choice + placement check like we did for NFL).

---

## Files

| File | Purpose |
|---|---|
| `research/mlb-hr/fetch_mlb.py` | Collects batter/pitcher box scores from MLB StatsAPI |
| `research/mlb-hr/exhaustive_mlb.py` | Season-to-date HR features + the 12-model sweep |
| `research/mlb-hr/statcast_test.py` | The Statcast premium-feature experiment |
| `research/mlb-hr/mlb_hr_results.json` | Saved sweep results |
