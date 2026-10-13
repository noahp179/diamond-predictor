# Champions League — one rating for all of Europe, a match simulator, nine seasons of backtest

The Champions League is the one competition on the site that its own results
cannot model. Its clubs come from twenty leagues and play each other six to
fifteen times a season; the five domestic models are islands and cannot say
whether Sporting CP is better than Lens. So this model replays **91,191
matches since 2013** — twenty-two domestic leagues plus all three UEFA
competitions and their qualifiers, everything ESPN's public soccer API carries
— through **one Elo shared by every club in Europe**, and prices each match
through a full scoreline distribution that a minute-by-minute simulator then
plays out.

**On 1,253 Champions League matches from 2017-18 to 2025-26, priced only with
what was known the morning of each: RPS 0.3868, 57.9% called right**, against
0.4754 and 46.7% for the base rates and 0.4113 and 54.9% for the same Elo with
each league kept on its own.

---

## 1. Data

`research/ucl/fetch_ucl.py`, from ESPN's public scoreboard, one calendar year
per call (ESPN began refusing date-range queries — `dates=A-B` → 400, every
sport — in autumn 2026; years and months still answer):

| What                                   | Count                          |
| -------------------------------------- | ------------------------------ |
| Completed matches, 29 competitions     | 91,191                         |
| Champions League proper (2017-18 on)   | 1,271                          |
| Goals and red cards, with minute       | 248,136 events                 |
| Domestic leagues                       | 22 (big five, Portugal, Netherlands, Belgium, Turkey, Scotland, Austria, Switzerland, Greece, Denmark, Norway, Sweden, Cyprus, Russia, Israel, Romania, Ireland, English Championship) |

The **90-minute result** is what 1X2 settles on, so matches that went to extra
time are scored on the 90-minute score recovered from the goal log (every
detailed match: 99.4% of goal logs reproduce the final score exactly).

**Not in the feed:** domestic leagues in Czechia, Ukraine, Croatia, Serbia,
Poland, Azerbaijan and Kazakhstan; Switzerland after September 2025 and Israel
after May 2025. Those clubs are rated from European matches only.

## 2. The model

**Ratings — one Elo across every league.** Every match, oldest first. A
domestic match ranks two clubs within their league; a European match moves
points between leagues, and counts double (`eu_mult` 2.0) because that is the
only evidence on league strength there is. A club seen for the first time
enters at its league's current mean (minus `promo`), or at 1,250 if it is only
ever seen in Europe. Between seasons each club moves 20% of the way back to
**its league's** mean — the league's level is what Europe taught the model and
is not reset. A match's update is `K × (|goal difference| + 1)^0.7 × (result −
expected)` with K = 18 and home advantage 70.

The seven constants were tuned by coordinate descent on **2014-15 to 2016-17
only** (2,131 European matches) — before the first test season. Nothing from
2017-18 on chose a constant.

**Probabilities — through scorelines.** Each side gets a Poisson goal rate:

```
log(rate_home) = b0 + b1·gap + b2·home + b3·UCL + b4·UCL·gap      gap = (Elo_home − Elo_away)/400
log(rate_away) = a0 − a1·gap + a2·home + a3·UCL − a4·UCL·gap
```

fitted on every European match with a 90-minute score, then a Dixon-Coles
correction (ρ = −0.017) on the low scores. The scoreline matrix gives home /
draw / away, over/under, both-teams-to-score and the likeliest scores in one
consistent object — which is what the simulator needs. It costs nothing against
pricing 1X2 directly (table below).

## 3. Backtest

Walk-forward: ratings are the replay's own pre-match numbers (the observer
fires before each match is folded in), and the goal mapping for season S is
fitted on European matches from 2014-15 through S−1 only.

RPS here is summed over the two cumulative splits and **not halved** — the
convention of `research/soccer` and the site's ledger, so the numbers read on
the same scale as the five domestic leagues. Halve it for the literature.

### Pooled, 2017-18 to 2025-26 — 1,253 matches

| Model                                              | RPS        | Log loss | Brier  | Called right |
| -------------------------------------------------- | ---------- | -------- | ------ | ------------ |
| **Cross-league Elo → scorelines (shipped)**        | **0.3868** | 0.9214   | 0.5417 | 57.9%        |
| Cross-league Elo → 1X2 directly (multinomial)      | 0.3879     | 0.9230   | 0.5429 | 58.4%        |
| First version: one goal mapping for all of Europe  | 0.3888     | 0.9262   | 0.5450 | 58.0%        |
| Domestic Elo only (leagues as islands)             | 0.4113     | 0.9592   | 0.5668 | 54.9%        |
| Base rates                                         | 0.4754     | 1.0444   | 0.6317 | 46.7%        |

**The European links are the model.** Rating each league on its own — the way
the domestic models work — costs 0.0245 RPS and three points of accuracy.

**One change was made after looking, and it is disclosed here.** The first
version fitted one goal mapping to every European match, qualifiers included.
Its backtest showed the Champions League proper is a different competition —
3.12 goals a match against 2.71 predicted, 19.3% draws against 24.1%,
favourites priced 65-75% winning 82% — so the mapping gained the two
Champions League terms, exactly as each domestic league has its own
calibration. That is worth 0.0020 RPS. It was chosen after seeing the test
seasons; weigh that gain accordingly.

### Season by season

| Season  | Matches | RPS    | Called right | Domestic-only | Base rates |
| ------- | ------- | ------ | ------------ | ------------- | ---------- |
| 2017-18 | 128     | 0.3977 | 53.9%        | 0.4586        | 0.4811     |
| 2018-19 | 128     | 0.3891 | 56.2%        | 0.4209        | 0.4711     |
| 2019-20 | 119     | 0.3923 | 59.7%        | 0.4027        | 0.4863     |
| 2020-21 | 125     | 0.3883 | 60.8%        | 0.4210        | 0.4943     |
| 2021-22 | 125     | 0.3878 | 58.4%        | 0.4000        | 0.4738     |
| 2022-23 | 125     | 0.3486 | 59.2%        | 0.3791        | 0.4625     |
| 2023-24 | 125     | 0.3669 | 58.4%        | 0.3955        | 0.4617     |
| 2024-25 | 189     | 0.3963 | 57.7%        | 0.4051        | 0.4799     |
| 2025-26 | 189     | 0.4017 | 57.1%        | 0.4174        | 0.4692     |
| 2026-27 | 18      | 0.2358 | 83.3%        | 0.3306        | 0.4590     |

Beats the base rates in every season and the domestic-only Elo in every
season. 2026-27 is the shipped model, frozen through 2025-26, on matchday 1 —
eighteen matches is far too few to mean anything, and 15 of 18 is luck as much
as skill.

### Calibration — favourite priced at X, won how often?

| Priced at | Matches | Predicted | Happened |
| --------- | ------- | --------- | -------- |
| 33-45%    | 313     | 40.7%     | 39.6%    |
| 45-55%    | 337     | 50.1%     | 52.8%    |
| 55-65%    | 258     | 59.4%     | 57.4%    |
| 65-75%    | 173     | 69.6%     | 75.7%    |
| 75-85%    | 125     | 79.6%     | 83.2%    |
| 85-100%   | 47      | 89.7%     | 85.1%    |

Close through the middle; slightly timid about big favourites.

### Scorelines

| Per match         | Model  | Actual |
| ----------------- | ------ | ------ |
| Goals             | 2.92   | 3.12   |
| Draws             | 22.5%  | 19.3%  |
| Over 2.5          | 55.6%  | 60.7%  |
| Both teams score  | 52.4%  | 52.9%  |

The closed form is light on goals (it is fitted on seasons that scored less
than the competition does now) and its over/under Brier (0.2387) is no better
than the base rate's (0.2386). It knows who is stronger, not who plays open
football.

## 4. The simulator

`src/lib/sim/soccer.ts`, constants from `research/ucl/sim_ucl.py`. A match is
played one minute at a time; in each minute each side scores at

```
(model goal rate / 90) × minute effect × game-state effect × man-advantage effect
```

and is shown a red card at the minute's rate. The effects come from a Poisson
regression on the goal and red-card logs of **9,000+ European matches**, with
the model's own rates as the offset — so they reshape a match without moving
its total away from the model:

| Effect                         | Value |
| ------------------------------ | ----- |
| Minute 1-15 / 16-30 / 31-44    | 0.84 / 1.00 / 1.06 |
| Minute 45 (all 1st-half stoppage) | 3.35 |
| Minute 46-60 / 61-75 / 76-89   | 1.18 / 1.23 / 1.19 |
| Minute 90 (all 2nd-half stoppage) | 7.30 |
| Leading or trailing by one     | 0.84 / 0.84 (level = 1) |
| Leading or trailing by two+    | 0.88 / 0.81 |
| A man down / a man up          | 0.55 / 1.65 |
| Red cards per side per match   | 0.10  |
| Extra time, against the 90' rate | 1.15 |
| Shoot-outs                     | coin toss (hosts won 49.5% of 212) |

**Level matches are the open ones**: a side that leads *or* trails scores about
16% less than at level. That is what fixes the closed form's draw problem.

Goals go to players by their **share of their club's goals** — recency-weighted
(half-life 180 days) over the 400 days before the cut-off in all competitions,
shrunk toward a position average with six team goals, filtered by the club's
live ESPN roster (departed players dropped, injured players zeroed). Own goals
are 2.8% of all goals, as measured.

**Backtest.** Constants refitted on 2014-15 to 2016-17 only; every one of the
1,253 test matches played 4,000 times from its walk-forward goal rates:

|                    | Simulator | Closed form | Actual |
| ------------------ | --------- | ----------- | ------ |
| RPS                | 0.3869    | 0.3868      |        |
| Log loss           | 0.9199    | 0.9214      |        |
| Called right       | 57.9%     | 57.9%       |        |
| Draws              | 18.6%     | 22.5%       | 19.3%  |
| Goals per match    | 3.03      | 2.92        | 3.12   |
| Over 2.5           | 58.2%     | 55.6%       | 60.7%  |
| Both teams score   | 51.8%     | 52.4%       | 52.9%  |
| Over 2.5 Brier     | 0.2368    | 0.2387      | base 0.2386 |

Same RPS, better log loss, and much closer to reality on draws, goals and
totals.

## 5. What is on the site

A **UCL** competition in the Soccer section (`/soccer/ucl`):

- **Matches** — home/draw/away, expected goals, likeliest scores, over 2.5 and
  both-teams-to-score for every fixture, the posted market (margin removed)
  alongside, and a power table of the competition's clubs on the cross-league
  scale.
- **Simulate** — any fixture, or any two clubs (neutral venue, knockout with
  extra time and penalties, second leg from a first-leg score), played 1,000 to
  100,000 times in the browser: 1X2 with its Monte Carlo error next to the
  closed form and the market, the score grid, goal totals, and every likely
  scorer's anytime / 2+ / first-scorer chances. Or watch one match minute by
  minute.
- **Model & Backtest** — everything above.
- **Track Record** — the forward ledger (written before kick-off under
  `ucl-cross-elo-dc-v1`, scored after) and, kept separate below it, the
  replayed record of every match since 2017-18.

**How the live ratings stay current without a refit.** `ship_ucl.py` writes a
snapshot of every club's rating as of a cut-off (`src/lib/ucl-ratings.json`).
The server continues the replay from there over everything ESPN has posted
since, month by month, for all 29 competitions. Re-running the pipeline moves
the cut-off forward and shortens that read; it never changes the answer.
`scripts/test-ucl.ts` replays Python's own fixture through the TypeScript and
fails above 1e-6 (current worst: below that, on 322 matches and 302 clubs).

## 6. Today — 13 October 2026, league phase matchday 2

Ratings through 12 October. Simulated 20,000 times each; market = DraftKings
via ESPN, margin removed.

| Kick-off (UTC) | Match                          | Sim H / D / A | Market H / D / A | Likeliest |
| -------------- | ------------------------------ | ------------- | ---------------- | --------- |
| 16:45          | Sabah v Slavia Prague          | 46 / 21 / 33  | 24 / 24 / 51     | 1-1       |
| 16:45          | Lens v Sporting CP             | 33 / 20 / 47  | 37 / 26 / 37     | 1-1       |
| 19:00          | RB Leipzig v PSV               | 46 / 21 / 33  | 61 / 20 / 20     | 1-1       |
| 19:00          | Viking v Bayern Munich         | 9 / 11 / 80   | 6 / 9 / 85       | 0-2       |
| 19:00          | Inter v Club Brugge            | 65 / 17 / 18  | 77 / 15 / 9      | 2-1       |
| 19:00          | Galatasaray v Barcelona        | 12 / 13 / 75  | 11 / 15 / 74     | 0-2       |
| 19:00          | Atlético Madrid v Man United   | 41 / 21 / 38  | 50 / 25 / 25     | 1-1       |
| 19:00          | Arsenal v Lille                | 88 / 8 / 5    | 80 / 14 / 7      | 3-0       |
| 19:00          | Villarreal v Napoli            | 42 / 21 / 38  | 46 / 26 / 28     | 1-1       |

The biggest disagreements with the market are where the model is weakest:
Sabah and Slavia are both rated from European matches alone, and the model
sees no squad news.

## 7. Honest limits

- **No market benchmark in the backtest.** ESPN shows 1X2 prices before a
  match and drops them after, so there are no historical closing lines. The
  forward ledger is where model-versus-market gets settled.
- **Invisible leagues** (above): those clubs' ratings are noisier and lag.
- **Results, not squads.** Injuries, rotation and coaching changes reach the
  ratings only through later results.
- **Totals are the weak part** of the closed form; the simulator is better but
  still a touch light on goals (3.03 against 3.12).

## Reproducing

```
cd research/ucl
python3 fetch_ucl.py                    # ~4 min cold; cached after
python3 tune_ucl.py                     # Elo constants, 2014-15..2016-17 only
python3 backtest_ucl.py                 # walk-forward, 2017-18 on
python3 ship_ucl.py --date YYYY-MM-DD   # model, snapshot, history, scorers, parity, slate
python3 sim_ucl.py  --date YYYY-MM-DD   # simulator constants, its backtest, the day's sims
cd ../.. && npx tsx scripts/test-ucl.ts --live
```
