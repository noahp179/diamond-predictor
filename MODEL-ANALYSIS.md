# Model Analysis — baseline-v0.4 vs. alternatives vs. game simulation

*Backtest run 2026-07-03 on the 187 settled games stored in Supabase (2026-05-31 → 2026-06-15).*
*Round 2 (same day): a dev/test protocol — tune on 622 out-of-window games, score the test set once, frozen. The shipped model is `sim-elo-v2`; see "Round 2" below.*

## What was tested

All models were evaluated on the same settled games using **point-in-time features only**
(standings, Elo, pitcher and team stats reconstructed as of the morning of each game —
no lookahead). Pitcher identities came from the prediction rows stored at prediction time,
falling back to the schedule's probable pitchers.

| Model | Type | Description |
|---|---|---|
| `baseline-v0.4` | current | Hand-tuned log-odds blend: team strength (Pythag·W%·L10·split), run diff, home edge, regressed starter ERA, staff ERA, OPS gap, rest, park factor |
| `home-always-54` | baseline | Predict home team at 54% every game |
| `elo` | alternative | FiveThirtyEight-style Elo (K=4, MOV multiplier, +24 home), replayed from 2026 opening day |
| `pythag-log5` | alternative | Regressed Pythagorean expectation, log5 matchup + home edge |
| `logistic-fit` | alternative | Logistic regression (elo/pythag/L10/rest diffs) fitted on 645 pre-window games |
| `mc-sim` | **simulation** | Monte Carlo: 3,000 plate-appearance-level game sims (see below) |
| `ens-sim+elo` | **ensemble** | Logit-average of `mc-sim` and `elo` |

## Results (187 settled games)

| Model | Accuracy | Brier ↓ | Log loss ↓ |
|---|---|---|---|
| **ens-sim+elo** | **57.8%** | **0.2456** | **0.6844** |
| mc-sim | 54.5% | 0.2474 | 0.6888 |
| home-always-54 | 53.5% | 0.2488 | 0.6908 |
| elo | 55.1% | 0.2488 | 0.6908 |
| stored baseline-v0.4 (n=164) | 54.9% | 0.2509 | 0.6988 |
| logistic-fit | 49.2% | 0.2533 | 0.6998 |
| pythag-log5 | 53.5% | 0.2533 | 0.7004 |
| v0.4 port (all 187, point-in-time) | 48.7% | 0.2699 | 0.7401 |

Bootstrap (10k resamples) on Brier difference vs the v0.4 port: `mc-sim` and `ens-sim+elo`
are better with P ≈ 1.00; 90% CIs exclude zero. Split-half check: `ens-sim+elo` is at or
near the top in both halves of the window; v0.4 is last in both. On the 35 games where the
simulator and v0.4 disagreed on the pick, the simulator was right 66% of the time.

## Key findings

1. **The current model does not beat "always pick home."** Its Brier score is worse than
   a constant 54% home prediction. Its confidence is miscalibrated: when it said ≥70%
   home, home teams actually won only ~54% of the time. The hand-tuned coefficients
   stack too many correlated signals (team strength, run diff, staff ERA, OPS all measure
   the same thing), producing overconfident predictions in [0.15, 0.85].
2. **Simulation beats aggregation.** The Monte Carlo simulator, which never sees wins or
   losses — only event rates — was better calibrated and more accurate than every
   algorithmic blend.
3. **Combining orthogonal signals wins.** The simulator (bottom-up run scoring) plus Elo
   (top-down results-based rating) is the best of the 11 strategies tested. They make
   uncorrelated errors, so the logit-average improves on both.
4. Caveat: 187 games is a small sample. The Brier improvements (~0.004–0.005 vs home-always)
   are directionally consistent but should be confirmed live — which is what the shadow
   deployment does.

## The simulator (`src/lib/mlb-sim.ts`, model `sim-elo-v1`)

Plate-appearance-level Monte Carlo, 3,000 sims/game, seeded per game (reproducible):

- Batting team per-PA event probabilities (BB+HBP, 1B, 2B, 3B, HR, SO, out) from season
  counting stats, odds-adjusted by the opposing pitcher's rates relative to league.
- Probable starter (rates regressed to league with a 70-BF prior; innings sampled around
  his regressed outs/start), then the team's full-staff line as bullpen proxy.
- Base-out state machine with realistic advancement, double plays, productive outs.
- Park factor scales hit/HR probabilities; home team gets a small on-base boost.
- Extra innings with the ghost-runner rule; walk-offs end the game immediately.
- Calibrated so a neutral league-average matchup reproduces the actual 2026 environment:
  4.47 runs/team/game and a 53.3% home win rate.

The exported ensemble (`ensembleProb`) is the logit-mean of the sim and Elo probabilities.

## What changed in the codebase

- **`src/lib/mlb-sim.ts`** — new: simulator + Elo + ensemble (shipped as `sim-elo-v2`).
- **`scripts/test-sim.ts`** — new: `bun scripts/test-sim.ts [date]` prints sim/elo/ensemble
  probabilities for a date (read-only).
- **`src/lib/mlb-pipeline.server.ts`** — the daily cron now also writes the sim-elo
  predictions as a shadow model (guarded; baseline ingestion is unaffected), settles
  **all** model versions, and computes daily metrics per model version.
- **`src/lib/mlb.functions.ts`** — dashboard metrics now filter to the baseline model
  version (previously they mixed v0.1–v0.4 together).

## Round 2 — the v2 push (dev/test protocol)

Round 1 selected its winner on the test set itself, which flatters the winning number.
Round 2 fixed the protocol: every candidate change was tuned/selected on a **dev set**
(832 games Apr 15 – Jul 1 outside the test window; final selection on the 622 games from
May 1 with mature stats), then the frozen model was scored **once** on the 187-game test set.

Candidate changes and what the dev ablation showed:

| Change | Dev verdict |
|---|---|
| Multi-season Elo (2024+2025 warm-up, carry 0.75, K=6) | **Kept.** −0.004 log-loss vs single-season Elo; Elo spread widens from ~52–56% to ~44–62% |
| Times-through-order penalty (+6% on-base after 18 BF) + early hook (pulled at 5 runs) | **Kept.** Small but non-negative; better game realism |
| HOME_BOOST recalibration 1.038 → 1.028 | **Kept.** The TTO boost compounds with the home boost; 1.028 restores the neutral home rate to 53.1% (league: 53.25%) and improved dev Brier |
| Bullpen split (relievers = staff − rotation game logs) | **Rejected.** Hurt on dev (~+0.003 log-loss) — the reconstruction is too noisy, and average pen rates ignore leverage-based usage |
| Damped pitcher multiplier (α = 0.7–0.85) | **Rejected.** Helped the sim alone, hurt the ensemble (shrinks the sim's complementary signal) |
| Recent-form batting (65% season ⊕ 35% last-30-days) | **Rejected.** No measurable gain |
| Fitted stacker (logistic on logit(sim), Elo, FIP, L10, rest) | **Rejected.** Walk-forward CV picked the plain sim+Elo blend; extra features added noise on this sample size |

Frozen test-set result (187 games):

| Model | Accuracy | Brier ↓ | Log loss ↓ |
|---|---|---|---|
| **sim-elo-v2 (shipped)** | 55.1% | **0.2471** | **0.6873** |
| home-always-54 | 53.5% | 0.2488 | 0.6908 |
| stored baseline-v0.4 (n=164) | 54.9% | 0.2509 | 0.6988 |

Round 1's ens-sim+elo showed 0.2456 on the same games, but that number was selected
best-of-11 on the test set; 0.2471 under the frozen protocol is the honest headline, and
on the dev set v2 (Brier 0.2463) beats the v1 configuration (0.2466). The differences
between v1 and v2 are within noise on 187 games — the multi-season Elo and the protocol
discipline are the durable wins. `src/lib/mlb-sim.ts` now implements exactly the shipped
configuration as model version `sim-elo-v2`.

### Where the remaining headroom is (in rough order of value)

1. **Actual lineups + player-level projections.** Team aggregates can't see who's in
   tonight's lineup. Using confirmed/projected lineups with regressed player rates (or a
   public projection system) is the single biggest available signal — likely worth
   0.003–0.006 Brier. Needs lineup data infrastructure (lineups post ~1–4h before first pitch).
2. **True bullpen with leverage-aware usage** (closer pitches the 9th of close games) —
   the naive average-pen version measurably hurt; done right it requires per-reliever
   data and usage modeling.
3. **Platoon splits** (team wOBA vs LHP/RHP × starter handedness).
4. **Weather/temperature** (run environment shifts) and umpire assignments.
5. **Reference point:** betting markets sit around Brier ~0.240–0.245 over full seasons.
   sim-elo-v2's honest 0.2471 on a small sample is within striking distance; matching the
   market consistently is the realistic ceiling for any public-data model.

## Recommendation

Track `sim-elo-v2` against `baseline-v0.4` live for 3–4 weeks (the shadow pipeline does
this automatically; compare in `daily_metrics` by `model_version`). If the backtest ordering
holds, promote the ensemble to the headline prediction. The next real upgrade is lineup-level
modeling (see "Where the remaining headroom is" above).

---

## Round 3 — pick ranking & the market blend (`odds-blend-v1`)

*Backtest run 2026-07-10 (`scripts/backtest-odds-blend.ts`) on the 187 settled games in
Supabase (2026-05-31 → 2026-06-14). All sim-elo-v2 probabilities recomputed point-in-time
(Elo replayed to each morning, team/starter rates via `byDateRange` ending the day before,
starter identities from the stored prediction rows); market lines are the historical
DraftKings moneylines via ESPN, devigged. Odds matched for 187/187 games.*

Round 3 asked a different question from rounds 1–2: not "whose probability is best?" but
**"which games should the Best Odds and Recommended pages surface?"** The old Best Odds
page ranked by |model − market| edge — a value-betting framing. The pages now rank by
**confidence in the outcome** (how likely the pick is to win).

### Probability quality (187 games, all with market odds)

| Probability | Accuracy | Brier ↓ | Log loss ↓ |
|---|---|---|---|
| **odds-blend-v1** (w = 0.65 market) | **56.1%** | **0.2467** | **0.6863** |
| market only (devigged DK) | 56.1% | 0.2470 | 0.6868 |
| sim-elo-v2 only | 53.5% | 0.2474 | 0.6879 |
| home-always-54 | 53.5% | 0.2488 | 0.6908 |
| stored baseline-v0.4 (n=164) | 54.9% | 0.2509 | 0.6988 |

The blend `σ((1−w)·logit(model) + w·logit(market))` is never worse than either input and
nominally beats both. The Brier curve is **flat for w ∈ [0.40, 0.80]** (all 0.2467), and
fitting w harder is noise-chasing: split-half argmins flipped 1.0 ↔ 0.0, and walk-forward
refitting scored 0.2478 — worse than any fixed mid-range weight. So w = 0.65 ships as a
frozen constant. A calibration fit on the same window suggests sim-elo-v2 runs somewhat
overconfident (best logit scale a ≈ 0.68), which the market-heavy blend already absorbs;
no separate calibration layer ships on 187 games of evidence.

### Pick strategies (top-3 per day; top-1 in parentheses)

| Strategy | Claimed win prob | Hit rate | Flat 1u ROI |
|---|---|---|---|
| Recommended — model confidence (unchanged) | 63.4% | **64.3%** (64.3%) | +3.6% |
| **New tab 1 — market favorite confidence** | 63.1% | 52.4% (57.1%) | −21.8% |
| **New tab 2 — blended confidence (w=0.65)** | 62.7% | 54.8% (57.1%) | −17.7% |
| Old Best Odds — top |edge| vs market | **54.0%** | 47.6% (42.9%) | −3.6% |

The damning number for the old algorithm is the *claimed* column: ranking by disagreement
surfaced picks that even our own model only gave a 54% chance — coin flips sold as "best
odds" — and they hit 47.6%. The confidence rankings surface ~63% claims that behave like
favorites should. (42-pick samples swing ±15pp; the market-favorite hit rate of 52.4% is
a cold streak for favorites in this window — bucketed market calibration is fine: 0.5–0.6
favorites won 54%, 0.6–0.7 won 63%, 0.7+ won 2/2 — so treat the hit-rate column as noisy
and the claimed/Brier columns as the durable evidence. Favorites' ROI is structurally
negative at DK prices; these are "safest bet" rankings, not +EV promises.)

### What shipped

- **`src/lib/mlb-blend.ts`** — `odds-blend-v1`: logit blend of sim-elo-v2 with the
  devigged market line, w = 0.65, plus `pickProb` (confidence in the outcome).
- **Best Odds page** — two tabs, both ranked by confidence in the outcome:
  *Best Odds* (market's own line) and *Odds × Model* (blended). Cards show blended,
  model, and market probabilities plus the moneyline; result badges score the tab's
  actual pick side.
- **Recommended page** — heroes the single **Best Game** (top-1 by model confidence,
  which hit 64.3% in-window) with runners-up below; ranking unchanged.
- **Track record** — the Best Odds segment is reconstructed with the new blended-confidence
  ranking and scored with the blended probability it displays.
- **`scripts/backtest-odds-blend.ts`** — reproducible backtest harness
  (`npx tsx scripts/backtest-odds-blend.ts`), strictly point-in-time, read-only.

### Caveat that gates the live pages

The daily cron last wrote on **2026-06-15**: `game_odds` is empty and no `sim-elo-v2`
prediction rows were ever persisted (the shadow-write shipped after the cron stopped).
Today/tomorrow pages fall back to live computation and work; the Track Record's Best Odds
segment stays empty until the pipeline (and its odds caching) runs again.

---


## Round 4 — the two headroom bets, folded into the sim-recent line (`sim-recent-v2`)

*Backtest run 2026-07-13 (`scripts/backtest-shadow-models.ts`) on two non-overlapping
14-day windows of real settled games — 191 games (2026-06-28 → 2026-07-11) and 185 games
(2026-06-14 → 2026-06-27), 376 total. Every input is reconstructed strictly point-in-time
from the MLB Stats API (Elo replayed to each morning; all rates end the day before), then
run through the production `simulateMatchup` with the exact per-game seeds the live models
use. Self-contained: no Supabase, no odds.*

Round 2 named the two biggest pieces of remaining headroom — a real bullpen and actual
lineups. Rather than spin those up as separate parallel models, Round 4 folds them into the
**sim-recent** line as its next iteration, and asks one question: does the recent-form model,
upgraded with these inputs, beat the headline `sim-elo-v2`? Three models, one engine,
identical games:

| Model | What changes vs the headline |
|---|---|
| `sim-elo-v2` (headline) | season-to-date team rates + season starter, full-staff pen |
| `sim-recent-v1` | trailing 21/45-day team form + trailing starter (the baseline of the sim-recent line) |
| `sim-recent-v2` | **sim-recent-v1 + a relievers-only bullpen + a lineup-derived offense**, both over trailing windows, each with fallback to the v1 team line |

The two new inputs (`src/lib/mlb-bullpen.ts`, `src/lib/mlb-lineup.ts`) are point-in-time
reconstructions: the pen from the real relief-role arms (active roster as-of the morning,
each pitcher's own trailing line, kept if majority-relief, summed and regressed — *not* the
staff-minus-rotation subtraction Round 2 rejected); the offense from the nine hitters in the
posted batting order, their trailing bats regressed to league and averaged.

### Results

| Window | Model | Acc | Brier ↓ | Log loss ↓ |
|---|---|---|---|---|
| **Jun 28 – Jul 11 (n=191)** | sim-elo-v2 | 57.1% | **0.2439** | **0.6812** |
| | sim-recent-v1 | **60.2%** | 0.2467 | 0.6871 |
| | sim-recent-v2 | 50.8% | 0.2525 | 0.6985 |
| | home-always-54 | 49.2% | 0.2522 | 0.6976 |
| **Jun 14 – Jun 27 (n=185)** | sim-elo-v2 | 50.3% | 0.2531 | 0.6996 |
| | sim-recent-v1 | **54.1%** | 0.2531 | 0.6997 |
| | sim-recent-v2 | 49.7% | **0.2523** | **0.6979** |
| | home-always-54 | 51.4% | 0.2505 | 0.6942 |
| **Pooled (n=376)** | sim-elo-v2 | 53.7% | **0.2484** | **0.6902** |
| | sim-recent-v1 | **57.2%** | 0.2499 | 0.6933 |
| | sim-recent-v2 | 50.3% | 0.2524 | 0.6982 |
| | home-always-54 | 50.3% | 0.2514 | — |

Head-to-head against the headline pick, pooled: **sim-recent-v1 disagreed on 77 games and
was right on 45 (58%)** — a real edge; **sim-recent-v2 disagreed on 73 and was right on only
30 (41%)** — worse than a coin flip.

### Read

**The recent-form window helps; the two headroom inputs, as built here, hurt.**

- **`sim-recent-v1` beats the headline on accuracy** (+3.5pp pooled, and ahead in both
  windows) and picks better than sim-elo-v2 when the two disagree (58%). Its Brier is a hair
  worse (+0.0015) — it lands the pick more often but is slightly less calibrated on the tails.
  That is the genuinely promising result and it is worth continuing to track live.
- **`sim-recent-v2` is a clear negative.** Adding the relievers-only pen and the
  lineup-average offense drops accuracy below both v1 *and* the headline (50.3%), lands the
  worst Brier, and — most damning — when the extra inputs move a pick off the headline they
  are right only 41% of the time. The additions are injecting noise, not signal.

Why the "biggest headroom" backfired:

- **Relievers-only pen (≈ flat-to-negative).** An *average* reliever line still ignores
  leverage — a good pen's best arm throws the highest-leverage outs, which a season/trailing
  mean can't represent — so it trades one flat proxy (full staff) for another. This
  corroborates Round 2 with a cleaner, identity-based reconstruction.
- **Lineup-average offense (negative).** Averaging nine regressed per-PA rates shrinks the
  offense's spread relative to the team aggregate, and the engine's run-environment constants
  (`OFFENSE_CAL`, `HOME_BOOST`) were calibrated against the *team-aggregate* line, so the
  lineup-average line runs through a mildly miscalibrated environment. Simple lineup averaging
  is not, by itself, the free win the headroom note implied.

### What shipped (tracked, not promoted)

- **`src/lib/mlb-recent-form.ts`** — `buildRecentFormV2PredictionsForDate`, the sim-recent-v2
  model: the v1 engine with the pen and offense swapped in over trailing windows, each with
  per-input fallback to the v1 team line.
- **`src/lib/mlb-bullpen.ts` / `src/lib/mlb-lineup.ts`** — the two point-in-time
  reconstruction helpers (relievers-only line; lineup-derived batting), parameterized by a
  trailing window.
- **`src/lib/mlb-models.ts`** — `sim-recent-v2` registered in `TRACKED_MODELS`, scored beside
  sim-recent-v1 and the headline automatically.
- **`src/lib/mlb-pipeline.server.ts`** — the daily cron shadow-writes sim-recent-v2 (guarded,
  best-effort). Lineups feed in when posted at cron time, else the model falls back to team
  batting for that game.
- **`scripts/backtest-shadow-models.ts`** — the reproducible, self-contained backtest
  (`npx tsx scripts/backtest-shadow-models.ts [--start] [--end] [--sims] [--out]`).

Next experiments, if the pen/lineup thread is worth pursuing, are the *non-naïve* versions —
a leverage-aware pen (closer in the high-leverage 9th) and a PA-weighted, platoon-aware,
run-environment-recalibrated lineup — not a re-run of these averages. The durable, positive
finding from Round 4 is simpler: **trailing-window form (sim-recent-v1) out-picks the season
model, and deserves a longer live look.**

---

## Round 5 — a *smart* bullpen, folded into sim-recent-v2 (replacing the naïve v2)

*Backtest re-run 2026-07-13 (`scripts/backtest-shadow-models.ts`) on the same two 14-day
windows as Round 4 (191 + 185 = 376 settled games), same point-in-time discipline and
production seeds.*

Round 4's `sim-recent-v2` (naïve relievers-only pen + lineup-average offense) lost to plain
`sim-recent-v1`. The recommended fixes were all about the bullpen, so v2 was **rebuilt**:
the lineup swap was dropped (offense back on the v1 trailing team line), and the pen was
upgraded from an equal-weight average to a *smart* relievers-only line
(`src/lib/mlb-bullpen.ts`), reconstructed from each reliever's game log (one fetch) so all
three upgrades come for free:

- **#1 Leverage weighting** — each arm scaled by save/hold/close-out usage
  (`saves + holds + ½·gamesFinished`), so the closer and setup men dominate the pen line the
  sim faces late instead of being averaged in with mop-up arms.
- **#3 Fatigue / availability** — weight cut by how many of the last three days the arm
  already pitched (three-in-a-row ≈ zeroed).
- **#6 Peripheral (DIPS) stabilization** — K/BB/HR regressed only lightly toward league; the
  non-HR hit rate (BABIP) regressed hard, so the pen's edge comes from what it controls. (A
  Statcast xwOBA version is the natural next step — baseballsavant is reachable — this is the
  statsapi-native form.)

### Results

| Window | Model | Acc | Brier ↓ | Log loss ↓ |
|---|---|---|---|---|
| **Jun 28 – Jul 11 (n=191)** | sim-elo-v2 | 57.1% | **0.2439** | **0.6812** |
| | sim-recent-v1 | **60.2%** | 0.2467 | 0.6871 |
| | sim-recent-v2 (smart pen) | 57.1% | 0.2495 | 0.6925 |
| **Jun 14 – Jun 27 (n=185)** | sim-recent-v1 | **54.1%** | 0.2531 | 0.6997 |
| | sim-recent-v2 (smart pen) | 52.4% | 0.2531 | 0.6996 |
| | sim-elo-v2 | 50.3% | 0.2531 | 0.6996 |
| **Pooled (n=376)** | sim-elo-v2 | 53.7% | **0.2484** | **0.6902** |
| | sim-recent-v1 | **57.2%** | 0.2499 | 0.6933 |
| | sim-recent-v2 (smart pen) | 54.8% | 0.2513 | 0.6960 |
| | home-always-54 | 50.3% | 0.2514 | — |

For reference, Round 4's *naïve* v2 pooled at 50.3% / 0.2524.

### Read

- **The recommendations clearly helped — over the naïve version.** Smart pen + dropping the
  lineup lifts v2 from 50.3% / 0.2524 to 54.8% / 0.2513 (+4.5pp accuracy). Leverage,
  fatigue and DIPS were directionally right.
- **But the smart pen still does not beat plain recent-form (v1).** v2 is below v1 on both
  accuracy (54.8 vs 57.2) and Brier (0.2513 vs 0.2499), and when the pen swap moved a pick
  off v1 it was right only **15/39 (38%)** — worse than a coin flip. The full-staff line is a
  stubbornly strong pen proxy at game-outcome granularity: relief innings are a minority of a
  game, the starter and team/Elo signals dominate, and isolating ~3–4 pen innings adds little
  real signal and some sampling noise, even weighted well.

**Durable finding (unchanged): `sim-recent-v1` — recent-form with the plain full-staff pen —
is the model to keep watching.** Best accuracy of the three (57.2%, and right 58% when it
disagrees with the headline), Brier within noise of sim-elo-v2. The bullpen thread has now
been tried both naïvely (Round 4) and intelligently (Round 5) and has not cleared the bar; if
it is pursued further, the remaining untried lever is *in-sim tiering* (deploy tiers by
inning/score state, suggestion #2) rather than a better single blended pen line — a single
line, however weighted, is the wrong shape for a signal that only matters in specific
late-game states. All three models stay tracked; none is promoted.

---

## Round 6 — a leverage-TIERED bullpen the sim actually manages (`sim-recent-v2`, 3rd cut)

*Backtest re-run 2026-07-13 (`scripts/backtest-shadow-models.ts`) on the same two 14-day
windows (191 + 185 = 376 settled games), same point-in-time discipline and production seeds.
sim-elo-v2 and sim-recent-v1 reproduce Round 5's numbers to the digit, confirming the engine
change touched only the tiered path.*

Rounds 4–5 established the pen problem is one of **shape**: a single blended pen line — even
leverage-weighted, fatigue-adjusted and DIPS-stabilized — lost to the full-staff proxy,
because the bullpen only matters in specific late-game states and a single line can't express
that. Round 6 gives the pen a depth chart the simulator manages, implementing the best of the
ten suggested upgrades:

- **#1/#2 Leverage tiers + explicit closer** — relievers are ranked by close-out usage
  (`saves + holds + ½·gamesFinished`) and split into **closer / setup / middle**. The sim
  (`src/lib/mlb-sim.ts`, `selectTier`) sends the closer out in the 9th+ of a save/tie, setup
  in the 7th–8th of one-score games, middle otherwise — chosen each half-inning from the
  pitching team's current lead.
- **#3 Fatigue / availability** — the closer tier blends the top two arms availability-
  weighted, so a gassed closer cedes his tier to the backup.
- **#4 Reliever-league prior** — tiers regress toward a reliever-league baseline pooled from
  every rostered reliever that day, not the all-pitching league line.
- **#6 DIPS stabilization** and **#7 recency weighting** carried over from Round 5.

Deferred on purpose: **#5 platoon/handedness** and **#10 IL/transactions** — each roughly
doubles the per-reliever fetch load, and Rounds 4–5 warned against piling unvalidated inputs
on at once; isolate the tiering result first. (#9 innings-to-cover is now implicit — the sim
already samples starter length and the tier is chosen by the resulting game state.)

### Results — the v2 progression

| sim-recent-v2 version | Pooled Acc | Pooled Brier ↓ | Pooled Log loss ↓ |
|---|---|---|---|
| Round 4 — naïve pen + lineup average | 50.3% | 0.2524 | — |
| Round 5 — single smart pen line | 54.8% | 0.2513 | 0.6960 |
| **Round 6 — leverage-tiered pen** | **55.3%** | **0.2504** | **0.6944** |

Per window (Round 6): Jun 28 – Jul 11 — v2 56.5% / 0.2481; Jun 14 – Jun 27 — v2 54.1% / 0.2529.

### Full comparison (pooled, n=376)

| Model | Acc | Brier ↓ | Log loss ↓ |
|---|---|---|---|
| sim-elo-v2 (headline) | 53.7% | **0.2484** | **0.6902** |
| **sim-recent-v1** (recent form, full-staff pen) | **57.2%** | 0.2499 | 0.6933 |
| sim-recent-v2 (leverage-tiered pen) | 55.3% | 0.2504 | 0.6944 |
| home-always-54 | 50.3% | 0.2514 | — |

### Read

- **Getting the shape right worked — monotonically.** Each cut of the bullpen improved v2:
  naïve → smart line → tiered took Brier 0.2524 → 0.2513 → **0.2504** and accuracy 50.3% →
  54.8% → **55.3%**. Tiering is unambiguously the best bullpen build of the three, and it is
  now **within noise of sim-recent-v1 on Brier** (0.2504 vs 0.2499 on 376 games).
- **But it still does not surpass sim-recent-v1.** v1 keeps the accuracy edge (57.2 vs 55.3),
  and when tiering moves a pick off v1 it is right only **13/33 (39%)** — still no
  complementary pick signal. Doing the bullpen *right* essentially recovers what the plain
  full-staff proxy already captured, and no more: at game-outcome granularity relief innings
  are ~a third of the game, the starter + Elo + offense dominate, and *which* tier pitches is
  itself downstream of an uncertain game state, so the extra detail sharpens calibration
  (Brier ↓) without moving the pick.

**Conclusion.** The bullpen thread has now been pushed hard — naïve, smart, and tiered — and
has reached **parity, not superiority**, with the full-staff proxy. This is a diminishing-
returns frontier: the untried pen levers (platoon splits, IL modeling, per-reliever Statcast
xwOBA) are unlikely to clear a bar that three rounds of the largest structural change could
only tie. **`sim-recent-v1` remains the model to watch** — its accuracy edge over the headline
(57.2% vs 53.7%, right 58% on disagreements) is the durable signal across Rounds 4–6, and it
comes from *recent-form team rates*, not the bullpen. If the goal is accuracy, the next
experiment worth running is the properly-built lineup/platoon offense (not the naïve average
that failed in Round 4), or simply promoting sim-recent-v1 to a longer live trial. All three
models stay tracked; none is promoted.

---

## Round 7 — the factor & ensemble expedition (1,102 games, dev/test + walk-forward)

*Study run 2026-07-14. New infrastructure: `scripts/collect-backtest-data.ts` sweeps
Apr 20 → Jul 11 once (84 dates, 1,102 settled games — 3× the Rounds 4–6 sample) and
caches, per game, the three tracked models' components (production seeds, byte-identical
reproduction verified), the devigged DraftKings line (matched for 100% of games), and a
bank of context factors computed point-in-time: rest days, games-in-last-7, last-10 win%,
win streak, trailing-30d run differential, road-trip length, starter rest, starter
last-3-starts form, day/night. `scripts/analyze-models.ts` then evaluates candidates as
pure math. Protocol: every weight/coefficient fit on **dev** (Apr 20 – Jun 13, 726 games),
scored **once** on the frozen **test** window (Jun 14 – Jul 11 — the exact 376 games
Rounds 4–6 reported on), and finalists re-scored **walk-forward** (refit on all prior
games before every date, 947 predictions) — the most honest number here.*

The brief: build algorithms on top of the existing models, hunt for unique factors, and
question everything — including the models already believed good.

### What was tested

Blends of the tracked models (v1×v2, v2×v3, v1×v2×v3, re-weighted sim×Elo), a
trailing-30d Pythagorean log5 leg, a logistic "offset" layer adding the schedule/context
factors on top of v2, a full fitted stacker (sim + Elo logits + all factors), a 3-logit
ensemble (blend + calibration in one fit), per-model temperature calibration, and market
blends.

### Results (headline rows)

| Model | Dev acc / Brier | Test acc / Brier | Walk-fwd acc / Brier |
|---|---|---|---|
| market (devigged DK) | 56.3% / 0.2453 | 57.7% / 0.2452 | 56.6% / **0.2449** |
| v1 (sim-elo-v2) | 53.4% / 0.2462 | 53.5% / 0.2483 | 54.0% / **0.2460** |
| v1 + temperature (a=0.75) | 53.4% / 0.2458 | 53.5% / 0.2476 | 54.0% / 0.2462 |
| **v2 + temperature (a=0.60) → ships as v4** | 52.8% / 0.2467 | **57.2% / 0.2479** | **55.1% / 0.2472** |
| v2 (sim-recent-v1) | 52.8% / 0.2480 | 57.2% / 0.2499 | 55.1% / 0.2480 |
| blend v1×v2 (w refit) | — | — | 54.2% / 0.2465 |
| full stacker (sim, elo, factors) | 54.7% / **0.2441** | 55.9% / 0.2471 | 53.0% / 0.2512 |
| v2 + schedule offset layer | 54.0% / 0.2457 | 55.9% / 0.2486 | 54.8% / 0.2516 |
| 3-logit ensemble | 51.9% / 0.2457 | 54.0% / 0.2480 | 52.9% / 0.2482 |
| pythag-30 log5 leg (alone) | 52.6% / 0.2591 | 52.9% / 0.2574 | — |
| v3 (sim-recent-v2) | 52.9% / 0.2483 | 55.6% / 0.2505 | — |
| home-always-54 | 51.9% / 0.2501 | 50.3% / 0.2514 | — |

### The five findings

1. **v2's celebrated +3.5pp accuracy edge was partly window luck.** On dev (726 earlier
   games) v1 out-picks v2 (53.4% vs 52.8%) and out-scores it (0.2462 vs 0.2480); on the
   947-game walk-forward v2's edge is +1.1pp accuracy with *worse* Brier. The durable
   picture is a trade-off, not a champion: **v1 is the best-calibrated model, v2 the best
   picker**, and neither dominates. Rounds 4–6's frozen window flattered v2.
2. **Fitted machinery loses out-of-sample — again.** The full stacker posts the best dev
   *and* test Briers (0.2441 / 0.2471), then collapses to 0.2512 on walk-forward — worse
   than everything it was built from. The offset layer and 3-logit ensemble do the same.
   Round 2 rejected a fitted stacker at n=187; Round 7 re-confirms it at n=947 with far
   more features. Fixed-weight blends beat fitted weights at this sample size, every time.
3. **The context factors are a dead end.** Rest, fatigue, streaks, L10, road trips,
   starter rest, starter recent form, day/night: standardized coefficients all land in
   [−0.14, +0.09] with unstable signs, and adding them *hurts* walk-forward (0.2480 →
   0.2516). The simulator + Elo already price everything these public schedule signals
   carry. The trailing-Pythagorean leg is equally subsumed (its optimal blend weight into
   v2 is 0.0).
4. **Temperature calibration is the one free win.** Both models run overconfident —
   dev-fit shrink factors a=0.75 (v1) and a=0.60 (v2), stable under walk-forward
   refitting. Shrinking v2's probabilities toward 50% in logit space changes **zero
   picks** (the favored team is preserved by construction) and improves its Brier on dev,
   test (0.2499 → 0.2479) and walk-forward (0.2480 → 0.2472). It also closes most of
   v2's calibration gap to v1 while keeping v2's accuracy lead.
5. **The market is still the ceiling** (walk-forward 0.2449). Blending v2 into it at 20%
   ties the market (0.2451–0.2452 test) — no public-data model here adds real information
   to the line. The shipped odds-blend-v1 (v1×market, w=0.65) tests within noise of
   optimal; no change warranted.

### What ships (tracked, not headline)

- **`sim-recent-cal-v1` — displayed as "v4"**: v2's prediction with calibrated confidence,
  `p' = σ(0.60·logit(p))`, a frozen from dev. Same favored team as v2 on every game;
  honest probabilities. Derived in the daily cron from v2's own build (no extra fetches)
  and registered in `TRACKED_MODELS`, so it is stored, settled, scored and charted like
  every other model. It is deliberately **not** a fourth bar on the game cards — its pick
  duplicates v2's, so a card bar would be redundant; Track Record is where it proves out.
- **`scripts/collect-backtest-data.ts` / `scripts/analyze-models.ts`** — the reusable
  study harness (collect once ≈ 3 min thanks to a cross-date game-log cache; analysis is
  pure math over the cache and runs in seconds). Future candidate models start from here.

### Where this leaves the roadmap

The cheap structural ideas are now exhausted: bullpen construction (Rounds 4–6), schedule
context, run-differential legs, fitted ensembles (Round 7) all fail to beat what sim+Elo
already knows. The two experiments still plausibly worth real money are the ones that add
*new information*, not new arithmetic: a properly-built lineup/platoon offense
(PA-weighted, handedness-aware, environment-recalibrated — not Round 4's naïve average)
and weather/park-day effects. Meanwhile the honest live question is simply whether v2's
accuracy edge and v4's calibration hold on games none of us have seen — which is exactly
what the Track Record page now measures.

---

## Round 8 — the edge hunt: five attacks on the sportsbook line (verdict: no edge)

*Study run 2026-07-14. Market sample extended with a light early-season collector
(`scripts/collect-market-history.ts`) to **1,429 games with stored DraftKings lines**
(Mar 26 → Jul 11; ESPN purges prior-season odds, so 2025 was unavailable). All five
attacks in `scripts/hunt-edge.ts`. Pre-committed bar for claiming an edge: walk-forward
ROI > 0 with a 90% bootstrap CI excluding zero AND the same sign in both date-halves —
or walk-forward Brier ≤ market − 0.001.*

**1 · Devig shootout.** Proportional (shipped) 0.2464 Brier vs power 0.2466 vs Shin
0.2476 on 1,429 games. The simple normalization is already the best transform of the
book's own numbers — no free win from fancier vig removal. Shipped code stays.

**2 · Bias scan.** Nine classic pockets (favorite/underdog levels, home/away, day/night,
coin flips): every flat-bet ROI is negative or CI-straddles zero. The only two CIs that
exclude zero are *negative* — home favorites −5.5% [−10.0, −1.0] and home sides at night
−8.0% [−13.5, −2.0] — which is the vig plus this season's weak home-field showing, not an
exploitable bias (the mirror bets net ≈ −1% after vig). No pocket survives split-half.

**3 · Dixon-Coles.** The time-decayed attack/defense Poisson family that historically
found soccer-market edges, ported to MLB and refit walk-forward daily (dev-selected: no
decay, heavy temperature a=0.4 — raw Poisson is overconfident). Test Brier **0.2493** vs
market 0.2459 and our own sims ~0.248. Without pitcher information it is strictly
dominated; as a residual feature its coefficient is −0.037 (nothing).

**4 · The residual information test — the decisive one.** Walk-forward logistic with the
market as a fixed offset and everything we have as features (v1/v2/Elo/DC disagreement
with the line, sim spread, rest, starter rest): market alone **0.2463**; market plus our
signals **0.2479**. Adding our full information set makes the market *worse* — every
coefficient lands in ±0.09 standardized (noise). The line already prices everything this
codebase knows.

**5 · Betting rules.** Vig-inclusive EV thresholds (t = 0, 0.03, 0.06) for v1, v2, v4 and
DC — twelve rules, 328–840 bets each: every 90% CI straddles zero (best nominal: v4 at
t=0.06, +1.7% [−8.0, +11.2] — one of twelve, i.e., exactly what multiple comparisons
predict). Nothing meets the bar.

### Verdict

**No edge found, on any front.** The pre-committed bar was met by zero of the five
attacks. The book's ~4.5% vig is the moat: even a model that ties the market on
probability quality (our blends do) loses ~4–5% betting into it. Honest scope caveats:
one book (DK via ESPN), one line snapshot per game (near-closing), one season window
(n=1,429), and no access to the places real edges live — line-shopping across books,
opener-vs-closer timing, and injury/lineup news latency. Within what public data can see,
this market is efficient.

### What this round leaves behind

- `scripts/collect-market-history.ts` + `scripts/hunt-edge.ts` — a permanent, reusable
  edge-testing harness with the honesty guardrails built in (bootstrap CIs, split-half,
  pre-committed bar). Any future "I think X beats the book" starts as one function here.
- Nothing ships to the product; the pipeline is untouched. The tracked models (v1–v4)
  remain the honest offering: probability quality on par with the market, no betting
  claims.

---

## Round 9 — the last two untried signals: real lineups and weather (verdict: parity and nothing)

*Study run 2026-07-14. Collector extended (`--lineup --weather`): the smart lineup offense
rebuilt in `src/lib/mlb-lineup.ts` and per-game weather (open-meteo, one call per park for
the whole span), swept over the same 1,102 games with production seeds (v1/v2/v3 reproduce
exactly). Analysis: `scripts/analyze-round9.ts`, usual dev / frozen-test / full-span
protocol. Ship bar unchanged: beat v2 on BOTH accuracy and Brier on the frozen test.*

**The lineup model, done properly this time.** Round 4's naïve lineup average lost badly;
this rebuild fixed its three specific failures: **PA weighting** by batting-order slot
(leadoff ~4.65 PA/game → ninth ~3.81), **platoon adjustment** vs the starter's hand (fixed
league-norm multipliers scaled to the starter's ~60% PA share; handedness from the people
API — static facts, no lookahead), and **environment normalization** (each slate's lines
re-centered so the league mean matches the team-line league mean — self-normalizing, no
fit). Lineups resolved for **100% of games**.

| Model | Dev acc / Brier | Test acc / Brier | Full-span acc / Brier |
|---|---|---|---|
| v2 (recent form, team offense) | 52.8% / 0.2480 | **57.2%** / 0.2498 | **54.3%** / 0.2486 |
| **v5 (lineup + platoon)** | 52.1% / 0.2486 | 55.3% / **0.2486** | 53.2% / 0.2486 |
| v5 no-platoon | 51.7% / 0.2487 | 54.8% / 0.2496 | 52.7% / 0.2490 |
| v5 + temperature (a=0.60) | 52.1% / 0.2474 | 55.3% / 0.2476 | 53.2% / 0.2475 |
| market | 56.4% / 0.2451 | 58.0% / 0.2439 | 57.0% / 0.2447 |

The rebuild works as engineering: v5 goes from clearly-worse (Round 4) to **dead parity**
with the team-aggregate offense (full-span Brier identical to four decimals), with better
calibration (test log loss 0.6905 vs 0.6933) but fewer winners picked (44% on changed
picks). The platoon constants are directionally right (−0.0004 Brier vs no-platoon) but
tiny. **Ship bar not met** — and the "actual lineups are the single biggest available
signal" hypothesis from Round 2's headroom list is now *refuted at the moneyline level*:
who's in the lineup is almost entirely priced into the team's trailing aggregates already.

**Weather.** Temperature and wind at first pitch (roofed parks zeroed), tested as
walk-forward residual features on top of the market — using **observed** weather, an upper
bound on anything a forecast could offer. Market alone 0.2447; market + weather + v5
signal 0.2476 (worse); standardized coefficients ±0.02 (noise). Weather carries no
moneyline information the line misses. Definitive negative; totals markets (not stored
here) are where weather signal lives, if anywhere.

### Where this leaves the program

Rounds 4–9 have now systematically resolved every public pre-game signal this codebase
can reach: bullpen structure (naïve → smart → tiered: parity), schedule/context factors
(nothing), run-differential model families (dominated), fitted ensembles (lose
out-of-sample), market biases and vig math (none exploitable), real lineups (parity),
platoon (tiny positive, kept inside v5's construction), and weather (nothing). The
tracked models sit at the public-data frontier, ~0.003–0.004 Brier behind the market —
the gap being precisely the private information the market embeds (injury news latency,
sharp order flow, line movement). Nothing promotes this round; v5 stays a study artifact
(`mlb-lineup.ts` is production-quality if a lineup-aware display model is ever wanted).
The honest next frontier is not another algorithm — it is *data the market prices late*,
which public APIs do not carry.
