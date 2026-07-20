# NFL Anytime-Touchdown-Scorer Model — Algorithm & Backtest

**Question:** entering a specific NFL game, which **one or two players** are most
likely to score a touchdown — with a stated **likelihood** and a separate
**confidence** in the pick?

This document describes the algorithm that was researched and built to answer
that, and reports a leakage-controlled backtest against **what actually
happened** in 1,139 real games (2021–2024). No app/product changes were made —
this is the algorithm and its evidence only. All code lives in
[`research/nfl-td-scorer/`](research/nfl-td-scorer/).

---

## TL;DR — headline results (out-of-sample: 2023–2024, 569 games)

| Metric | Model | Baseline | Read |
|---|---|---|---|
| **Top-1 pick scored a TD** | **48.3%** | 46.7% (most-touches heuristic) | The single most-likely player scores nearly half the time — **2.26× the average ranked player** |
| **Top-2: ≥1 of two scored** | **68.9%** | — | Two names cover ~7 of every 10 games |
| **Brier score** | **0.1559** | 0.1680 (no-skill) | **+7.2% skill** — the probabilities carry real information |
| **Log loss** | **0.4843** | 0.5187 (no-skill) | +6.6% skill |
| **ROC AUC** | **0.680** | 0.500 | Solid ranking of who-scores-vs-who-doesn't |
| **Calibration error (ECE)** | **0.010** | — | Stated likelihoods match reality (a "40%" hits ~40%) |
| **Confidence works** | 57.9% vs 37–49% | — | Top-confidence picks hit far more than low-confidence ones |

**Bottom line:** the model produces **honest, calibrated probabilities** and a
**confidence score that tracks reality**. It clearly beats a no-skill baseline
on probability quality and, for the single top pick, edges a strong volume-only
heuristic by ~1.6 pts. The candid finding is that *anytime-TD scoring is
volume-dominated and noisy* — most of the "who scores" signal is simply "who
touches the ball a lot near the end zone," and the model's real value-add is
**calibrated likelihood + confidence + full-field ranking**, not radically
out-picking volume on the #1 name.

---

## 1. The idea (research basis)

Touchdown scoring is well modeled as a **rate (Poisson) process** driven by
opportunity. Two facts motivate the design, both visible in the data:

- **Usage predicts TDs strongly.** Anytime-TD rate by touches in a game:

  | touches (carries+targets) | 1–4 | 5–9 | 10–14 | 15+ |
  |---|---|---|---|---|
  | anytime-TD rate | 9.4% | 25.3% | 36.4% | **52.7%** |

- **A game only has ~2.2 offensive TDs per team** (rush 0.86, rec 1.36 in this
  sample), so a good model must (a) figure out *how many* TDs a team scores and
  (b) *allocate* them to the players most likely to finish drives.

So the model separates **shape** (who) from **scale** (how many):

```
P(player scores ≥1 TD)  =  1 − exp(−λ_player)          # Poisson

λ_player = λ_rush + λ_rec
λ_rush   = (team's expected rushing TDs)  × (player's share of rush scoring)
λ_rec    = (team's expected receiving TDs)× (player's share of rec scoring)
```

**Scale — team expected TDs (a log5-style matchup):**

```
teamRushTD = leagueRushTD · (offRushRating/lg)^p · (defRushAllowed/lg)^p
teamRecTD  = leagueRecTD  · (offRecRating /lg)^p · (defRecAllowed /lg)^p
```

Offense's recent scoring and the opponent defense's recent TDs allowed are each
shrunk toward league average (a few games of prior), then combined. The exponent
`p = 0.70` damps extreme "elite offense vs. terrible defense" spots that
otherwise blow up.

**Shape — player share of the team's scoring opportunity:**

```
rawRush(player) = (projCarries · rushTDrate)^γ      # γ = 0.85 flattens concentration
rawRec (player) = (projTargets · recTDrate )^γ
share = raw(player) / Σ raw(teammates)              # so λ's sum to the team total
```

- **projCarries / projTargets** — a recency-weighted (3-game half-life) average
  of the player's touches. Answers *who gets the ball.*
- **rushTDrate / recTDrate** — the player's per-touch scoring rate, **shrunk**
  toward the league baseline (`+25` carries / `+30` targets of prior). This is
  what captures a **goal-line back** or **red-zone receiver** who converts
  touches into TDs at an above-average clip, without letting one fluky early TD
  dominate.

Because rushing carries include **quarterback runs**, mobile QBs (Josh Allen,
Jalen Hurts, Anthony Richardson…) correctly surface as rushing-TD threats — they
appear in several backtest examples below.

### Confidence (separate from likelihood)

The **likelihood** is `P(anytime TD)` for the pick. The **confidence** is a
0–100 score for how much to trust that this player is *the* top scorer, built
from three transparent ingredients:

- **separation** — how far the pick's expected TDs sit above the next player
  (a clear favorite beats a coin-flip backfield committee),
- **maturity** — how many prior games inform the projection,
- **volume** — how many touches the player is projected to see.

Crucially, the backtest **validates** this number: higher-confidence picks
actually hit more often (see §4).

---

## 2. Data & ground truth

| | Source | Reachable here | Used for |
|---|---|---|---|
| Game list + ESPN ids | nflverse schedules (raw.githubusercontent) | ✅ | which games exist |
| Box scores + scoring plays | ESPN summary API | ✅ | features **and** outcomes |

*(nflverse's play-by-play release assets are blocked in this environment, so the
model deliberately uses only box-score-grade inputs — carries, targets,
receptions, yards, TDs — which ESPN exposes cleanly.)*

- **1,139 games** (2021–2024), **22,469 player-game rows**, **5,699 touchdowns**.
- **Ground-truth label** for "did player X score" comes **directly from the
  box-score TD columns** (`rush_td + rec_td > 0`) — text-independent and
  leak-free. Scoring-play text is used only to cross-check and to identify
  non-box-score scorers.
- **Ceiling note:** **5.2%** of all TDs are scored by defenders / special-teams
  returners. An offensive-usage model *cannot* predict those, so ~5% of "top
  pick missed" games are structurally unwinnable.

---

## 3. Backtest protocol (no leakage)

Strict **walk-forward** in real chronological order (bucketed by kickoff day so
same-day games never inform each other):

| Season | Role |
|---|---|
| **2021** | Warm-up: seeds running player/team state; calibrates league priors |
| **2022** | Validation: structural constants and the probability **calibration** were fit here |
| **2023–2024** | **Test: reported headline numbers — never touched by any fitting** |

For each game, every player's features are built **only from earlier games**.
The one thing conditioned on is the **active list** — we rank players who
appeared in the box score, exactly as a bettor conditions on inactives published
~90 minutes before kickoff. Whether/how a player scored is **never** an input.

- **Probability calibration:** a 2-parameter Platt logistic (`a=0.709,
  b=−0.328`) fit on 2022 only, applied to 2023–2024. Calibration is monotonic,
  so it changes *stated likelihoods*, not *who is picked*.

Reproduce: `python fetch_espn.py && python backtest.py && python final.py`.

---

## 4. Results (out-of-sample 2023–2024)

### 4.1 Probability quality

| Predictor | Brier ↓ | Log loss ↓ | AUC ↑ |
|---|---|---|---|
| Constant base rate (no skill) | 0.1680 | 0.5187 | 0.500 |
| Model (raw Poisson) | 0.1557 | 0.4852 | **0.680** |
| **Model (calibrated)** | **0.1559** | **0.4843** | **0.680** |

The model reduces Brier by **7.2%** and log loss by **6.6%** vs. assigning every
player the league base rate. AUC **0.680** means: take a random player who scored
and one who didn't — the model rates the scorer higher 68% of the time.

### 4.2 Calibration (are the stated likelihoods honest?)

Platt calibration cut **ECE from 0.0164 → 0.0100**. Calibrated reliability on the
test seasons:

| predicted | n | mean predicted | actual |
|---|---|---|---|
| 0–10% | 902 | 0.080 | 0.079 |
| 10–20% | 4,264 | 0.150 | 0.147 |
| 20–30% | 2,917 | 0.245 | 0.249 |
| 30–40% | 1,176 | 0.341 | 0.380 |
| 40–50% | 298 | 0.439 | 0.483 |
| 50–60% | 51 | 0.528 | 0.686 |

Predicted ≈ actual across the mass of the distribution. The top two bins run a
touch *hot* (model slightly under-states the very biggest favorites) but hold
few games (n=51, 4).

### 4.3 Pick accuracy

| | Result |
|---|---|
| **Top-1 pick scored a TD** | **48.3%** (volume baseline 46.7%; **lift +1.6 pts**) |
| **Top-2: ≥1 scored** | **68.9%** |
| Top-1 lift over average ranked player | **2.26×** |
| Recall@2 / @3 (share of a game's scorers caught in top-2 / top-3) | 22.9% / 31.3% |
| Coverage of actual TD scorers (had any projection) | 90.3% |

### 4.4 Confidence validation

The confidence score is meaningful — top-1 hit rate **rises with confidence**:

| confidence tier | games | top-1 hit rate |
|---|---|---|
| 0–45 | 47 | 48.9% *(small n; wide-open committee games)* |
| 45–60 | 159 | 37.1% |
| 60–75 | 166 | 47.6% |
| **75–100** | 197 | **57.9%** |

A high-confidence pick (75+) hitting **57.9%** vs. **37%** for mid-confidence is
the difference between a strong lean and a coin flip.

### 4.5 Stability across seasons (full model, 2022–2024)

| Season | Top-1 | Top-2 | vs volume |
|---|---|---|---|
| 2022 | 46.8% | 66.5% | +3.1 |
| 2023 | 46.8% | 70.4% | +0.7 |
| 2024 | 49.8% | 67.4% | +2.4 |

No single season carries the result — the edge over volume ranges +0.7 to +3.1
pts, honest and consistent.

### 4.6 Example predictions (top-2 per game, calibrated likelihood + confidence)

| Game | Pick | Likelihood | Confidence | Result |
|---|---|---|---|---|
| IND @ HOU (2023 W2) | Anthony Richardson (IND) | 43% | 49 | ✅ TD |
| | Zack Moss (IND) | 34% | 47 | ✅ TD |
| PHI @ WAS (2023 W8) | A.J. Brown (PHI) | 37% | 77 | ✅ TD |
| | D'Andre Swift (PHI) | 28% | 55 | ✅ TD |
| ATL @ CHI (2023 W17) | Bijan Robinson (ATL) | 31% | 71 | ❌ |
| | Justin Fields (CHI) | 27% | 44 | ✅ TD |
| NYJ @ MIN (2024 W5) | Breece Hall (NYJ) | 36% | 80 | ❌ |
| | Justin Jefferson (MIN) | 30% | 42 | ❌ |
| BUF @ LA (2024 W14) | James Cook (BUF) | 46% | 61 | ❌ |
| | Josh Allen (BUF) | 43% | 39 | ✅ TD |
| BUF @ NE (2024 W18) | James Cook (BUF) | 53% | 89 | ✅ TD |
| | Keon Coleman (BUF) | 38% | 36 | ❌ |

Hits and misses both shown — mobile QBs (Richardson, Fields, Allen) surfacing as
scoring threats is a feature of using rushing carries directly.

---

## 5. Honest limitations

1. **Volume is most of the signal.** For the single top pick, the efficiency +
   matchup machinery only adds ~1.6 pts over "pick the player with the most
   projected touches." TD scoring is genuinely noisy; nobody predicts the exact
   scorer reliably. The model's advantage is **calibrated probabilities and
   confidence**, which a heuristic cannot give.
2. **No injuries / depth-chart / weather / Vegas inputs.** The model conditions
   on the active list but doesn't know a player is questionable, benched at the
   goal line, or that the game total is 52. A market line (implied team total)
   would meaningfully sharpen the *scale* term.
3. **Box-score-grade features only.** No true goal-line-carry or red-zone-target
   counts (play-by-play was blocked here). Those are the highest-value features
   for this exact problem and would most improve it.
4. **~5% irreducible misses** from defensive / special-teams TDs, plus rookies'
   debuts with no history.
5. **Confidence's lowest tier is noisy** (n=47) and non-monotonic at the bottom —
   very-low-confidence games are wide-open backfields where even the "favorite"
   is barely ahead.

## 6. What would sharpen it (if productionized later)

In rough order of expected value: **implied team totals from the odds market**
(the app already ingests odds) → **red-zone / goal-line usage** from play-by-play
→ **injury/active + snap-share** feeds → a small **gradient-boosted model** over
these features to replace the hand-built allocation. None of that is built here
by design — this deliverable is the algorithm and its honest backtest.

---

## 7. Files

| File | Purpose |
|---|---|
| `research/nfl-td-scorer/fetch_espn.py` | Pull nflverse game list + ESPN box scores / scoring plays → tidy CSVs |
| `research/nfl-td-scorer/model.py` | The algorithm (Poisson usage-allocation model + confidence) |
| `research/nfl-td-scorer/backtest.py` | Walk-forward engine + metrics (full 2022–2024) |
| `research/nfl-td-scorer/sweep.py` | Validation-season sweep of structural constants |
| `research/nfl-td-scorer/final.py` | Leakage-controlled train/test split + Platt calibration + examples |
| `research/nfl-td-scorer/metrics.json`, `final_metrics.json` | Saved numbers behind this report |
| `research/nfl-td-scorer/game_picks.csv` | Every game's top-1/top-2 pick and outcome |
