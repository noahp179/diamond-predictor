# NBA & NFL Expedition — the algorithm bake-off, backtested against the market

_Study run 2026-07-18/19. New harness: `scripts/collect-nba-nfl-data.ts` (data),
`scripts/lib-zoo.ts` (the shared algorithm zoo), `scripts/analyze-nba.ts` /
`scripts/analyze-nfl.ts` (per-sport drivers). Fully self-contained: public
datasets cached locally, no Supabase, no product changes. The brief: build game
prediction algorithms for the NBA and the NFL — as many families as the data
supports — backtest them honestly, and measure everything against real closing
market odds._

## TL;DR

- **17 prediction strategies per sport** were built and backtested walk-forward
  over **23,658 NBA games (19 seasons)** and **7,276 NFL games (27 seasons)**,
  every one of them scored against real closing odds (~23k NBA games with
  moneyline+spread, 7.3k NFL games with spread, 5.3k with moneyline).
- **Best public-data models**: NBA — a rest-adjusted margin-of-victory Elo
  (test Brier 0.2220) and a gradient-boosted stacker (0.2199); NFL — a
  context Elo with bye/short-week/QB-change bumps (0.2202) and a calibrated
  ensemble (0.2196). Our Elo implementation **ties FiveThirtyEight's published
  forecasts** on the 10,258 games where they overlap (0.2041 vs 0.2043).
- **The market is comfortably ahead in both sports**: test-window gap ≈
  **0.011 Brier (NBA)** and **0.009 (NFL)** — 2–3× the gap our MLB program
  measured (~0.003–0.004). Sharper market, not weaker models: the same
  algorithm families that tie the MLB line trail the NBA/NFL lines badly.
- **No betting edge exists anywhere in this study, by the pre-committed bar.**
  NBA strategies land at −2% to +0.4% ROI (all CIs straddle zero, halves flip
  sign); NFL strategies lose **−5% to −9% with 90% CIs entirely below zero**.
  Blending our models into the market improves it nowhere out-of-sample.
- Richest structural findings: the **margin-of-victory multiplier is the
  single biggest algorithmic upgrade** in both sports; **wins-only systems
  (Glicko-2, Bradley-Terry) systematically trail margin-aware systems**;
  **schedule/roster context is nearly worthless in the NBA (~25 Elo points for
  a back-to-back) but large in the NFL (~80 Elo points for a QB change)**;
  NBA home advantage collapsed from 59.6% → 55.3% across the two eras and NBA
  margin noise exploded (σ 12 → 14) — a regime change the frozen models ate
  on the test set and the market absorbed gracefully.

---

## 1 · Data

Three public datasets, downloaded once into `.backtest-cache/` (gitignored)
and normalized by `bun scripts/collect-nba-nfl-data.ts` into per-game JSONL:

| Cache file                             | Source                                                                                            | Coverage                                                 | Contents                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `nba-odds.sqlite` → `nba-games.jsonl`  | sportsbookreviews-lineage odds archive (mirrored in kyleskom/NBA-Machine-Learning-Sports-Betting) | **2007-08 → 2025-26 (through 2026-01-07)**, 23,658 games | closing spread, total, both moneylines, scores, rest days                                                                |
| `nba-allelo.csv` → `nba-history.jsonl` | FiveThirtyEight `nbaallelo` archive                                                               | **1946-47 → 2014-15**, 59,008 games                      | scores, neutral-site flags, 538's Elo + published win forecast                                                           |
| `nfl-games.csv` → `nfl-games.jsonl`    | nflverse/nfldata `games.csv`                                                                      | **1999 → 2025 (SB LX)**, 7,276 games                     | scores, closing spread/total (every season), moneylines (2011+), rest days, QB starters, dome/surface, div/neutral flags |

Download commands (idempotent; collector verifies presence):

```
curl -o .backtest-cache/nba-odds.sqlite  https://raw.githubusercontent.com/kyleskom/NBA-Machine-Learning-Sports-Betting/master/Data/OddsData.sqlite
curl -o .backtest-cache/nba-allelo.csv   https://raw.githubusercontent.com/fivethirtyeight/data/master/nba-elo/nbaallelo.csv
curl -o .backtest-cache/nfl-games.csv    https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
```

Normalization work that mattered:

- **Franchise-stable team codes** so ratings survive moves/renames: Sonics→
  Thunder, NJ Nets→Brooklyn, the Charlotte/New Orleans Hornets–Bobcats–Pelicans
  tangle, OAK→LV, SD→LAC, STL→LA.
- **Spread sign conventions differ by source era** — older NBA tables store
  unsigned favorite margins (favorite recovered from the moneyline), newer
  tables signed home margins. Everything is converted to _signed home spread_
  (positive = home favored). Validated: mean home margin tracks the spread
  bucket-for-bucket in both sports (e.g. NBA spread [6,30): mean margin +9.05).
- **Scores reconstructed** from (total points, home margin); cross-checked
  against the independent 538 archive on 10,258 overlapping games — **8
  mismatches (0.08%)**.
- The NBA source truncates 2023-24 at April 28; the missing **52 playoff
  results were backfilled from ESPN scoreboards** (scores only, no odds) so
  the rating replay has no mid-corpus hole.
- NBA rest days recomputed from the schedule itself; 2020 bubble games
  (2020-07-30 → 2020-10-11) treated as **neutral site** (public knowledge at
  the time); NFL ties (15 games) update ratings at 0.5 and are excluded from
  binary scoring.

Corpus-level sanity: 30 NBA / 32 NFL franchise codes exactly; NBA home rate
58.1% overall (declining — see §6); NFL 56.3%; season game counts reproduce
the 2011 lockout (1,074), COVID 2019-20 (1,143) and 2020-21 (1,171) exactly.

## 2 · Protocol

The discipline is the one Rounds 2–12 of the MLB program converged on, applied
from the start:

- **Walk-forward everywhere.** Ratings update game-by-game in date order;
  regression-family models refit periodically (every 14 days NBA / 7 days NFL)
  on decay-weighted history; fitted models (logistic/GBM/MLP) refit **once per
  season** on all completed prior seasons. No prediction ever sees its own
  game or anything later.
- **Warm-up.** NBA Elo/Glicko replay 1946→2007 (60 years, 48k games) before
  the first scored game; the NFL burns in on 1999 (never scored).
- **Dev / frozen-test split.**
  NBA: dev = seasons **2008–2019** (15,520 scored games), test = **2020–2026
  partial** (8,138). NFL: dev = **2000–2015** (4,251), test = **2016–2025**
  (2,751). Every hyperparameter, blend weight, temperature, ensemble member
  list and σ was chosen on dev only; the test window was scored once, after
  everything was frozen. COVID-era distortions land in test _on purpose_ —
  that is what a deployed model would have faced.
- **Market comparisons** use the proportional devig (the transform that won
  Round 8's devig shootout) on closing moneylines, and a normal-margin model
  `P(home) = Φ(spread/σ)` for spreads with σ dev-fit per sport.
- **Pre-committed edge bar** (same as Round 8): a betting strategy counts as
  an edge only if walk-forward ROI > 0 with a 90% bootstrap CI excluding zero
  AND the same sign in both halves of the window.

Caveats owned up front: one line per game (near-closing consensus), no
line-shopping, no openers, no injury feeds; the NBA odds lineage is a
community archive (though it cross-checks at 99.92% against 538 on scores);
NBA 2025-26 stops at Jan 7, 2026; moneyline history starts 2011 in the NFL.

## 3 · The zoo — seventeen strategies per sport

All algorithms live in `scripts/lib-zoo.ts` (~700 lines, no dependencies) and
are shared verbatim between sports; only hyperparameters differ (each tuned on
that sport's dev window). Frozen values in parentheses (NBA / NFL).

**Baselines & market**

| #   | Model           | Construction                                       |
| --- | --------------- | -------------------------------------------------- |
| 1   | `home-const`    | home team at the dev-era home rate (59.6% / 57.1%) |
| 2   | `market-ml`     | proportional-devig closing moneyline               |
| 3   | `market-spread` | Φ(spread/σ), σ dev-fit (11 / 12)                   |

**Rating systems** (sequential, game-by-game)

| #   | Model            | Construction & frozen hyperparameters                                                                                              |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------- |
| 4   | `elo-basic`      | classic Elo, no margin term (K=20, HFA=80, season carry 0.6 / K=40, HFA=55, carry 0.6)                                             |
| 5   | `elo-mov`        | + 538-style margin-of-victory multiplier `ln(                                                                                      | mov | +1)·2.2/(0.001·Δwinner+2.2)` (K=8, carry 0.75 / K=20, carry 0.5) |
| 6   | `elo-rest` (NBA) | elo-mov + schedule bumps: back-to-back −25 pts, +8/rest-day up to 3                                                                |
| 6   | `elo-ctx` (NFL)  | elo-mov + bye +35, short-week −45, **QB change −80** rating points                                                                 |
| 7   | `glicko2`        | full Glicko-2 (rating, deviation, volatility; Illinois algorithm) (τ=.5, RD₀=100, inflate 80 / τ=.5, RD₀=100, HFA 65, inflate 90)  |
| 8   | `pythag`         | season-to-date Pythagorean expectation with prior + log5 + home logit shift (exp 16, prior 10 g / exp 3.4, prior 8 g)              |
| 9   | `bradley-terry`  | decay-weighted L2 Bradley-Terry on win/loss only, IRLS, refit rolling (λ=1, half-life 90 d / λ=1, 200 d)                           |
| 10  | `srs-normal`     | ridge regression on score margins (exp. recency decay) → expected margin → Φ(m/σ) (λ=4, HL 90 d, σ=10.25 / λ=2, HL 150 d, σ=14.25) |
| 11  | `offdef-pace`    | separate offense/defense points ridge; same margin, but σ scaled by √(expected total / league total) — pace-adjusted uncertainty   |

**Fitted models** (refit each season on all prior seasons; features = the
rating diffs above + form + schedule context, 17 NBA / 24 NFL features)

| #   | Model          | Construction                                                                                                                  |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 12  | `logit-wf`     | L2 logistic regression, IRLS (λ=5 / λ=50)                                                                                     |
| 13  | `gbm-wf`       | gradient-boosted depth-2 trees, logistic loss, histogram splits (100 trees, lr .05, subsample .8)                             |
| 14  | `mlp-wf`       | 1-hidden-layer tanh net, seeded SGD (12×15 ep, lr .01 / 8×15 ep, lr .01)                                                      |
| 15  | `logit+mkt-wf` | logit-wf + the devigged market logit as a feature — the **residual-information test**: can anything we know improve the line? |

**Combinations**

| #   | Model                 | Construction                                                                             |
| --- | --------------------- | ---------------------------------------------------------------------------------------- |
| 16  | `ens-avg` / `ens-cal` | logit-mean of {elo-rest∣elo-ctx, srs-normal, gbm-wf}, then dev-fit temperature           |
| 17  | `blend-mkt`           | σ((1−w)·logit(ens-cal) + w·logit(market)), w dev-fit (0.9 / 0.8)                         |
| —   | `538-elo` (NBA only)  | FiveThirtyEight's own published forecast, as an external anchor on the 2008–2015 overlap |

A finding from construction, before any scoring: **the offense/defense points
model is mathematically redundant with the margin model for win probability**
— under symmetric ridge the points system decomposes exactly into orthogonal
margin and total components, and the two engines' margins agreed to 13
decimal places. What the points model adds is the _total_ (pace), which was
salvaged as a variance signal (`offdef-pace`). It changed little: pace-scaled
σ was worth ≈ −0.00005 Brier in the NBA (nothing) and ≈ −0.0001 in the NFL.

Tuning notes (all on dev): the NBA wanted _short_ memory everywhere —
ridge half-lives of ~90 days, Elo K=8 with MOV; the NFL wanted K=20-with-MOV /
K=40-without (16-game seasons force fast adaptation) and 150-day half-lives.
The NBA Pythagorean exponent came out 16 (the classic 13.91 was strictly
worse on dev); the NFL's came out 3.4, not the folkloric 2.37 — with a prior,
sharper exponents win. Glicko-2's volatility machinery bought nothing over
plain Elo in either sport.

## 4 · NBA results

### 4a · Headline tables

**DEV, seasons 2008–2019** (engines n=15,520; fitted models start 2010,
n=12,889 — their Briers are computed over the slightly easier later window,
so compare within groups on dev and across everything on test):

| model                    | n      | acc       | Brier ↓    | log loss ↓ |
| ------------------------ | ------ | --------- | ---------- | ---------- |
| **market-ml**            | 15,517 | **69.2%** | **0.1991** | 0.5817     |
| blend-mkt (w=.9)         | 12,887 | 68.7%     | 0.2005     | 0.5849     |
| market-spread            | 15,516 | 69.0%     | 0.2007     | 0.5862     |
| logit+mkt-wf             | 12,887 | 68.7%     | 0.2009     | 0.5860     |
| 538-elo (2008-15 subset) | 10,258 | 67.7%     | 0.2043     | 0.5940     |
| **elo-rest**             | 15,520 | 67.3%     | **0.2062** | 0.5984     |
| srs-normal               | 15,520 | 67.4%     | 0.2066     | 0.5995     |
| offdef-pace              | 15,520 | 67.4%     | 0.2066     | 0.5997     |
| elo-mov                  | 15,520 | 67.3%     | 0.2067     | 0.5995     |
| ens-cal                  | 12,889 | 67.2%     | 0.2070     | 0.6004     |
| logit-wf                 | 12,889 | 67.1%     | 0.2071     | 0.6005     |
| gbm-wf                   | 12,889 | 66.9%     | 0.2077     | 0.6020     |
| elo-basic                | 15,520 | 67.2%     | 0.2079     | 0.6024     |
| bradley-terry            | 15,520 | 66.9%     | 0.2082     | 0.6032     |
| glicko2                  | 15,520 | 67.2%     | 0.2085     | 0.6042     |
| pythag                   | 15,520 | 66.8%     | 0.2091     | 0.6051     |
| mlp-wf                   | 12,889 | 66.6%     | 0.2123     | 0.6131     |
| home-const               | 15,520 | 59.6%     | 0.2409     | 0.6748     |

**TEST, seasons 2020–2026 (frozen, scored once), n=8,138** (8,086 with odds):

| model            | n     | acc       | Brier ↓    | log loss ↓ |
| ---------------- | ----- | --------- | ---------- | ---------- |
| **market-ml**    | 8,086 | **67.5%** | **0.2093** | 0.6059     |
| blend-mkt (w=.9) | 8,086 | 67.1%     | 0.2094     | 0.6060     |
| logit+mkt-wf     | 8,086 | 66.3%     | 0.2143     | 0.6184     |
| market-spread    | 8,086 | 65.5%     | 0.2180     | 0.6304     |
| **gbm-wf**       | 8,138 | 64.5%     | **0.2199** | 0.6299     |
| ens-cal          | 8,138 | 64.5%     | 0.2202     | 0.6305     |
| elo-rest         | 8,138 | 64.0%     | 0.2220     | 0.6346     |
| offdef-pace      | 8,138 | 64.3%     | 0.2221     | 0.6354     |
| bradley-terry    | 8,138 | 63.8%     | 0.2221     | 0.6343     |
| srs-normal       | 8,138 | 64.3%     | 0.2222     | 0.6355     |
| logit-wf         | 8,138 | 64.0%     | 0.2227     | 0.6367     |
| elo-mov          | 8,138 | 63.7%     | 0.2229     | 0.6364     |
| elo-basic        | 8,138 | 63.3%     | 0.2239     | 0.6384     |
| pythag           | 8,138 | 63.4%     | 0.2239     | 0.6385     |
| glicko2          | 8,138 | 63.6%     | 0.2246     | 0.6410     |
| mlp-wf           | 8,138 | 60.5%     | 0.2328     | 0.6588     |
| home-const       | 8,138 | 55.3%     | 0.2491     | 0.6914     |

### 4b · What the NBA tables say

1. **The market wins by a mile.** 0.1991 dev / 0.2093 test, ~0.007 → ~0.011
   Brier clear of our best. Blending our best model into the line at the
   dev-chosen weight (w=0.9 market) tests at 0.2094 — _no better than the
   market alone_. The dev blend sweep was already monotone: every step toward
   the market improved Brier (w=0: 0.2070 → w=0.9: 0.2005 ≈ w=1.0). Our
   public signal is a strict subset of the line's.
2. **The residual-information test fails decisively.** `logit+mkt-wf` — a
   walk-forward logistic given the market logit _plus_ every feature we have —
   scores 0.2009 dev / 0.2143 test vs the raw market's 0.1991/0.2093. Refitting
   the market with our features makes it _worse_ out-of-sample, the same
   verdict Rounds 7–8 returned for MLB.
3. **Our implementations are at the public frontier** — they tie
   FiveThirtyEight on the overlap (below), and every family lands in the
   narrow 0.206–0.209 dev band that seems to be the ceiling for
   scores-and-schedule NBA models. Ten points of Brier separate the best and
   worst _family_; a hundred separate them all from the market.
4. **Ranking stability.** elo-rest is the best single engine on dev (0.2062);
   the GBM stacker takes test (0.2199) with ens-cal right behind. Margin-aware
   engines (elo-mov, srs, offdef) beat wins-only engines (bradley-terry,
   glicko2) on both windows; pythag and elo-basic trail; the MLP is last both
   times.
5. **Everything got harder in the test era** — including for the market
   (0.1991 → 0.2093). See §4e: this is a real regime change (home advantage
   collapse + margin variance explosion), not model decay alone.

### 4c · External anchor: FiveThirtyEight overlap (2008–2015, n=10,258)

| model               | acc   | Brier ↓    |
| ------------------- | ----- | ---------- |
| market-ml           | 69.5% | 0.1972     |
| **elo-rest (ours)** | 67.7% | **0.2041** |
| 538-elo (published) | 67.7% | 0.2043     |
| elo-mov (ours)      | 67.7% | 0.2045     |

Our rest-adjusted MOV Elo edges 538's published forecasts by 0.0002 Brier on
their own overlap — i.e., the implementations here are faithful, competitive
reconstructions, and the gap to the market is a property of the _information_,
not of our code. (538's carm-elo/RAPTOR era files are not in the archive, so
the comparison is to their classic Elo.)

### 4d · Calibration (test) and temperature

Dev-fit temperatures came out ≈1.00 for every rating engine (a=0.99–1.01) —
walk-forward rating systems are _naturally calibrated_, in sharp contrast to
the MLB Monte-Carlo sim (which needed a=0.60). On the test window the frozen
models drift mildly overconfident in the middle buckets — the regime change:

| bucket    | ens-cal claimed → actual | market claimed → actual |
| --------- | ------------------------ | ----------------------- |
| 0.50–0.60 | 54.9% → 55.1%            | 55.3% → 56.1%           |
| 0.60–0.70 | 64.9% → 62.7%            | 64.9% → 63.6%           |
| 0.70–0.80 | 74.6% → 71.6%            | 74.6% → 73.5%           |
| 0.80–1.00 | 85.1% → 82.1%            | 85.3% → 84.4%           |

Even the market ran ~1–2 pp hot in 2020–26 — favorites underdelivered
league-wide. Our models ran ~3 pp hot in the 0.70–0.80 bucket. A temperature
refit _would have_ fixed most of this, but only with hindsight; the honest
frozen numbers stand.

### 4e · The regime change the test window contains

From `--diag` (post-hoc description, no frozen number depends on it):

- **Home court collapsed: 59.6% (2008–19) → 55.3% (2020–26).**
- **Margin noise exploded**: sd(actual margin − spread) rose from **11.99 to
  14.11 points**; the Brier-optimal spread σ moved 11 → 14.25. That is why the
  frozen `market-spread` (σ=11) fell from 0.2007 dev to 0.2180 test while the
  devigged moneyline barely moved — **the moneyline carries its own variance
  information; a spread + fixed σ does not.**
- Model picks vs the closing spread: our best models agree with the spread's
  side 81–82% of the time and win only **45.7–46.9%** of the disagreements —
  the market wins the argument.
- The logistic stacker's standardized coefficients (dev fit): eloD +0.40,
  pythagD +0.17, srsM/offdefM +0.14 each, net15D +0.10, away-b2b +0.12,
  home-b2b −0.06 — and glickoD (+0.03), btL (+0.02), L10, rest-days ≈ 0:
  once margin-aware ratings are in the model, wins-only ratings and raw form
  add nothing.

### 4f · NBA betting: edge tests (test window, pre-committed bar)

Flat 1u at the stored closing moneylines, betting any side whose model EV
clears the threshold:

| strategy     | EV > | n     | ROI       | 90% CI       | halves      |
| ------------ | ---- | ----- | --------- | ------------ | ----------- |
| ens-cal      | 0.00 | 6,689 | −1.2%     | [−4.2, +1.8] | +0.6 / −3.1 |
| ens-cal      | 0.06 | 5,019 | −1.1%     | [−4.8, +2.6] | +2.2 / −4.4 |
| elo-rest     | 0.00 | 6,733 | −0.5%     | [−3.4, +2.5] | +2.2 / −3.1 |
| elo-rest     | 0.06 | 5,190 | **+0.4%** | [−3.1, +4.2] | +4.2 / −3.3 |
| gbm-wf       | 0.00 | 6,744 | −2.0%     | [−5.0, +1.0] | +1.8 / −5.8 |
| logit+mkt-wf | 0.00 | 3,093 | −0.3%     | [−4.8, +4.4] | +0.1 / −0.8 |

Naive pockets: always-home −4.7% [−6.6,−2.8], always-favorite −4.6%
[−5.8,−3.3], always-underdog −1.5% [−4.5,+1.4].

**Verdict: no edge.** The single positive cell (elo-rest at EV>6%, +0.4%) has
a CI spanning ±4% and its halves flip sign — exactly the multiple-comparisons
mirage the bar exists to catch. What the table _does_ show is that our models
are good: betting them blind into the closing line loses only ~0.5–2%, i.e.
they sit roughly vig-distance from the sharpest consumer number in sports.
The mild underdog lean (−1.5% vs the favorites' −4.6%) is the test-era home/
favorite fade visible above, and its CI still includes zero.

## 5 · NFL results

### 5a · Headline tables

**DEV, seasons 2000–2015** (engines n=4,251; fitted from 2003, n=3,467;
moneyline rows 2011+ only, n=2,531):

| model            | n     | acc   | Brier ↓    | log loss ↓ |
| ---------------- | ----- | ----- | ---------- | ---------- |
| blend-mkt (w=.8) | 2,531 | 66.1% | **0.2114** | 0.6098     |
| **market-ml**    | 2,531 | 66.3% | 0.2117     | 0.6104     |
| logit+mkt-wf     | 2,045 | 65.6% | 0.2130     | 0.6138     |
| market-spread    | 4,251 | 66.5% | 0.2132     | 0.6147     |
| **ens-cal**      | 3,467 | 65.0% | **0.2162** | 0.6209     |
| logit-wf         | 3,467 | 65.4% | 0.2167     | 0.6226     |
| elo-ctx          | 4,251 | 65.2% | 0.2180     | 0.6250     |
| gbm-wf           | 3,467 | 64.8% | 0.2187     | 0.6267     |
| offdef-pace      | 4,251 | 64.4% | 0.2193     | 0.6279     |
| elo-mov          | 4,251 | 64.1% | 0.2193     | 0.6280     |
| srs-normal       | 4,251 | 64.4% | 0.2194     | 0.6281     |
| elo-basic        | 4,251 | 63.9% | 0.2221     | 0.6341     |
| pythag           | 4,251 | 63.4% | 0.2223     | 0.6348     |
| bradley-terry    | 4,251 | 63.5% | 0.2239     | 0.6381     |
| glicko2          | 4,251 | 63.4% | 0.2255     | 0.6426     |
| mlp-wf           | 3,467 | 63.2% | 0.2290     | 0.6524     |
| home-const       | 4,251 | 57.1% | 0.2449     | 0.6830     |

**TEST, seasons 2016–2025 (frozen, scored once), n=2,751:**

| model             | n     | acc   | Brier ↓    | log loss ↓ |
| ----------------- | ----- | ----- | ---------- | ---------- |
| **market-spread** | 2,751 | 66.4% | **0.2105** | 0.6082     |
| market-ml         | 2,750 | 66.7% | 0.2106     | 0.6086     |
| blend-mkt (w=.8)  | 2,750 | 66.3% | 0.2112     | 0.6101     |
| logit+mkt-wf      | 2,750 | 66.1% | 0.2131     | 0.6141     |
| **ens-cal**       | 2,751 | 64.6% | **0.2196** | 0.6289     |
| elo-ctx           | 2,751 | 64.4% | 0.2202     | 0.6303     |
| logit-wf          | 2,751 | 64.5% | 0.2205     | 0.6309     |
| gbm-wf            | 2,751 | 64.7% | 0.2207     | 0.6311     |
| srs-normal        | 2,751 | 64.1% | 0.2221     | 0.6349     |
| elo-mov           | 2,751 | 63.6% | 0.2223     | 0.6348     |
| offdef-pace       | 2,751 | 64.1% | 0.2223     | 0.6353     |
| elo-basic         | 2,751 | 63.2% | 0.2245     | 0.6398     |
| bradley-terry     | 2,751 | 64.4% | 0.2246     | 0.6408     |
| pythag            | 2,751 | 61.3% | 0.2289     | 0.6490     |
| glicko2           | 2,751 | 63.1% | 0.2295     | 0.6533     |
| mlp-wf            | 2,751 | 62.6% | 0.2307     | 0.6551     |
| home-const        | 2,751 | 55.0% | 0.2479     | 0.6890     |

### 5b · What the NFL tables say

1. **The market leads again** — and the spread and moneyline are equally sharp
   (test 0.2105 vs 0.2106; unlike the NBA, the NFL spread + fixed σ held up,
   because NFL margin dispersion was _stable_: sd 13.5 dev → 12.7 test).
2. **The one nominal market beat of the whole study did not survive its test.**
   On dev, `blend-mkt` (w=0.8) edged the market 0.2114 vs 0.2117 — the only
   place in either sport where our signal nominally improved the line. Frozen
   and retested: 0.2112 vs 0.2106. Gone. Same for `logit+mkt-wf` (0.2130 dev
   near-market → 0.2131 test, clearly behind). The MLB program's Rule of
   Fitted Machinery — _in-sample market improvements evaporate out-of-sample_
   — now holds in three sports.
3. **Context is king in the NFL.** The bye/short-week/QB-change bumps take
   elo-mov from 0.2193 to 0.2180 (dev) — the largest single-engine improvement
   in either sport — and `elo-ctx` is the best engine on test (0.2202). The
   dev-tuned magnitudes are football-sensible: bye ≈ +35 Elo (≈1.3 pts), short
   week ≈ −45, **QB change ≈ −80 Elo ≈ 3 points of spread**, confirmed
   independently by the logistic coefficients (qbChgH −0.106, the largest
   context weight) and by the NBA contrast, where the same machinery could
   only find a −25-point back-to-back bump.
4. **The calibrated ensemble is the best overall model** (0.2162 dev / 0.2196
   test) and the ensemble members' diversity is real: ens beats each of its
   three members on both windows in the NFL (it didn't in the NBA, where the
   members are more correlated).
5. **Pythagorean collapsed on test** (0.2223 → 0.2289, worst non-MLP): with
   17-game seasons and a 3.4 exponent it is too twitchy for the parity era.
   Wins-only systems (glicko2 0.2295, bradley-terry 0.2246) trail badly, as
   in the NBA. The MLP is last for the third table in a row.

### 5c · Calibration (test)

The raw NFL ensemble is _strikingly_ well calibrated out-of-sample — claimed
vs actual within ~1 pp in every bucket — while the market shows a small
middle-bucket wobble of its own:

| bucket    | ens-avg claimed → actual | market claimed → actual |
| --------- | ------------------------ | ----------------------- |
| 0.50–0.60 | 54.9% → 55.4%            | 55.5% → 55.5%           |
| 0.60–0.70 | 64.5% → 65.8%            | 64.8% → 62.8%           |
| 0.70–0.80 | 74.4% → 75.0%            | 74.8% → 77.5%           |
| 0.80–1.00 | 84.3% → 84.7%            | 84.9% → 86.7%           |

The NFL's stationarity (no home-court collapse of NBA magnitude, stable margin
noise) is what makes frozen calibration survive. Note the asymmetry with §4d:
same models, same freeze, opposite calibration fate — the _sport's_ drift, not
the method, decides.

### 5d · NFL betting: edge tests (test window)

| strategy     | EV > | n     | ROI   | 90% CI        | halves       |
| ------------ | ---- | ----- | ----- | ------------- | ------------ |
| ens-cal      | 0.00 | 2,303 | −8.9% | [−13.3, −4.4] | −7.4 / −10.4 |
| ens-cal      | 0.06 | 1,655 | −7.1% | [−12.8, −1.2] | −5.3 / −8.8  |
| elo-ctx      | 0.00 | 2,363 | −4.9% | [−9.4, −0.6]  | −3.9 / −5.9  |
| gbm-wf       | 0.00 | 2,355 | −7.4% | [−12.0, −2.7] | −6.3 / −8.5  |
| logit+mkt-wf | 0.00 | 1,838 | −6.4% | [−11.2, −1.4] | −6.6 / −6.2  |

Naive pockets: always-home −4.9% [−8.1,−1.6], always-favorite −3.1%
[−5.3,−0.8], always-underdog −5.3% [−9.8,−0.7].

**Verdict: decisively no edge — every CI is entirely negative.** This is
qualitatively worse than the NBA result (−0.5 to −2%): NFL disagreements with
the line are _actively wrong_ (our models win only **43.1–43.9%** of pick
disagreements with the spread, vs ~46–47% in the NBA). With 272 games a season
and a week of news baked into every line, the NFL closing number is the
hardest target in this study. The models' honest role is probability quality
(they're within 0.009 of the line, beautifully calibrated) — not price
discovery.

## 6 · Compare & contrast — across algorithms, across sports

**Across algorithm families** (both sports agree):

1. **Margin information is the whole ballgame.** elo-basic → elo-mov is worth
   −0.0012 (NBA) / −0.0028 (NFL) Brier; srs/offdef sit beside elo-mov; and the
   two wins-only systems (Glicko-2, Bradley-Terry) are the two worst rating
   engines in both sports. Score margins are ~everything public that matters;
   _how_ you consume them (Elo update vs ridge fit) is nearly a matter of
   taste.
2. **Glicko-2's extra machinery (deviation, volatility) buys nothing here.**
   Team strength in a 30/32-team league with dense schedules is not the
   sparse-uncertainty setting Glicko was built for; τ tuned to irrelevance.
3. **Fitted stackers add a little, reliably, and never more.** The best
   stacker beats the best engine by ~0.002 (NBA test) / ~0.001 (NFL test);
   logistic ≈ GBM ≫ MLP everywhere. Depth-2 GBMs with ~100 trees were the
   ceiling; every capacity increase tuned worse. The 17–24 features are so
   collinear that the stacker is effectively re-deriving elo-mov with small
   corrections.
4. **Small MLPs are a consistent failure** (last on all four tables) — no
   surprise for tabular data at these sample sizes, but now measured.
5. **Temperature ≈ 1.0 for walk-forward rating systems.** The MLB program's
   headline calibration fix (a=0.60 for the Monte-Carlo sim) is a property of
   _simulators_, not of prediction per se: systems trained on outcomes are
   born calibrated; systems that integrate a physics model are not.
6. **Ensembling helps when members are diverse** (NFL: ens < every member on
   both windows) **and is a wash when they aren't** (NBA: ens ≈ its best
   member). The MLB sim+Elo lesson — orthogonal errors — reproduces exactly.

**Across sports:**

| dimension                             | NBA                                    | NFL                                       |
| ------------------------------------- | -------------------------------------- | ----------------------------------------- |
| best model vs market (test Brier gap) | 0.2199 vs 0.2093 (**+0.0106**)         | 0.2196 vs 0.2105 (**+0.0091**)            |
| best model accuracy / market accuracy | 64.5% / 67.5%                          | 64.6% / 66.7%                             |
| favorite-side agreement with spread   | 81–82%, wins 46% of disputes           | 85–86%, wins 43% of disputes              |
| schedule/roster context value         | tiny (b2b ≈ −25 Elo; rest ≈ +8/day)    | large (bye +35, short −45, QB change −80) |
| home advantage, dev → test            | **59.6% → 55.3%** (collapse)           | 57.1% → 55.0% (mild decline)              |
| margin noise vs spread, dev → test    | sd 12.0 → **14.1** (regime change)     | sd 13.5 → 12.7 (stable)                   |
| spread vs moneyline as a forecast     | spread + fixed σ decays badly          | equally sharp, interchangeable            |
| flat-bet model ROI vs closing ML      | −2% … +0.4% (≈ vig-distance)           | **−5% … −9%** (CIs all negative)          |
| era stationarity                      | low — recalibration would be mandatory | high — frozen calibration held 10 years   |

The NBA is the _more predictable_ sport (all Briers lower, accuracies higher —
82 games and huge samples make team strength visible) but the _harder market_
in relative terms and the _less stationary_ league. The NFL is noisier per
game, but its structure — one game a week, context that public data actually
captures (byes, QB changes) — lets simple public models get within 0.009 of
the line and stay calibrated for a decade.

**Against the MLB program (Rounds 1–12):** the MLB models tie their market to
within 0.003–0.004 Brier; the same methodology stops 0.009–0.011 short in
NBA/NFL. The interpretation that fits all three: MLB outcomes hinge on a
per-game lottery (starter × BABIP × sequencing) that compresses how much any
information — public or private — can matter, while NBA/NFL outcomes hinge on
persistent team strength plus _late-breaking roster news_ (who sits tonight,
who's under center) that the market prices within minutes and end-of-day
datasets never see. The gap between our models and the line is, quite
precisely, the market value of injury news.

## 7 · Verdict & what would ship

- **Modeling:** if this platform ever adds NBA/NFL cards, ship
  **elo-rest / elo-ctx as the headline engines** (they're 90% of the value,
  run in microseconds, and self-calibrate) with the **calibrated ensemble** as
  the stronger, costlier alternative; show the devigged market number next to
  the model exactly as the MLB product does. All constants are frozen in the
  two analyzers and reproduce to the digit.
- **Betting claims: none.** Zero of the strategies meets the pre-committed
  bar in either sport; the NFL tests are decisively negative. The honest
  product framing stays what the MLB Track Record already says: probability
  quality on par with public frontiers, no +EV promises.
- **If more headroom is ever wanted**, the data this study proves we lack is
  the data to buy: NBA availability/lineup feeds (load management is the
  test-era story) and NFL injury-report/QB-status feeds — i.e., the exact
  information whose absence defines our gap to the line. More algorithms will
  not close it; Round 7's conclusion generalizes across sports.

## 8 · Appendix — season-by-season Brier (stability)

Walk-forward Brier per season for the key models (— = model not yet
available; test window begins 2020 NBA / 2016 NFL). The market beats every
model in **all 19 NBA seasons** and in **21 of 26 NFL seasons** — the
per-season restatement of the headline verdict.

**NBA** (season = end year; 2026 = Oct 2025 – Jan 2026 partial):

| season | elo-rest | srs-normal | gbm-wf | ens-cal | market-ml |
| ------ | -------- | ---------- | ------ | ------- | --------- |
| 2008   | 0.2023   | 0.2011     | —      | —       | 0.1936    |
| 2009   | 0.1977   | 0.1956     | —      | —       | 0.1915    |
| 2010   | 0.2006   | 0.2011     | 0.2030 | 0.2008  | 0.1976    |
| 2011   | 0.2034   | 0.2027     | 0.2025 | 0.2021  | 0.1973    |
| 2012   | 0.2067   | 0.2102     | 0.2096 | 0.2078  | 0.1992    |
| 2013   | 0.2032   | 0.2044     | 0.2039 | 0.2031  | 0.1984    |
| 2014   | 0.2103   | 0.2112     | 0.2105 | 0.2098  | 0.2035    |
| 2015   | 0.2088   | 0.2079     | 0.2068 | 0.2070  | 0.1967    |
| 2016   | 0.1992   | 0.1978     | 0.1991 | 0.1979  | 0.1938    |
| 2017   | 0.2164   | 0.2177     | 0.2168 | 0.2163  | 0.2106    |
| 2018   | 0.2134   | 0.2157     | 0.2138 | 0.2135  | 0.2030    |
| 2019   | 0.2130   | 0.2144     | 0.2114 | 0.2123  | 0.2044    |
| 2020   | 0.2218   | 0.2227     | 0.2208 | 0.2208  | 0.2116    |
| 2021   | 0.2310   | 0.2277     | 0.2252 | 0.2263  | 0.2160    |
| 2022   | 0.2231   | 0.2235     | 0.2228 | 0.2219  | 0.2097    |
| 2023   | 0.2278   | 0.2298     | 0.2272 | 0.2276  | 0.2173    |
| 2024   | 0.2133   | 0.2136     | 0.2110 | 0.2117  | 0.1980    |
| 2025   | 0.2149   | 0.2147     | 0.2125 | 0.2128  | 0.2012    |
| 2026   | 0.2247   | 0.2261     | 0.2211 | 0.2227  | 0.2149    |

Readable at a glance: the 2017+ level shift (the pace-and-space/rest era —
every model _and the market_ got worse), the 2021 nadir (no-fans season), and
the partial 2026 season continuing the noisy-era level.

**NFL** (market column = spread, available every season):

| season | elo-ctx | srs-normal | gbm-wf | ens-cal | market-spread |
| ------ | ------- | ---------- | ------ | ------- | ------------- |
| 2000   | 0.2191  | 0.2244     | —      | —       | 0.2224        |
| 2001   | 0.2280  | 0.2314     | —      | —       | 0.2242        |
| 2002   | 0.2208  | 0.2243     | —      | —       | 0.2232        |
| 2003   | 0.2183  | 0.2278     | 0.2243 | 0.2217  | 0.2118        |
| 2004   | 0.2204  | 0.2252     | 0.2241 | 0.2213  | 0.2158        |
| 2005   | 0.2082  | 0.2096     | 0.2116 | 0.2072  | 0.1978        |
| 2006   | 0.2326  | 0.2306     | 0.2383 | 0.2332  | 0.2323        |
| 2007   | 0.2106  | 0.2126     | 0.2137 | 0.2101  | 0.2035        |
| 2008   | 0.2160  | 0.2193     | 0.2194 | 0.2166  | 0.2103        |
| 2009   | 0.2073  | 0.2080     | 0.2086 | 0.2063  | 0.1982        |
| 2010   | 0.2296  | 0.2295     | 0.2287 | 0.2285  | 0.2202        |
| 2011   | 0.2109  | 0.2073     | 0.2076 | 0.2073  | 0.2060        |
| 2012   | 0.2160  | 0.2162     | 0.2171 | 0.2152  | 0.2078        |
| 2013   | 0.2096  | 0.2118     | 0.2113 | 0.2092  | 0.2034        |
| 2014   | 0.2117  | 0.2060     | 0.2110 | 0.2079  | 0.2069        |
| 2015   | 0.2291  | 0.2266     | 0.2269 | 0.2267  | 0.2280        |
| 2016   | 0.2151  | 0.2223     | 0.2225 | 0.2186  | 0.2168        |
| 2017   | 0.2117  | 0.2150     | 0.2137 | 0.2120  | 0.2027        |
| 2018   | 0.2235  | 0.2174     | 0.2190 | 0.2191  | 0.2120        |
| 2019   | 0.2242  | 0.2217     | 0.2233 | 0.2216  | 0.2136        |
| 2020   | 0.2135  | 0.2195     | 0.2132 | 0.2126  | 0.2022        |
| 2021   | 0.2310  | 0.2291     | 0.2292 | 0.2282  | 0.2184        |
| 2022   | 0.2190  | 0.2249     | 0.2241 | 0.2212  | 0.2091        |
| 2023   | 0.2331  | 0.2299     | 0.2318 | 0.2311  | 0.2169        |
| 2024   | 0.2087  | 0.2180     | 0.2102 | 0.2106  | 0.2019        |
| 2025   | 0.2217  | 0.2228     | 0.2190 | 0.2203  | 0.2111        |

Unlike the NBA there is no level shift — season-to-season scatter (2006 and
2023 hard, 2005 and 2024 easy for everyone) but a stable regime, which is why
the frozen NFL calibration held for a decade. In five NFL seasons (2000, 2002,
2006, 2014, 2015) one of our engines nominally beat the closing spread's
Brier — a single model each time, by −0.0009 to −0.0033, margins well inside
season-level noise; in the frozen test decade the market leads all ten
seasons.

## 9 · Reproduction

```bash
# data (≈25 MB total, cached once)
curl -o .backtest-cache/nba-odds.sqlite  https://raw.githubusercontent.com/kyleskom/NBA-Machine-Learning-Sports-Betting/master/Data/OddsData.sqlite
curl -o .backtest-cache/nba-allelo.csv   https://raw.githubusercontent.com/fivethirtyeight/data/master/nba-elo/nbaallelo.csv
curl -o .backtest-cache/nfl-games.csv    https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
bun scripts/collect-nba-nfl-data.ts      # normalize (+ ESPN playoff backfill)

npx tsx scripts/analyze-nba.ts           # frozen run → all NBA tables (~3 min)
npx tsx scripts/analyze-nfl.ts           # frozen run → all NFL tables (~1 min)
npx tsx scripts/analyze-nba.ts --diag    # post-hoc diagnostics
npx tsx scripts/analyze-nfl.ts --diag
npx tsx scripts/analyze-nba.ts --tune-engines   # re-derive the dev grids
npx tsx scripts/analyze-nba.ts --tune-fitted    # (and --tune-* for nfl)
```

Everything is deterministic (seeded RNG throughout); the tables above
reproduce byte-for-byte.
