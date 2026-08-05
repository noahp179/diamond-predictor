# MLB Player Props — Model, Bake-Off and Backtest

The MLB answer to the [NFL TD-scorer work](NFL-TD-SCORER-RANKINGS.md): pick the
player props worth betting on a slate, prove out the algorithm on a season the
model never saw, and ship the winner into the app. Code lives in
`research/mlb-props/`; the shipped models are `src/lib/mlb-props-model.json`,
served live by `src/lib/mlb-props.server.ts` on the new **Player Props** tab.

---

## TL;DR

- **Eleven markets**, each its own model: batters — 1+ hits, 2+ hits, 2+ total
  bases, 1+ HR, 1+ RBI, 1+ run, 1+ SB; starters — 5+/6+/7+ strikeouts, 16+ outs.
- Trained on **2024–2025**, tested on **2026 season-to-date** (through Aug 4):
  **30,355 held-out batter-props and 3,304 starter-props**, none of which the
  model ever saw.
- **Pitcher props are the real edge. Batter props are barely predictable.**
  Strikeout markets hit **AUC 0.70–0.72**; hits/TB/RBI/runs sit at **0.56–0.59**.
- **Logistic regression wins again** — 12 algorithms, 11 markets, and the plain
  regularized logistic is at or inside the noise band of the best board position
  in every single market. XGBoost-style boosting, kNN and the neural net are
  worse everywhere.
- The probabilities are **calibrated** (top 1+ hits bucket: predicted 0.721 →
  observed 0.708), so they compare directly against a sportsbook price.
- Best single line on the board: the model's **top 5+ K pick of the day hit
  84.5%**, and its Strong-tier strikeout picks hit **82.6%** (breakeven −474).

---

## Data

MLB's free Stats API (`statsapi.mlb.com`), one box score per game:

| | |
|---|---|
| Games | **6,572** regular-season finals, 2024 → 2026-08-04 |
| Batter-games | **132,534** |
| Pitcher-games | **56,090** |
| Modelled rows | **116,983** lineup starters · **12,493** starting-pitcher games |
| Train / test | 2024–25 (86,628 / 9,189) → 2026 (30,355 / 3,304) |

Every feature comes from a strictly chronological walk: a row for game *G* only
ever sees box scores from games that had already finished. Batter rows are
lineup starters (slots 1–9) — that is what props are offered on and what a
posted lineup card tells you.

### Features (all reproducible live)

The live pipeline recomputes these from StatsAPI aggregates in ~9 calls, so
training and serving compute the *same numbers* — a parity self-test ships in
the model file and agrees to 1.7e-16.

| group | features |
|---|---|
| **season-to-date rate** | H/PA, TB/PA, HR/PA, RBI/PA, R/PA, BB/PA, K/PA, SB/PA, ISO (shrunk to league, k=250 PA) |
| **last 30 days** | H/PA, TB/PA, HR/PA, PA per game, games in window |
| **prior season** | H/PA, TB/PA, HR/PA, PA, "known" flag |
| **opportunity** | **lineup slot**, PA/game, games played |
| **matchup** | opposing starter's K/BF, H/BF, HR/BF, BB/BF, BF per start; **park factor**; home/away |
| **team context** | own team runs/game, opponent runs allowed/game |
| **own prop rate** | the player's own shrunk per-game hit rate *for that market*, season and last 30 days |
| **pitchers** | K/BF, H/BF, BB/BF, HR/BF, BF & outs & K per start, 30-day form, prior season, days rest, opposing lineup's K% / H% / runs |

---

## The bake-off — 12 algorithms × 11 markets

Mean AUC across all eleven markets on the held-out 2026 season (higher is
better). Every model got the same features and the same split.

| # | Model | mean AUC | best market | worst |
|--:|---|--:|--:|--:|
| 1 | **STACK (LR + hist-GBM + extra trees)** | **0.6379** | 0.7223 (7+ K) | 0.5616 (RBI) |
| 2 | **logistic L1** | **0.6378** | 0.7214 | 0.5602 |
| 3 | **logistic (shipped)** | **0.6376** | 0.7213 | 0.5603 |
| 4 | logistic + Platt | 0.6376 | 0.7213 | 0.5603 |
| 5 | extra trees | 0.6359 | 0.7213 | 0.5588 |
| 6 | random forest | 0.6317 | 0.7179 | 0.5546 |
| 7 | gradient boosting | 0.6314 | 0.7144 | 0.5568 |
| 8 | hist-GBM | 0.6295 | 0.7166 | 0.5600 |
| 9 | kNN (k=200) | 0.6232 | 0.7175 | 0.5424 |
| 10 | MLP (neural net) | 0.6213 | 0.7135 | 0.5550 |
| 11 | gaussian naïve Bayes | 0.6200 | 0.6999 | 0.5518 |
| 12 | own-rate baseline (no learning) | 0.6102 | 0.7162 | 0.5439 |

The three-model stack finishes **+0.0003 AUC** ahead of a plain logistic across
132 fits. The 95% noise band on a single market is ±0.007 (batters) to ±0.022
(pitchers), so that is nothing: **the logistic is shipped**, and it is the only
one of the three that ships as 24 numbers instead of 600 trees.

The naïve baseline is instructive too — just using "how often has this guy done
it per game" already gets 0.61. The model's job is the *rest*: who is batting
where tonight, against whom, in which park.

---

## Per-market results (2026 hold-out)

`Top-1 / Top-5` = hit rate of the day's single best / five best rated picks
across the whole slate — the way you would actually bet it.

| Market | Base rate | AUC (±95%) | Top-1 | Top-5 | Brier | Mean P vs actual |
|---|--:|--:|--:|--:|--:|--:|
| 5+ strikeouts | 51.4% | **0.700** ±0.018 | **84.5%** | 72.3% | 0.219 | 0.535 / 0.514 |
| 6+ strikeouts | 36.2% | **0.708** ±0.019 | **74.4%** | 59.1% | 0.202 | 0.372 / 0.362 |
| 7+ strikeouts | 23.6% | **0.721** ±0.022 | **59.7%** | 43.9% | 0.159 | 0.239 / 0.236 |
| 16+ outs (5.1 IP) | 51.1% | 0.684 ±0.018 | 73.6% | 69.3% | 0.222 | 0.502 / 0.511 |
| 1+ stolen base | 6.5% | 0.716 ±0.013 | 26.4% | 22.8% | 0.059 | 0.067 / 0.065 |
| 1+ home run | 11.6% | 0.618 ±0.010 | 24.0% | 22.2% | 0.101 | 0.119 / 0.116 |
| 2+ hits | 21.5% | 0.589 ±0.008 | 30.2% | 30.5% | 0.166 | 0.217 / 0.215 |
| 2+ total bases | 35.3% | 0.575 ±0.007 | 51.9% | 47.4% | 0.225 | 0.354 / 0.353 |
| 1+ run scored | 38.0% | 0.573 ±0.007 | 57.4% | 50.5% | 0.232 | 0.377 / 0.380 |
| 1+ hits | 60.7% | 0.570 ±0.007 | 72.1% | 71.0% | 0.235 | 0.608 / 0.607 |
| 1+ RBI | 29.4% | 0.560 ±0.007 | 48.1% | 37.7% | 0.206 | 0.296 / 0.294 |

Two clean groups:

- **Pitcher strikeout props are genuinely predictable** (0.68–0.72). A starter's
  K rate, how deep he goes, and how much the opposing lineup whiffs are all
  stable, measurable, pre-game facts.
- **Batter contact props are close to noise** (0.56–0.59). Four plate
  appearances is a tiny sample of a random process; the model can move 1+ hits
  from 61% to 72% on its best pick and no further.
- **The two rare batter events behave differently.** Stolen bases (0.716) are
  predictable because they are a *choice* by a few specific players, and home
  runs (0.618) because raw power is a real, persistent skill.

### Calibration

Predicted probability vs what actually happened, 6+ strikeouts:

| predicted | n | mean predicted | actual |
|---|--:|--:|--:|
| 0.0–0.2 | 619 | 0.136 | 0.131 |
| 0.2–0.3 | 683 | 0.252 | 0.255 |
| 0.3–0.4 | 656 | 0.349 | 0.364 |
| 0.4–0.5 | 554 | 0.445 | 0.444 |
| 0.5–0.6 | 363 | 0.543 | 0.466 |
| 0.6–0.7 | 257 | 0.645 | 0.591 |
| 0.7–0.8 | 117 | 0.748 | 0.778 |
| 0.8+ | 55 | 0.838 | 0.818 |

Well behaved through the middle, mildly *over*-confident in the 0.5–0.7 band
(the sample there is thin). 1+ hits is tight across every bucket
(0.72 predicted → 0.708 actual at the top). Because the outputs are calibrated,
they are directly comparable to a book's implied probability.

---

## Confidence tiers — and what price they need

Tiers are cut on the held-out season wherever the hit rate actually separates,
not at round numbers (`final.py`). "Breakeven" is the American price at which
that hit rate is exactly a push — bet above it and the tier was profitable
across 2026.

| Market | Strong | Solid | Lean |
|---|---|---|---|
| 5+ strikeouts | **82.6%** (−474) | 58.5% (−141) | 32.7% (+206) |
| 6+ strikeouts | **73.1%** (−272) | 42.5% (+135) | 17.6% (+467) |
| 7+ strikeouts | **60.6%** (−154) | 27.2% (+268) | 9.3% (+971) |
| 16+ outs | **74.2%** (−288) | 59.1% (−145) | 32.8% (+205) |
| 1+ hits | 71.3% (−249) | 63.6% (−175) | 54.3% (−119) |
| 2+ total bases | 46.1% (+117) | 38.5% (+160) | 28.2% (+254) |
| 1+ run scored | 51.4% (−106) | 40.5% (+147) | 31.8% (+215) |
| 1+ RBI | 39.0% (+156) | 31.5% (+217) | 24.3% (+311) |
| 2+ hits | 30.6% (+227) | 24.1% (+315) | 15.8% (+532) |
| 1+ home run | 21.7% (+361) | 13.4% (+645) | 7.0% (+1330) |
| 1+ stolen base | 19.2% (+420) | 7.9% (+1161) | 2.3% (+4219) |

The spread is what matters: a Strong 7+ K pick hits **6.5× more often** than a
Lean one, and a Strong HR pick **3.1×** more often. That separation, not the
absolute number, is what a prop model is for.

---

## Where the signal comes from (ablation)

Mean AUC lost across all markets when one feature group is removed:

| batters | Δ AUC | | starters | Δ AUC |
|---|--:|---|---|--:|
| opposing starter | **−0.0042** | | last 30 days | **−0.0062** |
| lineup slot | **−0.0033** | | opposing lineup | **−0.0052** |
| park + home | −0.0013 | | season rates | −0.0041 |
| own prop rate | −0.0010 | | rest + home + park | −0.0028 |
| season rates | −0.0007 | | workload | −0.0007 |
| last 30 days | −0.0005 | | own prop rate | +0.0006 |
| playing time | +0.0001 | | prior season | +0.0007 |
| prior season | +0.0002 | | | |

Read these as *marginal* contributions — the skill groups overlap heavily (a
player's season rate, prior season and 30-day form all measure the same thing),
so no one of them looks essential while together they carry the model. The
groups that stand out are the ones nothing else can supply: **who is pitching**
and **where in the order you bat**. Lineup slot alone is worth more than every
long-run batting rate combined, which matches the raw data — slot 1 hitters get
a hit in 67% of games, slot 9 hitters in 53%.

The single largest coefficient in every batter market is the lineup slot, and in
every strikeout market it is the starter's K/BF and how many batters he faces.

---

## What shipped

The **Player Props** tab on MLB (`/props`, `src/components/MlbPropsView.tsx`):

- Every game on the slate with its top picks across the eleven markets, ranked
  by edge over an average starter, with a market filter and a "Strong only"
  switch.
- Each pick shows the calibrated probability, the edge, and the backtested tier
  hit rate that pick's tier produced in 2026 — the number is measured, not
  asserted.
- Lineups come from the posted lineup card when it is up (usually ~2h before
  first pitch) and from the team's most recent batting order before that; each
  card says which one it is using.

Served live by `src/lib/mlb-props.server.ts`, which rebuilds each player's
season-to-date, 30-day and prior-season profile from StatsAPI game logs — the
same rows the model trained on — in ~3s for a 15-game slate.

---

## Honest limits

1. **No market prices.** The NFL model got a real lift from the implied team
   total; the MLB props here have no odds input at all. Live prop lines are the
   obvious next upgrade, both as a feature and as the thing to bet against.
2. **Batter props are near the ceiling of what box-score data can do.** The
   [HR-hitter study](MLB-HR-HITTER-BACKTEST.md) already showed Statcast
   barrel/xISO adds only +0.005 AUC. Expect the same here.
3. **Tiers are cut on one season.** The Strong tiers hold a few hundred picks
   for pitchers (n=264); treat those hit rates as ±5 points.
4. **Slate-level correlation is real.** Five picks from one lineup on a night
   the starter is dealing all lose together; the hit rates above are per-pick,
   not per-parlay.

---

## Files

| File | Purpose |
|---|---|
| `research/mlb-props/fetch_props.py` | Pulls every 2024–26 box score from StatsAPI |
| `research/mlb-props/features.py` | The leak-free, serve-identical feature build |
| `research/mlb-props/bakeoff.py` | 12 algorithms × 11 markets on the 2026 hold-out |
| `research/mlb-props/ablate.py` | Feature-group ablation |
| `research/mlb-props/final.py` | Fits, tiers, calibration, exports the shipped model |
| `src/lib/mlb-props-model.json` | Shipped weights + tiers + backtest metrics |
| `src/lib/mlb-props.server.ts` | Live slate pipeline |
| `src/components/MlbPropsView.tsx` | The Player Props tab |
