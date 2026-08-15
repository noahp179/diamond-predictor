# Tennis — ATP and WTA, and two things that turned out to be wrong

44,027 singles matches across five seasons (2021–2025): **19,438 ATP** over 897
players and **24,589 WTA** over 1,266. Each tour fitted, calibrated and scored
on its own data.

| | Matches | Players | Hard | Clay | Grass | Unlabelled |
|---|---|---|---|---|---|---|
| ATP | 19,438 | 897 | 57.1% | 30.3% | 12.1% | 0.5% |
| WTA | 24,589 | 1,266 | 49.6% | 31.4% | 10.9% | 8.0% |

---

## 1. What makes tennis structurally harder than the other four sports

**There are no teams.** A rating belongs to a player who may not have hit a ball
in six weeks, and there is no roster endpoint to read current form from. Every
prediction requires replaying the tour — every completed singles match, in order
— to know anything at all about the two people walking on court.

**The feed is thin.** ESPN's tennis API has no surface field, no rankings, and
`statistics` is empty on every competitor, so aces, first-serve percentage and
break points cannot be modelled at all. What it does have is set-by-set
linescores and a stable player id.

**`format.regulation.periods` reports best-of-five on every match**, qualifiers
included, so it is unusable. Best-of is recovered from the scoreline instead:
only a best-of-five can reach a third set win.

### The leak, and how it is closed

The raw feed names a *winner* and a *loser*. Any row keyed on those columns
already knows the answer. Every match is re-cast with a deterministic
orientation — the smaller player id is always "A" — and every feature is written
as an A-minus-B difference. A model fed antisymmetric features cannot learn "A
tends to win", because there is no such tendency; the A-won rate sits at 0.500.

Ordering by id rather than by a random coin is deliberate: it is arbitrary with
respect to who wins, and unlike a coin it reproduces across runs.

---

## 2. The bake-off

About thirty algorithms per tour: Elo at three K values, margin-aware Elo,
surface Elo, a surface/global blend, Glicko, Bradley-Terry; career, seasonal and
recent form; head-to-head, common opponents, fatigue, rest days, seeding; nine
ML families; and ensembles whose members were named before any result was read.

Metric is **log loss** — no ranked probability score, because tennis has no
draw, and log loss punishes confident wrongness, which is exactly how a rating
system fails when it meets someone it has not seen. A coin flip scores 0.693,
and so does the base rate: with the draw oriented by player id there is no home
advantage to exploit.

### ATP — 11,956 held-out matches

| # | Algorithm | Log loss | Accuracy | AUC | ECE |
|---|---|---|---|---|---|
| 1 | ML_kNN | 0.6324 | 63.4% | 0.6909 | 0.0073 |
| 2 | ML_random_forest | 0.6325 | 63.4% | 0.6918 | 0.0149 |
| 3 | ML_extra_trees | 0.6328 | 63.2% | 0.6907 | 0.0111 |
| 4 | ENS_diverse5 | 0.6373 | 62.8% | 0.6885 | 0.0261 |
| 5 | ML_logistic_L1 | 0.6389 | 63.6% | 0.6905 | 0.0382 |
| 7 | elo_fast (K=40) | 0.6406 | 61.9% | 0.6777 | 0.0233 |
| 10 | elo (K=24) | 0.6417 | 61.9% | 0.6751 | 0.0231 |
| 18 | **elo_surface** | **0.6525** | 60.4% | 0.6535 | 0.0242 |
| 28 | base rate | 0.6930 | 51.0% | 0.4962 | 0.0023 |
| 31 | **head_to_head** | **0.6992** | 52.5% | 0.5406 | 0.0355 |

### WTA — 16,105 held-out matches

| # | Algorithm | Log loss | Accuracy | AUC | ECE |
|---|---|---|---|---|---|
| 1 | ML_random_forest | 0.6240 | 64.9% | 0.7067 | 0.0137 |
| 2 | ML_extra_trees | 0.6241 | 65.0% | 0.7069 | 0.0153 |
| 3 | ML_kNN | 0.6251 | 64.9% | 0.7056 | 0.0199 |
| 4 | ML_logistic_L1 | 0.6270 | 64.6% | 0.7053 | 0.0305 |
| 8 | elo_fast (K=40) | 0.6370 | 62.8% | 0.6844 | 0.0180 |
| 11 | elo (K=24) | 0.6396 | 62.5% | 0.6802 | 0.0217 |
| 18 | **elo_surface** | **0.6573** | 59.7% | 0.6443 | 0.0241 |
| 28 | base rate | 0.6931 | 49.6% | 0.5057 | 0.0229 |
| 30 | **head_to_head** | **0.6963** | 51.7% | 0.5394 | 0.0461 |

---

## 3. Two results that changed what ships

Both were expected to help. Both were tested, and both failed on **each tour
independently** — which is what makes them findings rather than noise.

### Head-to-head makes the model worse

A pre-registered ablation removed whole feature groups one at a time. The
matchup group — head-to-head record and common opponents — was the only group
whose *removal* improved the model, and it improved it on every metric:

| | Log loss | Accuracy | AUC |
|---|---|---|---|
| ATP with H2H | 0.6390 | 63.6% | 0.6905 |
| ATP without | **0.6349** | **63.7%** | **0.6951** |
| WTA with H2H | 0.6271 | 64.6% | 0.7052 |
| WTA without | **0.6248** | **65.0%** | **0.7078** |

Standalone it is worse than useless: 0.6992 on the ATP against 0.6930 for
always predicting the base rate. So is a current winning streak, at 0.6991.

The reason is not mysterious. Most pairs have met once or twice, so a
"record" is a coin flip dressed as evidence — and whatever *is* real in a
matchup is already priced into both players' ratings, so including it double-
counts one noisy observation.

The most quoted number in tennis punditry is a liability. It is **shown on match
cards**, because people want to see it, and it is **kept out of the model**.

### Surface-specific Elo is worse than global Elo

Keeping separate hard, clay and grass ratings is the standard tennis-modelling
move. It lost on both tours:

| | Global Elo | Surface Elo | Blend |
|---|---|---|---|
| ATP | 0.6417 | 0.6525 (**+0.0108 worse**) | 0.6416 (−0.0001) |
| WTA | 0.6396 | 0.6573 (**+0.0176 worse**) | 0.6417 (+0.0021 worse) |

Splitting a career three ways thins each player's history faster than court
specialisation pays for it. Even the 50/50 blend is a wash on the ATP and a
small loss on the WTA.

**But surface is not useless — it is useless as a rating split.** The ablation
shows the surface features earn their place *inside* a model that also sees
global form: +0.0017 log loss on the ATP, +0.0007 on the WTA. That is the only
role it keeps.

This matters for a second reason. The surface labels are a hand-built table —
ESPN publishes no surface field — so they were built to be *tested* rather than
trusted. The test says they carry real signal in the feature role and cannot
support the rating role. That is a more useful answer than either "surface
works" or "surface doesn't".

### The full ablation

Positive means removing the group made things worse, i.e. the group earns its
place.

| Group | ATP | WTA |
|---|---|---|
| elo_family | +0.0023 | +0.0037 |
| other_ratings (Glicko, Bradley-Terry) | +0.0010 | +0.0017 |
| surface | +0.0017 | +0.0007 |
| form | +0.0014 | −0.0003 |
| experience | +0.0003 | +0.0017 |
| seeding | +0.0005 | −0.0000 |
| physical (fatigue, rest) | +0.0003 | +0.0000 |
| context (best-of, draw size, round) | +0.0002 | +0.0000 |
| **matchup (H2H, common opponents)** | **−0.0040** | **−0.0023** |

---

## 4. What ships

A **logistic regression over twenty antisymmetric features, without the matchup
group**.

Not the bake-off winner. Random forest, extra trees and kNN scored slightly
better, but each needs a fitted sklearn object per tour at request time, where a
logistic ships as coefficients and a standardiser the site evaluates exactly —
the same arrangement as the MLB and soccer prop models. Dropping head-to-head
more than paid for the family downgrade, so the shipped model lands near the top
of a table it did not win:

| Tour | Log loss | Accuracy | AUC | ECE | Test matches | Bake-off rank |
|---|---|---|---|---|---|---|
| ATP | 0.6351 | 63.7% | 0.6951 | 0.0322 | 11,956 | 4 / 33 (+0.0026) |
| WTA | 0.6249 | 65.0% | 0.7078 | 0.0217 | 16,105 | 3 / 33 (+0.0009) |

### Refitting matters more than the algorithm choice

Two measurements are reported, because the gap between them is itself a finding:

| | Refitted each season | Frozen in 2022 | Refitting is worth |
|---|---|---|---|
| ATP | 0.6351 | 0.6405 | 0.0054 |
| WTA | 0.6249 | 0.6328 | 0.0079 |

Keeping the model current is worth about twice what picking the best algorithm
family was. Shipped coefficients are fitted on every season, so the live model
starts from the refitted end; the walk-forward figure is the performance claim.

---

## 5. What is on the site

A **Tennis** tab with two tours and two pages each:

- **Draw** — every match on the date with win probabilities, the surface, seeds,
  head-to-head (shown, not used), and the live Elo table.
- **Model & Backtest** — what ships, the two negative results, and the
  standardised feature weights.

Live predictions replay the previous two years of tour up to the morning of the
match, because there is no other way to know a player's form. That costs about
eight seconds cold per tour and is cached; every request after is instant.

---

## 6. Honest limits

- **No serve statistics at all.** `statistics` is empty on every competitor, so
  aces, double faults and first-serve percentage cannot be modelled. Any prop
  market here would have to be derived from scorelines instead.
- **No rankings.** Only the *seed in this draw*, which is missing for unseeded
  players; 40 stands in for "unseeded". A real ranking feed would likely help.
- **Surface is a hand-built table**, not a data field. Coverage is 99.5% ATP and
  92.0% WTA; what could not be placed with confidence is labelled "unknown" and
  treated as its own category rather than guessed into a bucket.
- **No market benchmark.** ESPN carries no tennis prices in this feed, so
  nothing here is measured against a book and no claim is made about beating one.
- **Retirements are kept but flagged.** A retirement still has a winner, but it
  is not evidence about who plays better.
- **~64% accuracy is the realistic ceiling here.** Tennis at this level is
  genuinely close to a coin flip in a large fraction of matches; the useful
  output is the calibrated probability, not the pick.

## Reproducing

```
cd research/tennis
python3 fetch_tennis.py   --tour atp        # and wta
python3 bakeoff_tennis.py --tour atp        # ~30 algorithms, pooled test seasons
python3 ablate_tennis.py  --tour atp        # pre-registered group ablation
python3 ship_tennis.py    --all             # freeze the model the site runs
```
