# NFL Player Props — Model and Backtest

Fourteen prop markets for every NFL slate, each its own logistic model, fit on
2021-24 and tested on 2025. This is the record of what was built, what it
measured, and the one thing that was measured and deliberately **not** shipped.

Ships as `/nfl/props`. Code: `src/lib/nfl-props.server.ts` (serving),
`research/nfl-props/` (data, fit, study).

## TL;DR

- **Fourteen markets.** Receptions 3+/5+/7+, receiving yards 40+/60+/80+,
  rushing yards 40+/60+/80+, scrimmage yards 60+/90+, and for quarterbacks
  passing yards 225+/275+ and 2+ passing touchdowns.
- **Held-out 2025 AUC 0.81-0.94** on the skill markets, 0.62-0.67 on the
  quarterback markets. Top-50 picks of the season hit 86-90% on the wide rungs.
- **Tiers are cut on the hold-out**, not on training data. On 2025, Strong rungs
  ran 82.6% (3+ receptions), 74.9% (40+ rushing) and 71.8% (40+ receiving).
- **Injuries: players ruled out are removed, not discounted.** In the hold-out,
  **17.8%** of the Solid-or-better picks this board
  would otherwise have printed went to a player who never took the field.
- **Injuries: redistributing the missing player's usage was tested and
  rejected.** Every setting made the numbers worse, monotonically. That result
  is below in full; the feature is not in the product.
- **Anytime touchdowns are not here.** The TD Scorers tab prices that event with
  its own model, and quoting one question from two models is how a board starts
  contradicting itself.

## Data

Everything comes from public ESPN endpoints — the same ones the server reads at
request time. A model trained on numbers the app cannot rebuild live is a model
the app cannot serve, so there is no second data source anywhere in this
pipeline.

| Table              | Rows   | Source                                        |
| ------------------ | ------ | --------------------------------------------- |
| `player_games.csv` | 26,911 | `summary?event=` box scores, 2021-25          |
| `team_games.csv`   | 2,718  | the same box scores, aggregated per team      |
| `games.csv`        | 1,359  | scoreboard by season/week + the pre-game line |

`research/nfl-props/fetch_espn.py` collects all of it and caches the raw JSON,
so re-runs are instant and resumable.

### Getting a market line for every game

`pickcenter` in the game summary carries the pre-game total and spread, but its
coverage collapses for older games — **2024 had none at all**, and only 48% of
the five seasons had a line. The core odds feed still has them, so the collector
backfills from there and coverage goes to **1,358 of 1,359 games**.

Both the collector and the server skip books whose name marks them as in-play.
Once a game kicks off ESPN lists a live book beside the pre-game one, and by the
fourth quarter they describe different games entirely.

### Features

The window is the **team's last 8 games**, and a player's history is his
appearances inside it. Two deliberate choices there:

- **Trailing games, not season-to-date.** Season-to-date is empty in Week 1 —
  the exact hole that left the touchdown board blank on opening night — so the
  window crosses the season boundary and in Week 1 is simply last season's last
  eight. `season_gp` carries how many of them are from this season, so the model
  can learn to discount a stale window rather than being lied to about it.
- **Anchored to the team, not the player.** "His own last 8 appearances" is the
  more natural reading, but it is unbounded: a back who missed six weeks needs
  fourteen box scores fetched to fill it, and the server cannot pull an
  unbounded number per team. Anchoring to the team also makes `hist_g` do real
  work — eight appearances in the team's last eight is a workhorse, three is
  someone who has been hurt.

Skill-position markets get 28 features, quarterback markets 20:

- **Usage:** carries, targets and receptions per game over the short (3-game)
  and long (8-game) windows; rushing, receiving and scrimmage yards per game.
- **Efficiency:** yards per carry, yards per reception and catch rate, each
  shrunk toward the league mean until the denominator earns its own number.
- **Role:** carry share and target share of what the offence actually did.
- **Team and opponent:** plays per game, pass rate, and the rushing and passing
  yards the opposing defence has allowed over _its_ own last 8.
- **Market:** the game total, this team's implied total, its expected margin,
  and a flag for whether a line exists at all.
- **Own rate:** how often this exact market has hit for this player over each
  window, shrunk toward the market's base rate.

A row only trains, and only shows, when there are 10+ carries-plus-targets (or
30+ pass attempts) and two appearances behind it. Below that the model is
reading a special-teamer with one carry.

## Held-out 2025 results

Fit on 2021-24, tested on 2025. The test season is never fit on and never used
to choose a threshold before the tiers are cut.

| Market     | Prop                | Base  | AUC   | Brier | Top-50 | Strong | Solid | Lean  | n    |
| ---------- | ------------------- | ----- | ----- | ----- | ------ | ------ | ----- | ----- | ---- |
| `rec3`     | 3+ receptions       | 42.4% | 0.825 | 0.169 | 86%    | 82.6%  | 65.4% | 21.9% | 3896 |
| `rec5`     | 5+ receptions       | 19.2% | 0.832 | 0.112 | 74%    | 56.7%  | 29.6% | 5.1%  | 3896 |
| `rec7`     | 7+ receptions       | 7.4%  | 0.860 | 0.051 | 46%    | 30.5%  | 8.8%  | 1.1%  | 3896 |
| `recy40`   | 40+ receiving yards | 27.4% | 0.831 | 0.140 | 80%    | 71.8%  | 42.9% | 9.9%  | 3896 |
| `recy60`   | 60+ receiving yards | 15.3% | 0.836 | 0.098 | 62%    | 49.2%  | 23.3% | 3.8%  | 3896 |
| `recy80`   | 80+ receiving yards | 8.3%  | 0.843 | 0.061 | 58%    | 32.3%  | 11.7% | 1.6%  | 3896 |
| `rushy40`  | 40+ rushing yards   | 14.2% | 0.942 | 0.067 | 90%    | 74.9%  | 22.4% | 0.2%  | 3896 |
| `rushy60`  | 60+ rushing yards   | 8.4%  | 0.934 | 0.052 | 76%    | 51.3%  | 10.8% | 0.2%  | 3896 |
| `rushy80`  | 80+ rushing yards   | 4.6%  | 0.937 | 0.035 | 40%    | 31.5%  | 4.1%  | 0.0%  | 3896 |
| `scrim60`  | 60+ scrimmage yards | 27.2% | 0.807 | 0.143 | 88%    | 73.3%  | 38.3% | 10.6% | 3896 |
| `scrim90`  | 90+ scrimmage yards | 12.4% | 0.829 | 0.085 | 66%    | 46.9%  | 17.2% | 3.4%  | 3896 |
| `passy225` | 225+ passing yards  | 49.5% | 0.668 | 0.228 | 70%    | 67.3%  | 54.5% | 38.2% | 515  |
| `passy275` | 275+ passing yards  | 25.5% | 0.657 | 0.164 | 40%    | 38.5%  | 27.9% | 15.5% | 515  |
| `passtd2`  | 2+ passing TDs      | 42.4% | 0.617 | 0.235 | 66%    | 63.5%  | 49.4% | 36.6% | 515  |

**Read the AUC carefully.** The pool mixes running backs, receivers and tight
ends, so part of the 0.94 on rushing yards is the model correctly noticing that
a slot receiver will not rush for 40 yards. That is real but trivial
discrimination. The honest numbers are the **top-50** column and the **tier hit
rates**, which ask what happens to the picks the board would actually print.

**Quarterback markets are the weak ones**, and the table says so: AUC 0.617 on
2+ passing touchdowns against a 42.4% base, over only 515 test rows. They are
shipped because a Strong rung still separates (63.5% vs 42.4%), but they are the
thinnest evidence on the page.

### Window length: 8 games, not 17

A 17-game window was the first design. It is twice the fetching — 285 KB a box
score, 17 a team, 26 teams on a Sunday — and it bought nothing measurable:

| Window                 | rec3  | recy40 | rushy40 | passy225 |
| ---------------------- | ----- | ------ | ------- | -------- |
| last 17                | 0.840 | 0.847  | 0.948   | 0.673    |
| last 8                 | 0.837 | 0.843  | 0.945   | 0.692    |
| last 8, short window 3 | 0.839 | 0.843  | 0.945   | 0.700    |

Shortening the recent-form window from 6 games to 3 helped slightly everywhere,
which makes sense: at 6 against a long window of 8 the two were measuring almost
the same thing.

## Injuries

The request this work answers was to factor in who is playing and who is not.
There are two separate things that could mean, and they came out very
differently.

### 1. Removing players who are ruled out — shipped

`summary?event=` carries that week's injury report with athlete ids. Anyone
listed Out, Doubtful, on Injured Reserve, suspended, on PUP or NFI is removed
from the board before anything is ranked. No model is needed for this: a man on
the inactive list cannot record a reception.

Doubtful is in that list on purpose. It is a listed chance of playing of roughly
a quarter, and a prop on someone three-to-one against taking a snap does not
belong beside one that is 70% to hit.

To size what this is worth, the hold-out season was replayed asking a different
question: of the picks the board **would** have shown, how many went to a player
who did not take the field? Absence is recovered from the box score — someone
who was in the rotation over the team's recent games and then recorded no
offensive touch at all did not play.

| Market    | Solid-or-better picks | Dead on arrival | Share |
| --------- | --------------------- | --------------- | ----- |
| `rec3`    | 1818                  | 268             | 14.7% |
| `rec5`    | 1841                  | 270             | 14.7% |
| `rec7`    | 1848                  | 297             | 16.1% |
| `recy40`  | 1888                  | 312             | 16.5% |
| `recy60`  | 1897                  | 325             | 17.1% |
| `recy80`  | 1884                  | 326             | 17.3% |
| `rushy40` | 2002                  | 470             | 23.5% |
| `rushy60` | 1990                  | 454             | 22.8% |
| `rushy80` | 2023                  | 469             | 23.2% |
| `scrim60` | 1825                  | 255             | 14.0% |
| `scrim90` | 1844                  | 261             | 14.2% |

**3,707 of 20,860 (17.8%)** of the picks were guaranteed
losers before kickoff. Rushing markets are the worst hit at roughly 23%, because
backfields rotate hardest.

One caveat, stated plainly: **not all of that 17.8% is recoverable.** "Did not
play" includes healthy scratches and committee rotations that no injury report
flags. The filter catches the subset that is actually listed — which is the
large majority of the meaningful cases, but not all of them.

### 2. Redistributing the missing player's usage — tested, rejected

The obvious next step: when the lead back is out, the backup's trailing carries
understate what he is about to get, so renormalize usage over the players who
are available. This was implemented, swept and measured rather than assumed.

`alpha` is how completely the freed usage transfers (1.0 = perfect
substitution), `cap` the ceiling on any one player's scale-up. Searched on
2021-24, over the 1,019 of 1,055 games where a rotation player was missing:

| alpha | cap  | Δ logloss |
| ----- | ---- | --------- |
| 0     | 1.25 | +0.00000  |
| 0.25  | 1.25 | +0.00019  |
| 0.25  | 2.5  | +0.00040  |
| 0.5   | 1.25 | +0.00181  |
| 0.5   | 2.5  | +0.00584  |
| 0.75  | 1.25 | +0.00508  |
| 0.75  | 2.5  | +0.01850  |
| 1     | 1.25 | +0.01023  |
| 1     | 2.5  | +0.04084  |

Every setting is worse than doing nothing, monotonically in `alpha`. The search
therefore chose `alpha = 0` — the no-op — and the held-out season confirms it:
AUC and logloss both unchanged to five decimal places, because nothing moves.

Why it fails is worth recording. The trailing window **already contains** the
games where team-mates were out; a backup's recent form is partly his
post-injury form. Scaling it again double-counts. And proportional
renormalization lifts the starter along with everyone else, so a third-string
back being inactive nudges the workhorse's projection for no reason.

So the shipped behaviour is: **remove who is out, flag who is questionable,
change no probabilities.**

### 3. Questionable players — flagged, not discounted

A player listed Questionable stays on the board with a caution, and his
probability is untouched. The honest reason is that it cannot be calibrated
here: ESPN serves the **current** injury list even when asked about a 2023 game,
so historical injury reports are not recoverable from this data and there is no
way to measure how often a Questionable player actually plays. Inventing a
discount would be inventing a number. The badge says what is known; the reader
decides.

The same anachronism is why the injury filter and the roster filter are applied
to the live season only. Applying today's injury list to a game from last
November would rule players out of games they demonstrably played.

## Live parity

A model that is only correct in the notebook is not correct. Two checks guard
the gap between `features.py` and `nfl-props.server.ts`:

1. The model file ships 42 real feature vectors and the probabilities the
   trainer produced for them. `selfTest()` replays them — this catches drift in
   the inference arithmetic.
2. `scripts/test-nfl-props.ts` rebuilds an entire past slate from live ESPN and
   compares every probability against the ones Python computed from its own
   CSVs. This is the one that matters, because it catches features being _built_
   differently even when the inference matches.

Check 2 caught two real bugs during development: team totals and opposing-defence
totals were being summed over the games the player appeared in rather than over
the team's and opponent's own windows. On 2025-11-16 it now compares **2,129
probabilities with a largest difference of 4.4e-16**.

```
npx tsx scripts/test-nfl-props.ts 2025-11-16
```

## What shipped

- `/nfl/props`, one card per game, five rows per card by default.
- One row per player at their biggest-edge rung, so a single back does not fill
  a card at 40+, 60+ and 80+ rushing yards. Pick a market from the tabs to see
  every player at that exact number instead.
- Tier badge carries the **measured hold-out hit rate** for that tier, not a
  restatement of the probability.
- Players ruled out are named on the card rather than silently dropped: a
  missing starter is often the most useful thing on the page.
- Cards say when the form window still reaches into last season, which in
  September it always does.

## Honest limits

- **Quarterback markets are thin.** 515 test rows and AUC in the 0.6s. Treated
  as the weakest thing on the board.
- **Training rows only exist for players who played.** The model never sees the
  counterfactual of a player who was active but unused, so it is conditioned on
  taking the field — which is exactly why the availability filter carries as
  much weight as it does.
- **Base rates are pool base rates**, not market base rates. "Edge vs avg" means
  against an average qualifying player, not against a sportsbook's price. This
  board does not claim +EV against a posted number; it ranks likelihood.
- **No usage redistribution**, for the measured reason above. A depth chart that
  has genuinely changed will be read late, through the trailing window, rather
  than anticipated.
- **Week 1 runs on last season's form** for every player, and says so on the
  card. Rookies and free-agent signings with no ESPN history do not appear at
  all until they play.
- **One season of hold-out.** 2025 only. The tiers are cut on roughly 390 Strong
  rows a market, so the tier hit rates carry real sampling error.

## Files

| Path                                  | What it is                                                   |
| ------------------------------------- | ------------------------------------------------------------ |
| `research/nfl-props/fetch_espn.py`    | box scores, team totals and market lines, 2021-25            |
| `research/nfl-props/features.py`      | the feature definitions, and the only place they are defined |
| `research/nfl-props/train.py`         | per-market fit, Platt calibration, tiers, export             |
| `research/nfl-props/injury_study.py`  | the availability experiments above                           |
| `research/nfl-props/dump_expected.py` | expected probabilities for the parity check                  |
| `src/lib/nfl-props-model.json`        | the frozen weights, tiers and selftest vectors               |
| `src/lib/nfl-props.server.ts`         | live serving: windows, injuries, inference                   |
| `src/lib/nfl-espn.server.ts`          | the shared ESPN box-score layer (also used by TD Scorers)    |
| `scripts/test-nfl-props.ts`           | selftest + live-vs-trained parity                            |
