# football-td — held-out predictions of the shipped touchdown models

Per-player, per-game probabilities from the two **shipped** anytime-touchdown
models (NFL pairwise ranker, college extra-trees) and the shipped **NFL
first-touchdown** model, on their held-out test seasons, with outcomes — so a
game simulator can be scored head-to-head on exactly the same player-games.
Plus the parsed box scores and raw ESPN summaries the simulator backtest will
rebuild season stats from.

Nothing outside this directory was modified. The original pipelines
(`research/nfl-td-scorer/`, `research/cfb/`) were read, and the pieces needed
were **copied** here (functions marked "verbatim" in the scripts).

## How to run

```
# NFL
python3 research/football-td/fetch_nfl.py          # nflverse schedule+lines, ESPN summaries 2021-26
python3 research/football-td/features_nfl.py       # point-in-time features (+ extra row kinds)
python3 research/football-td/fetch_rosters.py nfl  # positions
python3 research/football-td/predict_nfl.py        # anytime ranker: refit 2021-24, predict 2025-26
python3 research/football-td/fetch_first_td.py nfl # first-TD scorer per game
python3 research/football-td/predict_nfl_td1.py    # first-TD model: refit 2021-24, predict 2025-26

# College
python3 research/football-td/fetch_cfb.py          # FBS schedules (daily scoreboards) + summaries 2021-26
python3 research/football-td/patch_cfb_boxes.py    # restore Army-Navy 2025 (see "Problems"); rerun fetch_cfb.py
python3 research/football-td/features_cfb.py       # point-in-time features + Elo replay
python3 research/football-td/fetch_rosters.py cfb  # season rosters + positions
python3 research/football-td/predict_cfb.py        # shipped forest on 2025-26 (+ TypeScript cross-check)
python3 research/football-td/fetch_first_td.py cfb # first-TD scorer per game (no model ships)
```

Fetchers cache everything under `data/` and are resumable; a rerun only
downloads what is missing (plus the live 2026 season's schedule).
`ts_infer.ts` runs the site's own `inferForest` / `inferRanker`
(`npx tsx research/football-td/ts_infer.ts <cfb|nfl> in.json out.json`) and
is called by the predict scripts as a cross-check.

## Deliverables

### `data/nfl_model_preds.csv` — shipped NFL anytime-TD ranker, held out (10,847 rows, 364 games)

2025 regular season + postseason (285 games) and 2026 through 2026-10-12 (79 games).

| column | meaning |
|---|---|
| season, week, game_type, date | nflverse week / REG,WC,DIV,CON,SB / game day (ET) |
| event_id | ESPN event id |
| team_id, team, opp, is_home | ESPN team id; nflverse abbreviations |
| player_id, player_name, position | ESPN athlete id; position from nflverse `players.csv` (espn_id) |
| **prob** | held-out P(anytime rushing/receiving TD): the 2021-24 refit, transformed exactly like `inferRanker` (standardize, s = w·z, sigmoid(a·s+b), 0.8·p + 0.2·base) |
| prob_deployed | the same rows scored with the **shipped** weights in `src/lib/nfl-td-ranker.json` (fitted on 2021-24 + 2025 + 2026 Wk 1 — in-sample there, genuinely out-of-sample for 2026 games after 2026-09-16) |
| scored, touchdowns, rush_td, rec_td | outcome: ≥1 rushing or receiving TD; their count. Return/defensive TDs are NOT in the label (they are in `nfl_player_box.csv`) |
| carries, targets | this game's usage |
| **candidate** | 1 = the model's candidate (see rules below). **All metrics are on candidate == 1.** |
| kind | `candidate` / `no_history` / `no_touch` (below) |
| in_box, priced | touched the ball this game / has a prob |
| in_quoted_subset | candidate row in the 301 games the shipped numbers were quoted on |
| unpriced_reason | for `no_history`: `no_prior_usage` or `no_team_history` |
| games_since_touch | for `no_touch`: team games since his last carry/target (0 = previous game) |
| carried | games of the window taken from last season |
| f_* | the 18 raw model features in shipped order |

### `data/cfb_model_preds.csv` — shipped college extra-trees, held out (50,240 rows, 1,406 games)

2025 full season incl. bowls/CFP (958 games, 953 priced) and 2026 through
2026-10-10 (448 games, 440 priced). Same columns as the NFL file except
`week, season_type` (ESPN), `receptions` instead of `targets` (college box
scores carry no targets), `raw_forest` (the forest's average before Platt),
`carried_games`, the 16 forest features as `f_*`, and no `prob_deployed`
(the shipped forest *is* the 2021-24 fit, so `prob` is both).

### `data/nfl_td1_preds.csv` — shipped NFL first-TD model, held out (10,270 rows, 364 games)

Same candidate rows (+ priced `no_touch` rows) as the anytime file:
season, week, game_type, date, event_id, team_id, team, opp, player_id,
player_name, position, **prob** (2021-24 refit, `inferMarket("td1")`
arithmetic), prob_deployed (shipped `nfl-td1-model.json`), **first_td** (0/1),
scored_anytime, candidate, kind, in_quoted_subset, games_since_touch.

### `data/nfl_first_td.csv`, `data/cfb_first_td.csv` — actual first TD scorer per game

event_id, season, date, **first_td_player_id**, first_td_player,
**first_td_team_id**, **kind** (`offense` = rushing/receiving TD by the
rusher/receiver; `defense/special teams` = any return / fumble-recovery /
blocked-kick TD; `none` = game had no TD), play_type, period, clock, text,
source, summary_player_id, summary_agrees. NFL covers every game 2021-26 (2021-23 are td1
training labels); college covers every game with a raw summary (2024-26).
See "First touchdown" below for how they are derived.

## Candidate rules (who the model prices)

Both research pipelines evaluate on **players who recorded ≥1 carry or target
(NFL) / carry or reception (CFB) in that game** and who have prior usage. That
is outcome-conditioned (it knows who got the ball), it is how every quoted
number was produced, and a simulator compared on these rows must be compared on
the same rows.

* **NFL** — usage window = this season's team games before the game, topped up
  with the last (6 − played) games of last season while fewer than 6 have been
  played; a candidate needs ≥1 game with a carry/target in that window *for
  this team*. Team and opponent need ≥1 window game. Lines from nflverse
  (closing spread/total). Live board difference: it prices everyone in the
  window on the active roster and does not condition on touching the ball.
* **CFB** — season-to-date totals; below 5 team games a team borrows a scaled
  share of last season (same fraction for the whole roster); a candidate needs
  ≥1 carry+reception of (blended) usage. Team and opponent need history, so a
  game against an FCS team making its first appearance is not priced at all.
  Per-game rates divide by TEAM games (serve parity with the live roster feed).

Extra rows (never in the metrics):

* `no_history` — touched the ball this game but could not be priced (rookies,
  first appearances; prob blank). NFL: 577 rows holding 67 of the 1,483
  scorer-games; CFB: 4,538 rows holding 645 of 7,169.
* `no_touch` — used by this team earlier **this** season, no carry/target this
  game (inactive, hurt, released, or unused). Priced by the model, scored = 0
  by construction. Approximates the live board's un-conditioned candidate set;
  filter on `games_since_touch` to approximate an active roster.

## Reproduced vs quoted

### NFL anytime ranker — exact

The held-out bundle is refitted with export_ranker.py's `fit_bundle` on
2021-24 (20,379 rows — the documented count). As a data check, the
**deployment** fit was rebuilt on 2021-24 + 2025 + 2026 to the export date
(25,749 rows): weights, Platt a/b, base, mean/std and the three self-test
vectors match `src/lib/nfl-td-ranker.json` **bit for bit** (max diff 0.0), and
the TypeScript `inferRanker` agrees with the numpy port to 2e-16 on all 10,270
priced rows.

| held-out (fit 2021-24) | games | top-1 | AUC | log loss | Brier | ECE | lead stated/actual |
|---|---|---|---|---|---|---|---|
| **quoted** (JSON `heldout`) | 301 | 49.17% (148) | 0.6751 | 0.4909 | 0.1583 | 0.0195 | 48.3 / 49.2 |
| **reproduced**, 2025 + 2026 Wk 1 | 301 | 49.17% (148) | 0.6751 | 0.4909 | 0.1583 | 0.0195 | 48.3 / 49.2 |
| all to date (2025 + 2026 to 10-12) | 364 | 48.90% (178) | 0.6714 | 0.4915 | 0.1584 | 0.0184 | 48.0 / 48.9 |
| 2025 (reg + post) | 285 | 48.42% | 0.6729 | 0.4895 | 0.1577 | 0.0193 | |
| 2025 postseason only | 13 | 38.5% | 0.6735 | 0.4756 | 0.1515 | 0.0423 | |
| 2026 to date | 79 | 50.63% | 0.6676 | 0.4989 | 0.1614 | 0.0195 | |
| 2026 after export (Wk 2-5) | 63 | 47.62% | 0.6545 | 0.4942 | 0.1590 | 0.0134 | |
| same 63, shipped deployment weights | 63 | 47.62% | 0.6564 | 0.4952 | 0.1596 | 0.0238 | |

Equal to all printed digits (the raw floats are identical). The export's data
cutoff is 2026-09-16 (285 + 16 = 301 games; commit 4473c13).

### College extra-trees — within rounding

The shipped forest JSON **is** the held-out model (export_forest.py fits
`model` on 2021-24 only; the JSON's `trained_seasons: 2021-26` label is
misleading), so it is evaluated directly — a numpy port of `inferForest`,
checked against the TypeScript function itself on all 45,702 priced rows (max
diff 1.7e-16) and against the JSON self-test vectors (the first five test rows
reproduce the stored standardized vectors exactly, diff 0.0).

| held-out | games | slates | rows | top-1 | AUC | log loss | Brier | ECE | pick hit | picks/game | game hit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **quoted** (JSON `holdout`, docs) | 1,130 | 88 | 21,503 | 58.05% (656) | 0.6980 | 0.5069 | — | 0.0096 | 0.5444 | 1.544 | 0.6761 |
| **reproduced**, 2025 + 2026 to 09-12 | 1,131 | 88 | 21,499 | 58.09% (657) | 0.6980 | 0.5071 | 0.1665 | 0.0096 | 0.5449 | 1.545 | 0.6764 |
| same, without the JVST fix (below) | 1,130 | 88 | 21,480 | 58.05% (656) | 0.6980 | 0.5072 | 0.1666 | 0.0096 | 0.5447 | 1.545 | 0.6761 |
| all to date (to 2026-10-10) | 1,393 | 102 | 26,783 | 58.15% (810) | 0.6967 | 0.5073 | 0.1666 | 0.0087 | 0.5495 | 1.531 | 0.6820 |
| 2025 | 953 | 79 | 18,536 | 57.82% | 0.6968 | 0.5071 | 0.1665 | 0.0091 | | | |
| 2026 to date | 440 | 23 | 8,247 | 58.86% | 0.6966 | 0.5077 | 0.1668 | 0.0106 | | | |
| 2026 after export (09-17 →) | 262 | 14 | 5,284 | 58.40% | 0.6913 | 0.5081 | 0.1669 | 0.0052 | | | |

The export's data ran through **2026-09-12** (88 slates; the Elo held-out
count of 1,143 games in CFB-ANALYSIS.md matches this schedule exactly). The
residual gap — 4 rows, 1 game, +0.0002 log loss — is ESPN data drift, not
method (see "Problems"). Training rows: 71,463 here vs 71,461 documented;
train feature means agree to ≤7e-4 relative.

### NFL first-TD (td1) model

The shipped `src/lib/nfl-td1-model.json` (served by `inferMarket("td1")` in
`src/lib/nfl-td-markets.ts`: standardize, sigmoid(w·z + b), 0.95·p + 0.05·base)
is the deployment fit; the held-out 2021-24 bundle is refitted with
export_first_td.py's `fit_bundle` (L2 logistic, C=1) on the anytime candidate
rows with label "this candidate scored the game's first TD". The shrink is
re-picked by its rolling-origin `pick_shrink` → **0.05**, as shipped. Data
check: the deployment refit (2021-24 + 2025 + 2026 Wk 1, 25,749 rows) matches
the shipped JSON to 9e-15 in every weight; intercept and base are identical.

| held-out (fit 2021-24) | games | top-1 | ceiling | AUC | log loss | Brier | ECE | lead stated/actual | slip legs stated/actual |
|---|---|---|---|---|---|---|---|---|---|
| **quoted** (JSON `heldout`) | 301 | 15.61% (47) | 0.9136 | 0.6855 | 0.1908 | 0.0472 | 0.0025 | 16.6 / 15.6 | 17.8 / 16.4 |
| **reproduced**, 2025 + 2026 Wk 1 | 301 | 15.61% (47) | 0.9136 | 0.6855 | 0.1908 | 0.0472 | 0.0025 | 16.6 / 15.6 | 17.8 / 16.4 |
| all to date | 364 | 15.11% (55) | 0.9176 | 0.6867 | 0.1912 | 0.0473 | 0.0043 | 16.5 / 15.1 | 17.9 / 16.4 |
| 2025 | 285 | 15.44% | 0.9298 | 0.6805 | 0.1916 | 0.0474 | 0.0039 | | |
| 2026 to date | 79 | 13.92% | 0.8734 | 0.7116 | 0.1893 | 0.0471 | 0.0065 | | |
| 2026 after export | 63 | 12.70% | 0.9365 | 0.6945 | 0.1929 | 0.0478 | 0.0134 | | |
| same 63, shipped deployment weights | 63 | 12.70% | 0.9365 | 0.6931 | 0.1930 | 0.0478 | 0.0145 | | |

All quoted values match to the last float digit. `ceiling` = share of games
whose first TD went to a board candidate (the rest went to a defender /
returner / non-candidate, or there was no TD). These labels must come from the
core play feed: with labels from the summary's `scoringPlays` the deployment
weights were off by 0.03 and the ceiling read 0.9203, because `scoringPlays`
omitted two Q1 strip-sack fumble-return touchdowns in the quoted window
(401772730, 401872925).

## First touchdown — how the scorer is determined

* **NFL** (`nfl_first_td.csv`, 1,503 games 2021-26): ESPN's core play feed
  for every game — the touchdown play with the lowest `sequenceNumber`, scorer
  = its `scorer` participant id; `offense` when he is also the rusher/receiver.
  This is exactly the shipped model's label source. Checked against the
  summaries: the first TD from the raw summary's drive plays (2024-26) or
  `scoringPlays` (2021-23), name-matched to the box score, gives the same
  athlete in 1,483 of 1,492 games with a TD; the 9 others are name-match
  failures (two Michael Carters on the 2021-22 Jets, laterals, own-fumble
  recoveries). 1,414 offense / 78 defense-special teams / 11 none.
* **College** (`cfb_first_td.csv`, 2,371 games = every raw summary 2024-26):
  from the raw summary — drive plays in sequence order (they include
  touchdowns `scoringPlays` can omit); the scorer's name from the matching
  `scoringPlays` text, matched to the scoring team's box-score athletes; the
  core play feed only where that fails (28 games). 2,254 offense / 114
  defense-special teams / 3 none; every `offense` scorer has a rushing or
  receiving TD in that game's box score (2,254 / 2,254; NFL 1,414 / 1,414).
* `kind` from the summary uses the play type: Rushing/Passing Touchdown (and
  college's plain "Rush" / "Pass Reception" / "Pass Completion") = offense;
  any return, fumble recovery, blocked kick or punt = defense/special teams.

## Data files (all under `data/`, gitignored)

| path | format |
|---|---|
| `raw/nfl/{event_id}.json.gz` | raw ESPN `summary?event=` JSON, gzip — NFL 2024, 2025, 2026 (649 games, 30 MB) |
| `raw/cfb/{event_id}.json.gz` | same, college 2024, 2025, 2026 FBS-scoreboard games (2,371 games, 109 MB) |
| `box/{nfl,cfb}/{event_id}.json` | compact, boxscore-lossless parse of every summary 2021-26 (format in `common.py`): header (season, week, date, neutral, status), per team `{team_id, abbr, home_away, score, athletes{id:{name,jersey}}, categories{passing,rushing,receiving,fumbles,defensive,interceptions,kickReturns,puntReturns,kicking,punting: {keys, athletes:[[id,[cells]]], totals}}, team_stats}`, and `scoring_plays` in game order. Stat cells are ESPN's strings. |
| `nfl_player_box.csv`, `cfb_player_box.csv` | one wide row per (game, team, player) with any offensive/return line: pass_cmp/att/yds/td/int, sacked, rush_att/yds/td/long, rec, tgt (NFL only), rec_yds/td/long, fum, fum_lost, kr_td, pr_td, int_td, def_td (+ season, date, team ids, home_away) |
| `nfl_games.csv`, `nfl_player_games.csv` | the research tables (original columns, + game_type, espn_team_id): games with nflverse closing `home_spread` (ESPN sign) and `total`; one row per player with ≥1 carry/target |
| `nfl_schedule.csv`, `cache/nflverse_games.csv` | nflverse rows used / the full snapshot |
| `games.csv`, `team_games.csv`, `player_games.csv` | college research tables (original columns, + team_id) |
| `cache/sched_{season}.json` | college FBS schedule per season (original format + kickoff_utc, week, season_type) — the Elo replay reads these |
| `nfl_features_all.csv`, `cfb_features_all.csv` | full feature tables, all seasons, all row kinds (`kind` column) |
| `nfl_positions.csv`, `cfb_positions.csv` | player_id → position (source column) |
| `cfb_rosters.csv` | ESPN season rosters 2024-26 for every team on the FBS schedule: season, team_id, player_id, player, position, jersey, experience, group |
| `patches/cfb/401762521.json` | Army-Navy 2025 box rebuilt from ESPN's core API |
| `cfb_feature_constants.json` | league rates used, FBS team set |

Metrics JSON (committable): `results/nfl_metrics.json` (incl. the held-out
bundle's weights), `results/cfb_metrics.json`, `results/nfl_td1_metrics.json`.

## Problems and deviations

* **ESPN query changes.** Date-range scoreboard calls return HTTP 400 and
  `limit` > 500 is silently ignored (25 events come back), so the college
  schedule is read one ET day at a time (`dates=YYYYMMDD&groups=80&limit=500`).
* **Army-Navy 2025 (401762521)** — ESPN's summary now returns empty
  passing/rushing/receiving lists (0 total yards). The shipped data had it
  (2025 test rows: 18,526 without it, 18,536 with it = the documented count).
  Rebuilt from ESPN's core API per-athlete game stats
  (`patch_cfb_boxes.py`); the raw summary is kept as served.
* **Jacksonville State renamed JVST → JXST for 2026** after the export. The
  college pipeline keys teams by abbreviation, so the rename cut its 2026 games
  off from 2025 (no carry-in; its Week-0 game unpriceable). `features_cfb.py`
  maps a 2026 abbreviation back to the same team id's 2025 one (only JXST
  changes). This adds one game (NDSU–JXST, 08-29) to the quoted window, hence
  1,131 vs 1,130 games. Earlier renames (BSU→BOIS etc.) were in the export's
  data and are left alone. Without the fix the window is exactly 1,130 games /
  656 top-1 hits, but 23 rows short.
* **Frozen at the export:** the college league rates (the shipped JSON
  constants — recomputing from today's data gives 0.044595 / 0.084092 /
  0.238167 vs 0.044603 / 0.084072 / 0.238120) and the Elo FBS set (computed on
  schedules ≤ 2026-09-12; 2025 FBS newcomers sit near the ≥4 games/season line).
  With both frozen, every game's features depend only on earlier games, so the
  2026 games after the export are priced as the shipped pipeline would have.
* **Remaining college drift:** 71,463 vs 71,461 train rows and 21,499 vs
  21,503 test rows — small box-score differences ESPN has introduced since;
  the league-rate solve shows the export's player table had 19 more rows / 44
  more receptions / 1 more rushing TD over 2021–2026-09-12.
* **Live-board differences not modelled** (true of the quoted numbers too): the
  research candidate set is conditioned on touching the ball; the live boards
  filter by active roster and use their own odds feed (NFL) / roster season
  totals (CFB).
