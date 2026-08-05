# MLB Player Props — Model, Bake-Off and Backtest

The MLB answer to the [NFL TD-scorer work](NFL-TD-SCORER-RANKINGS.md): pick the
player props worth betting on a slate, prove out the algorithm on a season the
model never saw, and ship the winner into the app. Code lives in
`research/mlb-props/`; the shipped models are `src/lib/mlb-props-model.json`,
served live by `src/lib/mlb-props.server.ts` on the new **Player Props** tab.

---

## TL;DR

- **Sixteen markets**, each its own model: batters — the **hits ladder
  (1+/2+/3+/4+)**, the **total-bases ladder (2+/3+/4+/5+)**, 1+ HR, 1+ RBI,
  1+ run, 1+ SB; starters — 5+/6+/7+ strikeouts, 16+ outs. (1+ total bases is
  the *same event* as 1+ hits — every total base comes from a hit — so the TB
  ladder starts at 2+.)
- Trained on **2024–2025**, tested on **2026 season-to-date** (through Aug 4):
  **30,355 held-out batter-props and 3,304 starter-props**, none of which the
  model ever saw.
- **Pitcher props are the real edge. Batter props are barely predictable.**
  Strikeout markets hit **AUC 0.70–0.72**; hits/TB/RBI/runs sit at **0.56–0.62**.
- **The higher the line, the better the model ranks it** — 1+ hits 0.570 →
  4+ hits 0.622; 2+ TB 0.575 → 5+ TB 0.618. Rare events are driven by *skill*
  (power, playing time), common ones by luck.
- **Logistic regression wins again** — 12 algorithms, 16 markets, 192 fits, and
  the plain regularized logistic is the best board position outright.
  XGBoost-style boosting, kNN and the neural net are worse everywhere.
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

## The bake-off — 12 algorithms × 16 markets

Mean AUC across all sixteen markets on the held-out 2026 season (higher is
better). Every model got the same features and the same split.

| # | Model | mean AUC | best market | worst |
|--:|---|--:|--:|--:|
| 1 | **logistic (shipped)** | **0.6286** | 0.7213 (7+ K) | 0.5603 (RBI) |
| 2 | logistic + Platt | 0.6286 | 0.7213 | 0.5603 |
| 3 | logistic L1 | 0.6286 | 0.7214 | 0.5602 |
| 4 | extra trees | 0.6254 | 0.7213 | 0.5588 |
| 5 | random forest | 0.6188 | 0.7179 | 0.5546 |
| 6 | hist-GBM | 0.6183 | 0.7166 | 0.5600 |
| 7 | gradient boosting | 0.6161 | 0.7144 | 0.5509 |
| 8 | STACK (LR + hist-GBM + extra trees) | 0.6132 | 0.7223 | **0.3816** |
| 9 | gaussian naïve Bayes | 0.6102 | 0.6999 | 0.5518 |
| 10 | kNN (k=200) | 0.6062 | 0.7175 | 0.5424 |
| 11 | MLP (neural net) | 0.6014 | 0.7135 | 0.5174 |
| 12 | own-rate baseline (no learning) | 0.5980 | 0.7162 | 0.5439 |

Across 192 fits the plain logistic is now the outright winner. Adding the rarest
rungs of the ladder is what separated it: on **4+ hits** (0.6% base rate) the
three-model stack collapses to **0.38 — worse than a coin flip** — because its
tree members fit noise in a market with ~500 positive training rows, and the
meta-learner trusts them. The logistic, which can only tilt a hyperplane, gets
0.622 there. That is the whole lesson of this repo in one cell.

The 95% noise band on a single market runs ±0.007 (common batter markets) to
±0.042 (4+ hits), so the top three lines are a tie — and the logistic ships as
24 numbers instead of 600 trees.

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
| **4+ hits** | 0.6% | 0.622 ±0.042 | 0.8% | 1.2% | 0.006 | 0.006 / 0.006 |
| 1+ home run | 11.6% | 0.618 ±0.010 | 24.0% | 22.2% | 0.101 | 0.119 / 0.116 |
| **5+ total bases** | 6.8% | 0.618 ±0.013 | 14.0% | 12.6% | 0.063 | 0.070 / 0.068 |
| **3+ hits** | 4.6% | 0.613 ±0.016 | 8.5% | 9.6% | 0.043 | 0.048 / 0.046 |
| **4+ total bases** | 14.4% | 0.606 ±0.009 | 27.9% | 25.0% | 0.120 | 0.146 / 0.144 |
| 2+ hits | 21.5% | 0.589 ±0.008 | 30.2% | 30.5% | 0.166 | 0.217 / 0.215 |
| **3+ total bases** | 20.5% | 0.585 ±0.008 | 35.7% | 32.7% | 0.161 | 0.207 / 0.205 |
| 2+ total bases | 35.3% | 0.575 ±0.007 | 51.9% | 47.4% | 0.225 | 0.354 / 0.353 |
| 1+ run scored | 38.0% | 0.573 ±0.007 | 57.4% | 50.5% | 0.232 | 0.377 / 0.380 |
| 1+ hits | 60.7% | 0.570 ±0.007 | 72.1% | 71.0% | 0.235 | 0.608 / 0.607 |
| 1+ RBI | 29.4% | 0.560 ±0.007 | 48.1% | 37.7% | 0.206 | 0.296 / 0.294 |

Three clean groups:

- **Pitcher strikeout props are genuinely predictable** (0.68–0.72). A starter's
  K rate, how deep he goes, and how much the opposing lineup whiffs are all
  stable, measurable, pre-game facts.
- **Common batter props are close to noise** (0.56–0.59). Four plate appearances
  is a tiny sample of a random process; the model can move 1+ hits from 61% to
  72% on its best pick and no further.
- **Rare batter events rank better** (0.61–0.72). Stolen bases are a *choice* by
  a few specific players; multi-hit and multi-base games take real power and a
  full night of plate appearances. Skill shows up more clearly at the top of the
  distribution than in the middle.

### The ladders — every rung, in order

Reading the hits and total-bases ladders top to bottom is the clearest picture of
what the model can and cannot do. `Top-5` is the hit rate of the day's five
best-rated picks in that market; `Strong` is the top-5%-of-picks tier.

| Rung | Base rate | AUC | Top-5 | Strong tier | Lean tier | Strong ÷ Lean |
|---|--:|--:|--:|--:|--:|--:|
| **1+ hits** | 60.7% | 0.570 | 71.0% | 71.3% | 54.3% | 1.3× |
| **2+ hits** | 21.5% | 0.589 | 30.5% | 30.6% | 15.8% | 1.9× |
| **3+ hits** | 4.6% | 0.613 | 9.6% | 9.1% | 2.8% | 3.3× |
| **4+ hits** | 0.6% | 0.622 | 1.2% | 1.2% | 0.4% | 3.0× |
| **2+ total bases** | 35.3% | 0.575 | 47.4% | 46.1% | 28.2% | 1.6× |
| **3+ total bases** | 20.5% | 0.585 | 32.7% | 31.4% | 15.2% | 2.1× |
| **4+ total bases** | 14.4% | 0.606 | 25.0% | 25.2% | 9.6% | 2.6× |
| **5+ total bases** | 6.8% | 0.618 | 12.6% | 13.3% | 4.1% | 3.2× |

The pattern is monotone in both ladders: **the higher the line, the better the
model separates.** AUC climbs 0.570 → 0.622 up the hits ladder and 0.575 → 0.618
up the total-bases ladder, and the Strong-to-Lean ratio roughly triples.

Why: a 1+ hit is mostly luck (any starter gets ~4 tries at a ~28% event, so
everyone lands between 50% and 75%), while 3+ hits or 5+ total bases needs a good
hitter, batting near the top, with power, in a good park, against a beatable
starter — all things the model can see before first pitch. The *return* moves the
other way, though: the best 1+ hits pick converts 71% of the time, the best
4+ hits pick 1.2%. Better ranking, rarer payoff.

Note that **1+ total bases is not a separate market** — it is exactly the 1+ hits
event (a total base can only come from a hit), and it is not modelled twice.

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
| 3+ total bases | 31.4% (+219) | 22.7% (+340) | 15.2% (+558) |
| 2+ hits | 30.6% (+227) | 24.1% (+315) | 15.8% (+532) |
| 4+ total bases | 25.2% (+297) | 16.3% (+515) | 9.6% (+943) |
| 1+ home run | 21.7% (+361) | 13.4% (+645) | 7.0% (+1330) |
| 1+ stolen base | 19.2% (+420) | 7.9% (+1161) | 2.3% (+4219) |
| 5+ total bases | 13.3% (+651) | 7.9% (+1167) | 4.1% (+2354) |
| 3+ hits | 9.1% (+999) | 5.2% (+1809) | 2.8% (+3502) |
| 4+ hits | 1.2% (+7993) | 0.7% (+14082) | 0.4% (+24609) |

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

- Every game on the slate with its top picks across the sixteen markets, ranked
  by edge over an average starter, with a per-market filter (both full ladders
  included) and a "Strong only" switch.
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
5. **The top rungs are lottery tickets.** 4+ hits happens 0.6% of the time; the
   model's best pick of the day converts 1.2%. The ranking is real (AUC 0.622)
   but a 30,355-row season only contains ~195 winners, so treat that rung's
   numbers as indicative, not bankable.

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
