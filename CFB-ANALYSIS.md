# College Football — Game Outcomes & Touchdown Scorers

**Question:** for a college football Saturday, who wins each game, and **which
one or two players** in each game are most likely to score a touchdown?

Two models answer that, both built here and both held out on seasons they were
never fitted on. All code is in [`research/cfb/`](research/cfb/); the live
versions are `src/lib/espn.server.ts` (outcomes) and
`src/lib/cfb-td.server.ts` (touchdowns).

---

## TL;DR

**Game outcomes** — margin-of-victory Elo, tuned for college.

| Metric | Model | Baseline | Read |
|---|---|---|---|
| **Accuracy** | **76.0%** | 67.4% (always take the home team) | +8.6 pts over the only baseline that needs no model |
| Accuracy, FBS vs FBS only | 71.5% | — | The easy FBS-over-FCS games flatter the headline; this is the honest subset |
| Log loss | 0.4793 | 0.6931 (coin flip) | |
| Brier | 0.1587 | 0.25 | |
| Calibration | a stated 85% wins 89% | — | Slightly *under*-confident, which is the safe direction |

Held out on 2025 and 2026-to-date: **1,143 games**, with K, home-field and
season-carry chosen on 2021–24 and never refitted.

**Touchdown scorers** — logistic regression on season usage, no betting lines.

| Metric | Result | Read |
|---|---|---|
| **Picks per game** | **1.46** | The model chooses one or two; it is not a fixed slot count |
| **Shown picks that scored** | **54.6%** | Against 49.5% for a fixed two-per-game board |
| **Games where a pick scored** | **65.6%** | Two in three cards had a hit |
| Lead pick | 56.3% | |
| Second pick, when shown | 51.1% | Nearly as good as a lead pick — which is the bar it has to clear |
| In two-pick games | 81.6% at least one, 30.9% both | |
| ROC AUC | 0.6918 | 0.6902 in 2025, 0.7015 in 2026 |
| Calibration | 43.0% predicted → 45.7% actual; 75.6% → 77.1% | Honest at both ends |

Held out on **1,130 games** across 2025 and 2026-to-date, fitted on 2021–24.

The live board agrees with the backtest where they can be compared directly: on
the 2026-09-19 slate it produced **1.31 picks a game**, against **1.33** for
September in the backtest. Picks per game is not a constant — it rises through
the season as usage accumulates (1.25 in August, 1.63 in November), and the live
board rises with it.

---

## 1. What college football does not give you

Three constraints shaped both models. Each was measured, not assumed.

### There are no historical betting lines

The NFL touchdown model leans on the book's implied team total, and it is one of
its strongest features. ESPN serves a `pickcenter` block for college games while
they are upcoming and **drops it once they are final**. Sampling 25 games each
from 2024-10-12, 2025-09-06 and 2025-10-18, the number that returned a total and
a spread was **zero**.

A market feature could therefore never be backtested here. Rather than ship a
feature whose only evidence is that it works in a different sport, game
environment is rebuilt from scoring history: `proj_team_pts` is this offence's
points per game averaged with this defence's points allowed, which is what a
total is estimating anyway.

This also means the **Best Odds** page needed a different market input. Even for
upcoming games the moneyline is frequently absent — when a team is favoured by
40 the book simply takes it down. On the 2026-09-19 slate, of 71 games **16 had
any line at all** and 14 of those had a usable moneyline. The spread survives
where the moneyline does not, so college market probabilities are read off the
spread through `P = Φ(−spread/σ)`, with σ **fitted rather than assumed**:
`research/cfb/spread_prob.py` searches it against six seasons and lands on
**σ = 12.0** (held-out log loss 0.4805, a stated 85% winning 88%). It puts a
3-point favourite at 60%, a touchdown favourite at 72% and a two-touchdown
favourite at 88% — where the college market actually prices them. A real
moneyline is still preferred when one exists; `fromSpread` travels with the
number so the page never implies the two are the same thing.

### There are no target counts

ESPN publishes no college target data at all. Every receiving share in this
model is a share of **catches**, not of looks. That is a genuinely weaker
signal — a receiver's target share is closer to intent, receptions are intent
plus outcome — and it is simply what the sport makes available.

### There are ~700 teams, and most of them should not have a rating

About a hundred games a season are an FBS team hosting an FCS one. Those
visitors never appear again. Giving each its own rating would hand the FBS team
a rating change off no information; so **every non-FBS team shares one pooled
rating**, and the model learns one honest thing instead — what beating an FCS
team is worth. 138 teams carry ratings of their own.

---

## 2. Game outcomes: Elo, tuned for college

The engine is the same margin-of-victory Elo the NFL and NBA pages run. Only
three constants differ, and they were grid-searched on 2021–24 by log loss:

| | K | Home field | Season carry |
|---|---|---|---|
| NFL | 20 | 55 | 0.50 |
| NBA | 8 | 80 | 0.75 |
| **College** | **40** | **55** | **0.60** |

K is double the NFL's because college teams play twelve games, not seventeen, so
each result has to carry more. Carry is *higher* than the NFL's, which is the
result that surprised me until it didn't: pro rosters are levelled by the draft
and the cap, college programs are not. Alabama is good next year because Alabama
was good this year.

K=40 is a real interior optimum, not a grid edge — 32 and 48 are both worse
(log loss 0.5388 and 0.5404 against 0.5382). The surface is flat near the top,
so the exact values matter less than being in the right neighbourhood.

**Held out on 2025–26** (settings fixed beforehand):

| Stated confidence | n | Predicted | Actual |
|---|---|---|---|
| 50–60% | 252 | 54.7% | 55.2% |
| 60–70% | 240 | 64.7% | 66.3% |
| 70–80% | 224 | 74.7% | 76.8% |
| 80–90% | 188 | 85.2% | 88.8% |
| 90–100% | 239 | 95.1% | 97.1% |

Every band is slightly under-confident — the model wins a little more often than
it claims. By season: 74.0% in 2025 (958 games), 86.5% in 2026 (185 games, all
early-season, when the FBS-vs-FCS mismatches are concentrated).

---

## 3. Touchdown scorers

### The rule the feature set obeys

**A feature is only allowed if the live board can compute the same number the
same way.** That is stricter than "no leakage", and it cost something real.

Pricing a 70-game Saturday means 142 teams. Rebuilding each one's usage from box
scores — what the NFL module does — is over a thousand requests by November and
a page that times out. ESPN's roster endpoint returns every player's
season-to-date rushing and receiving in **one call per team**, which is ~10
seconds for the whole slate. But it returns totals, not a game log, so two
features had to get cruder:

- **Per-game rates divide by the team's games, not the player's.** A player who
  missed two games is divided by his team's games here too.
- **`anytime_rate` counts touchdowns capped at one per team game**, rather than
  games-scored-in. It overstates a two-touchdown afternoon.

Both are now computed identically in training and in production. That matters
more than it sounds: measured on the players who actually get picked, fitting on
the clean version and serving the crude one was worth **0.13 of `anytime_rate`**
(0.47 against 0.60) — a 29% relative inflation on the model's single strongest
feature. Every number in this document would have described a model that never
runs.

Two further features — opponent rushing and receiving touchdowns allowed — were
dropped for the same reason, but only after checking the cost. Refitting without
them moves held-out AUC from 0.6919 to 0.6918 and leaves the board's hit rate
and picks-per-game unchanged to the decimal ([`ablate.py`](research/cfb/ablate.py)).
They are redundant with `proj_team_pts`, which already carries how many points
the opponent gives up. Paying a minute of page latency for the fourth decimal of
AUC is not a trade worth making.

### The model

L2 logistic regression on 16 standardized features, fitted on 71,461 player-game
rows from 2021–24. Standardized coefficients, largest first:

```
anytime_rate   +0.47     rec_td_rate    -0.13     rush_td_rate   -0.06
carry_share    -0.23     team_rush_tdpg -0.09     team_rec_tdpg  -0.04
rush_ypg       +0.23     rpg            -0.07     is_home        +0.04
rec_ypg        +0.20                              proj_total     +0.04
elo_margin     +0.19                              rec_share      +0.02
cpg            +0.16                              gp             -0.02
proj_team_pts  +0.13
```

Scoring history dominates, yardage and the Elo game-shape term follow. Several
coefficients are negative in ways that look wrong alone and are not —
`carry_share` and `cpg` are strongly collinear, and the pair reads as "volume
matters, but volume already counted once."

### Against the alternatives

Both held-out seasons, same fit, same features:

| Model | 2025 AUC | 2025 top-1 | 2026 AUC | 2026 top-1 |
|---|---|---|---|---|
| Rank by `anytime_rate` alone | 0.6592 | 54.6% | 0.6165 | 53.9% |
| Rank by carry share alone | 0.5912 | 49.5% | 0.5734 | 41.0% |
| **Logistic** | **0.6902** | **55.6%** | **0.7015** | **60.1%** |
| Logistic + Platt | 0.6900 | 55.8% | 0.7025 | 59.6% |
| Gradient boosting | 0.6987 | 56.7% | 0.7092 | 55.1% |

Gradient boosting wins on AUC in both seasons and **loses on the metric that
matters** — 56.7% against 55.6% in 2025, but 55.1% against 60.1% in 2026. AUC
ranks all 21,503 candidates; the board shows one or two names. Given a wash on
the thing being shipped, the model that can be read, explained and ported to
TypeScript in forty lines wins.

Platt scaling changed nothing worth having (AUC 0.6900 vs 0.6902) because the
raw model is already calibrated, so it was left out.

### How many picks a game gets

The board shows the lead pick always, and a second **only when the model gives
it at least 0.45**. That threshold is where the backtest says a second name
stops diluting the card:

| Second pick's own probability | Hit rate | Share of games |
|---|---|---|
| below 0.30 | 30.6% | 9% |
| 0.30–0.35 | 36.1% | 14% |
| 0.35–0.40 | 37.2% | 16% |
| 0.40–0.45 | 36.4% | 15% |
| **0.45–0.50** | **46.7%** | 17% |
| 0.50–0.55 | 52.5% | 12% |
| 0.55+ | 54.6% | 16% |

The step at 0.45 is a real one — ten points, and nothing below it separates at
all (36–37% across three consecutive bands). That is what makes it a threshold
rather than a round number someone liked.

It is stronger in 2025 than in 2026: second picks above the bar hit **52.2%**
across 464 games in 2025, and **42.1%** across 57 games in 2026. The 2026
sample is small and entirely early-season, when three games of usage is all
anyone has; September is where the board shows fewest second picks for exactly
that reason. Worth watching rather than worth re-tuning on 57 games.

A rule based on *closeness* to the lead pick was tested first and **does not
work**. Pick-2 hit rate by `p2/p1`: 35.8% below 0.70, then 44.2%, 45.8%, 38.3%,
48.2% — not monotonic and not usable. How close the second name is to the first
tells you nothing about whether it scores. Only its own probability does.

What that buys, against fixed boards:

| Board | Picks/game | Shown picks that scored |
|---|---|---|
| Always 1 | 1.00 | 56.3% |
| **Model chooses (1 or 2)** | **1.46** | **54.6%** |
| Always 2 | 2.00 | 49.5% |
| Always 3 | 3.00 | 46.4% |

Nearly half again as many picks as a one-pick board, at 5.1 points better
quality than a two-pick one. The lead-pick-only board is still the highest
quality per pick, and always will be — the question the count answers is how
much coverage is worth giving up for it.

### Tiers

Set where the held-out hit rate actually steps, and carried in the model file so
the page cannot quote a number that has drifted:

| Tier | Probability | Held-out hit | 2025 | 2026 | Share of picks |
|---|---|---|---|---|---|
| **Strong** | ≥ 0.62 | **68.8%** | 68.1% | 75.0% | 25% |
| **Solid** | 0.50–0.62 | 54.0% | 53.5% | 57.5% | 39% |
| **Lean** | < 0.50 | 45.7% | 45.2% | 47.8% | 36% |

Calibration across the shown picks:

| Predicted | n | Actual |
|---|---|---|
| 43.0% | 599 | 45.7% |
| 54.8% | 562 | 52.8% |
| 64.5% | 337 | 63.2% |
| 75.6% | 153 | 77.1% |

---

## 4. Two bugs worth recording

Both were found by running the finished code against a real Saturday, and
neither would have shown up as an error.

**`limit=1000` silently returns 25.** The scoreboard fetch had asked for
`limit=1000` since the NBA/NFL code was written. ESPN does not reject that — it
ignores the parameter and serves its default page of 25. For the NFL, where a
month holds 60 games, nothing was ever wrong. For college it was quietly fatal:
a 71-game Saturday came back as 25 games, and the Elo replay saw **304 games of
a season instead of 2,108**, so every rating on the page was wrong and the page
looked completely normal. `limit=500` is honoured; a warning now fires whenever
a response comes back full, because a truncated replay is wrong in a way that is
indistinguishable from a correct one.

**A total is not worth 500KB.** The touchdown board originally read each game's
over/under from the per-game summary endpoint — one ~500KB response per game, so
35MB and 37 seconds for a college Saturday, to display a number that is absent
for most college games anyway. The scoreboard response already carries it. Same
number, zero extra requests, 37s → 3s.

---

## 5. What this does not do

- **No anytime-touchdown market comparison.** There are no historical college
  props to compare against, so there is no claim here about beating a price.
  These are hit rates, not returns.
- **Rushing and receiving touchdowns only.** A punt return or an interception
  return is a touchdown to a sportsbook and is invisible here.
- **Past dates on the TD board are not point-in-time.** Season-to-date usage is
  "as of now", which for an upcoming game is exactly right — a team's season so
  far *is* everything before its next game — but for a slate already played it
  includes the games being projected. The page says so on those dates rather
  than showing a number that quietly knew the answer.
- **Week 1 leans on last season.** A team with fewer than five games borrows the
  shortfall from last year, scaled down and shrinking weekly until it is gone by
  Week 5. Roster turnover makes that weaker evidence in college than in the NFL.
- **The Track Record page starts empty.** It reads the forward ledger — rows
  written the morning of a game and scored afterwards — like every other sport.
  Everything in this document is a *backtest*, which is a different claim, and
  the two are deliberately not shown in the same place.

---

## 6. Reproducing it

```bash
cd research/cfb
python3 fetch_espn.py       # ~6,000 games, 2021-2026, from the public ESPN API
python3 elo_backtest.py     # grid-search K/HFA/carry, hold out 2025-26
python3 features.py         # point-in-time feature table
python3 bakeoff.py          # logistic vs baselines vs gradient boosting
python3 ablate.py           # what the expensive features actually buy
python3 selection.py        # where the second pick's bar belongs
python3 spread_prob.py      # fit the spread-to-probability sigma
python3 final.py            # definitive metrics + export src/lib/cfb-td-model.json
```

`final.py` writes three feature vectors and their probabilities into the model
file. `bun scripts/test-cfb-td.ts` replays them through the TypeScript port and
fails if the two disagree — a mis-ordered coefficient still produces a
plausible-looking probability, so this is what catches it. It currently agrees
to 5.6e-17.
