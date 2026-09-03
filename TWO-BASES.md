# 2+ Total Bases — a model for one market, in plain English

A single is one base. A double is two, a triple three, a home run four. "Two or
more total bases" therefore means a double, a home run, or two hits in the same
game — and it is the prop most often on the board.

The [Player Props](MLB-PROPS-BACKTEST.md) model already prices it as one of
sixteen markets from thirty-four features. This is the same question asked on
its own: given only the data this repo already downloads, what else moves the
needle, and can the answer be explained to somebody who does not want to read a
coefficient table?

Code lives in `research/mlb-tb2/`; the shipped model is
`src/lib/mlb-tb2-model.json`, served live by `src/lib/mlb-tb2.server.ts` on the
new **2+ Bases** tab.

---

## TL;DR

- **Seven new feature blocks were tried. Three survived.** The park's index for
  *total bases* (not runs), the opponent's bases allowed per batter faced, and a
  15-day form window. Everything else — the bullpen, the umpire, the platoon
  split, rest days — was worth nothing or less than nothing.
- **The result: AUC 0.5758 against the shipped model's 0.5744**, +0.0014 with a
  95% bootstrap band of [+0.0003, +0.0026]. Small, and real.
- **What actually improved is the top of the board.** The day's single best pick
  goes from **51.0% to 52.9%**, and the best three from **48.0% to 50.5%**.
- **Half of the available gain was thrown away on purpose.** Weather was the
  strongest block in the bake-off (+0.0014 on its own). StatsAPI publishes a
  game's weather only *after* first pitch — it is `{}` for every scheduled game
  — so a board rendered in the morning cannot compute it. Backtesting on it
  would have been quoting a number the app can never produce.
- **Batting order matters more than the bat.** The biggest coefficient in the
  model, by a factor of two, is where a hitter is in the lineup. Across the
  held-out season the spread from the best hitters to the worst is about 20
  points of hit rate; the spread from batting first to batting ninth is bigger.
- **Every projection ships with its reason.** The page says "47% — helps: bats
  1st; hurts: the starter strikes out 23% of hitters", generated from the
  model's own arithmetic rather than written over the top of it.

---

## What the model is

A logistic regression on 43 features, fitted on 2024–25 and tested on the 2026
season it never saw: **86,868 training rows, 37,303 held-out rows**, one per
lineup starter per game. Probabilities are Platt-calibrated, so a 40% means 40%.

The features are the shipped prop model's thirty-four — the hitter's season,
30-day and prior-season rates, his lineup slot and plate appearances, the
opposing starter, park and team context — plus the three blocks below.

| block | features | why |
|---|---|---|
| **park index** | `park_tb` | The existing park factor is built for *runs*. Doubles and triples move with the park far more than runs do, so this is a separate index built from total bases per plate appearance at each venue: Coors 1.12, Sutter Health Park 1.07, T-Mobile 0.94. |
| **opponent** | `def_tb_pa`, `def_xbh_pa`, `def_known` | The whole pitching staff and the defence behind it, as bases and extra-base hits allowed per batter faced. The shipped model only sees the opponent's *runs* allowed and the starter. |
| **two-week form** | `w15_tb_pa`, `w15_h_pa`, `w15_pa_pg`, `w15_g`, `own15_tb2` | A 15-day window beside the existing 30-day one, for hitters who got hot last week. |

Every one is built by the same strictly chronological walk the rest of the repo
uses — a row for game *G* only sees games that finished before *G* — and every
index is shrunk to the league average, so a park with 200 plate appearances
behind it cannot swing a projection.

---

## The bake-off — what was tried and what failed

Each block added to the shipped thirty-four, one at a time, on the 2026
hold-out. The band is a 95% bootstrap on the delta, which is the only way to
tell a finding from a rounding error at this scale.

| block | cols | AUC | delta vs shipped | 95% band | verdict |
|---|--:|--:|--:|---|---|
| **weather** | 6 | 0.5758 | **+0.0014** | [+0.0003, +0.0027] | best block — **and unservable** |
| **park index** | 1 | 0.5755 | **+0.0011** | [+0.0001, +0.0020] | kept |
| **opponent** | 3 | 0.5749 | **+0.0005** | [+0.0001, +0.0010] | kept |
| two-week form | 5 | 0.5746 | +0.0002 | [−0.0001, +0.0005] | kept (helps in combination) |
| rest days | 2 | 0.5744 | −0.0000 | [−0.0002, +0.0002] | dropped |
| umpire index | 1 | 0.5742 | −0.0002 | [−0.0004, +0.0000] | dropped |
| **bullpen** | 5 | 0.5742 | −0.0002 | [−0.0008, +0.0005] | dropped |
| platoon split | 9 | 0.5738 | −0.0006 | [−0.0011, −0.0000] | dropped |
| *everything* | 32 | 0.5761 | +0.0017 | [−0.0000, +0.0036] | worse than the greedy subset |

Three of these are worth dwelling on.

**The bullpen was the best idea and it did nothing.** A starter is about fifteen
of twenty-seven outs, so roughly two of a hitter's four plate appearances come
against relievers the shipped model cannot see at all. Adding the opposing
bullpen's ERA, strikeout rate, hit rate and home-run rate moved AUC by −0.0002.
The most plausible reading is that bullpen quality is already priced in by the
opponent's runs-allowed feature, and that which relievers actually appear is
decided by the game state rather than by anything knowable at noon.

**The platoon split actively hurts** (−0.0006, band excluding zero). That
replicates [EDGE-HUNT.md](EDGE-HUNT.md), which found the same thing across all
twelve batter markets. Handedness is the first thing anybody reaches for and it
is the one block here that is measurably worse than nothing.

**The umpire index does nothing.** Home-plate umpires do differ — the index runs
0.94 to 1.07 across 99 umpires — but the differences are small next to the noise
in one hitter's four plate appearances.

### Greedy forward selection

Adding whichever block helps most, then repeating:

```
+ weather   -> 0.5758   (unservable, see below)
+ park      -> 0.5766
+ opponent  -> 0.5770
+ form15    -> 0.5772
+ rest      -> 0.5772   (no gain; dropped)
  stop: umpire, bullpen and platoon all make it worse
```

### Twelve algorithms

On the winning feature set, the plain logistic wins again — the fourth time in
this repo:

| model | AUC | Brier | top-1 |
|---|--:|--:|--:|
| **logistic (shipped)** | **0.5772** | 0.2239 | 0.490 |
| logistic C=0.1 | 0.5772 | 0.2239 | 0.490 |
| logistic L1 | 0.5771 | 0.2239 | 0.497 |
| hist-GBM | 0.5724 | 0.2248 | 0.541 |
| extra trees | 0.5721 | 0.2348 | 0.503 |
| random forest | 0.5700 | 0.2590 | 0.522 |
| gradient boosting | 0.5680 | 0.2264 | 0.478 |
| gaussian naïve Bayes | 0.5641 | 0.2258 | 0.465 |
| kNN (k=200) | 0.5618 | 0.2255 | 0.484 |
| MLP (neural net) | 0.5576 | 0.2285 | 0.452 |

---

## The weather problem

Weather was the single best block: temperature, wind speed and direction, and
the roof, together worth +0.0014. It is not in the shipped model.

The reason is not statistical. `game_context.csv` gets weather from the game
feed, and MLB only populates that object once a game is under way. For a
scheduled game the API returns:

```json
"weather": {}
```

Every game on today's board, checked one by one, comes back empty; yesterday's
completed games all have `{"condition": "Sunny", "temp": "94", "wind": "6 mph, Out To LF"}`.
So a model trained on observed weather is trained on something the live page
cannot compute at the moment anybody would use it. That is not a leak in the
usual sense — a forecast exists — but it breaks the rule this repo runs on:
**training and serving must compute the same numbers**.

A servable stand-in was built and tested: the park's own average temperature for
that month of the year, whether the roof is closed, whether it is a day game —
all knowable from the schedule alone. It adds nothing on top of the park index
(0.57574 with it, 0.57581 without), which makes sense, because the park index
already encodes most of what a venue's climate does to a baseball.

So the honest ledger:

| | AUC | delta |
|---|--:|--:|
| shipped props model (34 features) | 0.57438 | — |
| **this model (43 features, servable)** | **0.57581** | **+0.00143** |
| the same plus live weather | 0.57717 | +0.00279 |

Half the available gain is real and unreachable. It is quoted here so the number
is on the record, and it is not in the app.

---

## Results on the held-out season

| | shipped | **this model** |
|---|--:|--:|
| AUC | 0.5744 | **0.5758** |
| Brier | 0.2242 | **0.2240** |
| log loss | 0.6401 | **0.6397** |
| day's best pick | 51.0% | **52.9%** |
| day's best three | 48.0% | **50.5%** |
| day's best five | 47.9% | 47.8% |
| day's best ten | 44.3% | **44.6%** |

For scale: a naive "how often has this guy done it this season", with no model
at all, gets **0.5519**. The base rate is 35.4%.

### Calibration

Predicted against actual, 37,303 held-out hitter-games:

| predicted | n | mean predicted | actual |
|---|--:|--:|--:|
| 20–25% | 1,839 | 23.4% | 23.1% |
| 25–30% | 6,883 | 27.8% | 27.9% |
| 30–35% | 9,269 | 32.5% | 32.3% |
| 35–40% | 9,688 | 37.5% | 38.2% |
| 40–45% | 6,762 | 42.2% | 40.7% |
| 45–50% | 2,237 | 46.9% | 44.3% |
| 50%+ | 538 | 52.8% | 50.4% |

Tight through the middle, mildly over-confident at the very top — the 45–50%
bucket predicts 46.9% and delivers 44.3%. Worth knowing before betting the top
of the board.

### Tiers

Cut on the held-out season where the hit rate actually separates. "Breakeven" is
the American price at which the tier is exactly a push.

| Tier | n | hit rate | breakeven |
|---|--:|--:|--:|
| **Strong** | 1,865 | **47.3%** | +111 |
| Solid | 22,381 | 38.1% | +163 |
| Lean | 13,057 | 28.1% | +256 |

---

## What the model actually keys on

The twelve biggest standardised coefficients:

| feature | coefficient | in words |
|---|--:|---|
| `slot` | **−0.131** | where he bats in the order |
| `sp_k_bf` | −0.074 | how often the starter strikes batters out |
| `pa_pg` | +0.073 | how many trips to the plate he gets |
| `iso` | +0.046 | his extra-base power |
| `tb_pa` | +0.046 | his bases per plate appearance |
| `park_tb` | **+0.043** | how the park plays for total bases |
| `own_tb2` | −0.042 | how often he has already done it |
| `hr_pa` | −0.041 | his home-run rate |
| `w_pa_pg` | +0.035 | plate appearances he has been getting lately |
| `w15_h_pa` | +0.034 | his hit rate over two weeks |
| `bb_pa` | −0.033 | how often he walks |
| `w_g` | +0.030 | games in the last month |

Two readings.

**Opportunity beats ability.** `slot` and `pa_pg` are the first and third
largest weights, and together they dwarf every skill feature. The mechanism is
not subtle: two or more bases needs plate appearances, and a leadoff hitter gets
roughly one more per game than the nine hole. It is the least glamorous fact in
this file and the most useful one.

**Some individual signs look wrong, and that is expected.** `own_tb2` and
`hr_pa` carry negative weights while the model plainly likes power hitters. The
rate features are heavily collinear — nine different ways of saying "he is
good" — so the fit distributes credit among them in ways no single coefficient
survives being read alone. This matters directly for the explanation layer,
which is why it does not read them alone.

---

## Saying why, honestly

Each feature contributes `coef × (x − mean) / std` to the log-odds. Those
contributions are exact and they sum to the model's own linear predictor — but
read one at a time they will happily tell you a hitter's home-run rate is
working against him.

So the 43 features are tagged into six groups the trainer freezes into the model
file — his bat, recent form, how many at-bats he should get, the pitcher he
faces, the ballpark, the lineup around him — and the contributions are summed
*within* a group before anything is said. Collinear features cancel inside the
group they belong to, and every group ends up correlating positively with the
final projection:

| group | sd of contribution | correlation with the projection |
|---|--:|--:|
| how many at-bats he should get | 0.196 | +0.79 |
| the pitcher he faces | 0.109 | +0.39 |
| the ballpark | 0.098 | +0.38 |
| his bat | 0.076 | +0.48 |
| recent form | 0.045 | +0.54 |
| the lineup around him | 0.002 | +0.07 |

Then the group's biggest single feature supplies the number, so the sentence is
specific rather than generic:

> **47%** — well above the 35% a typical starter runs.
> Helps: bats 1st. Hurts: the starter strikes out 23% of hitters.

> **23%** — well below the 35% a typical starter runs.
> Hurts: bats 9th.

`scripts/test-two-bases.ts` enforces the properties that make this honest: every
feature belongs to exactly one group, the group contributions add back to the
model's log-odds, anything listed as helping has a positive effect and anything
listed as hurting has a negative one, and moving a feature the model likes moves
the projection the right way.

---

## What ships

`/mlb/two-bases`, one card per lineup starter, sorted by probability:

- the **percentage** and the fair American price it implies,
- the **tier** and what that tier actually hit on the held-out season,
- a **plain-English sentence** for why, plus the up and down factors as chips,
- and a note when the lineup has not been posted yet, because the batting order
  is then last game's rather than tonight's — and batting order is the single
  biggest input.

The features come from `batterRows` in `mlb-props.server.ts` rather than being
recomputed, so the Player Props board and this one can never quote a different
number for the same hitter.

---

## Reproducing

```bash
cd research/mlb-props && python3 fetch_props.py && python3 fetch_context.py && python3 features.py
cd ../mlb-tb2
python3 features_tb2.py       # the seven candidate blocks
python3 bakeoff_tb2.py        # ablation, greedy selection, twelve algorithms
python3 final_tb2.py          # freeze -> src/lib/mlb-tb2-model.json
npx tsx scripts/test-two-bases.ts
```

---

## What would move this next

- **Lineup-aware plate-appearance projection.** The model's biggest lever is how
  many times a hitter comes up, and it estimates that from his slot and his
  season average. Projecting it from the actual game — expected innings, the
  opposing starter's pace, whether his team bats in the ninth — is the obvious
  next feature, and it attacks the largest coefficient rather than the smallest.
- **A weather forecast.** Not from StatsAPI, which does not have one pre-game,
  but from a weather API keyed on the venue's coordinates. The +0.0014 is
  measured and sitting there; it needs a source the app can actually call.
- **The top-of-board over-confidence.** The 45–50% bucket predicts 46.9% and
  delivers 44.3%. A second calibration pass fitted only on the top decile would
  cost nothing and would make the best picks quotable at face value.
