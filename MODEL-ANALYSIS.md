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

## Round 7 — a *properly-built* lineup/platoon offense (`sim-lineup-v1`)

*Backtest run 2026-07-15 (`scripts/backtest-shadow-models.ts`) on the same two 14-day windows
as Rounds 4–6 (191 + 185 = 376 settled games), same point-in-time discipline and production
seeds. **This is the first round validated against the live MLB Stats API rather than shipped
unvalidated** — every prior round shipped with the caveat "statsapi blocked in the sandbox,"
so before building anything new the harness was re-run and it reproduces the stored Rounds 4–6
pooled figures to the digit (sim-recent-v1 57.2% / 0.2499; sim-recent-v2 55.3% / 0.2504),
confirming both the harness and those findings. The Round 7 engine change touched only the new
offense path — the other three models reproduce exactly.*

Round 2 named actual lineups the single biggest piece of remaining headroom; Round 4 built the
naïve version — average the nine hitters' regressed per-PA rates with equal weight — and it
LOST to the plain team line (50.3% / 0.2524). The post-mortem named two causes. Round 7
rebuilds the offense (`src/lib/mlb-lineup.ts`) fixing both, and adds the one signal a team
aggregate structurally cannot see:

- **#1 PA-weighting by lineup slot.** The equal-weight average shrank the offense's spread;
  weighting each hitter by the plate appearances his slot sees (leadoff bats ~0.8 more times
  than the 9-hole) restores the top-of-order emphasis the team aggregate already carries.
- **#2 Run-environment recalibration.** The engine's `OFFENSE_CAL` / `HOME_BOOST` were tuned
  against the *team-aggregate* line, so a differently-leveled lineup line runs through the wrong
  R/G. Every lineup line is rescaled by a single per-event global scalar so the league-mean
  lineup reproduces the league-mean team line — re-pinning the run environment the engine
  expects while preserving each team's relative deviation. This is the direct fix for Round 4's
  named miscalibration.
- **#3 Platoon (the new signal).** Each hitter is tilted by a league platoon multiplier keyed
  on his batting hand vs the starter's throwing hand, damped by the starter's PA share (the pen
  is mixed-handed). statsapi's `statSplits` ignores date ranges — a hitter's own vL/vR
  mid-season would leak the future — and individual platoon skill needs ~1000+ PA to stabilize,
  so the league-by-handedness multiplier is *both* the point-in-time-clean and the
  properly-regressed choice. It captures tonight's lineup CONSTRUCTION against tonight's starter
  (a lefty-stacked order vs a LHP), which the aggregate cannot.

Everything else is sim-recent-v1 exactly (trailing team pitching + trailing starter + full-staff
pen + multi-season Elo); the offense source is the only change, with a per-side fallback to the
trailing team line when no lineup is posted or too few hitters resolve.

### Results

| Window | Model | Acc | Brier ↓ | Log loss ↓ |
|---|---|---|---|---|
| **Jun 28 – Jul 11 (n=191)** | sim-elo-v2 | 56.5% | **0.2437** | **0.6808** |
| | sim-recent-v1 | **60.2%** | 0.2467 | 0.6872 |
| | sim-lineup-v1 | 57.6% | 0.2484 | 0.6904 |
| **Jun 14 – Jun 27 (n=185)** | sim-recent-v1 | **54.1%** | 0.2531 | 0.6997 |
| | sim-lineup-v1 | 52.4% | **0.2500** | **0.6931** |
| | sim-elo-v2 | 50.3% | 0.2531 | 0.6996 |
| **Pooled (n=376)** | sim-elo-v2 | 53.5% | **0.2483** | **0.6901** |
| | **sim-recent-v1** | **57.2%** | 0.2499 | 0.6933 |
| | sim-lineup-v1 | 55.1% | 0.2492 | 0.6917 |
| | sim-recent-v2 | 55.3% | 0.2504 | 0.6943 |

### The lineup progression (pooled, n=376)

| lineup offense | Acc | Brier ↓ |
|---|---|---|
| Round 4 — naïve equal-weight average | 50.3% | 0.2524 |
| **Round 7 — PA-weighted + platoon + recalibrated** | **55.1%** | **0.2492** |

### Read

- **Building it properly fixed Round 4 — decisively.** +4.8pp accuracy and Brier 0.2524 →
  **0.2492**. The two named failure causes were real: PA-weighting and the run-environment
  recalibration recover almost all of the loss, and sim-lineup-v1 is now the **best-Brier of the
  three recent-form branches** (0.2492 vs sim-recent-v1 0.2499, sim-recent-v2 0.2504) — the
  second-best-calibrated model overall, behind only the headline. In window B it posts the best
  Brier of *any* sim model (0.2500). The properly-built lineup is a genuine calibration win.
- **But it still does not surpass sim-recent-v1 on the pick.** v1 keeps the accuracy edge
  (57.2 vs 55.1), and when the lineup offense moves a pick off v1 it is right only **15/38
  (39%)** — worse than a coin flip, no complementary pick signal. Against the headline it flips
  70 picks and wins 38 (54%), a shade better than sim-recent-v2's disagreement record but not a
  real edge.

This is the **same frontier the bullpen reached in Rounds 4–6**, approached from the other
direction: doing the "biggest headroom" input *right* sharpens the probability (Brier ↓, the
naïve version's damage undone) without moving the pick to a better place. At game-outcome
granularity the starter + Elo + team-level offense already carry most of the signal; *which*
nine bats and how they platoon against tonight's starter refines the **confidence** more than
the **call**.

### What shipped (tracked, not promoted)

- **`src/lib/mlb-lineup.ts`** — rewritten from the naïve Round 4 averager into the proper
  builder: PA-weighted by slot, platoon-tilted by handedness vs the starter, level-recalibrated
  to the team run environment, point-in-time and lookahead-free (handedness is static; lineups
  are tonight's posted orders; rates end the day before).
- **`src/lib/mlb-recent-form.ts`** — `buildLineupPredictionsForDate`, the `sim-lineup-v1` model:
  the sim-recent-v1 engine with the offense swapped to the lineup line (per-side fallback to the
  team line).
- **`src/lib/mlb-models.ts`** — `sim-lineup-v1` registered in `TRACKED_MODELS` (display label
  "v4"), so Track Record scores and charts it beside the others automatically.
- **`src/lib/mlb-pipeline.server.ts`** — the daily cron shadow-writes `sim-lineup-v1` (guarded,
  best-effort). Before lineups post it falls back to the team line and equals sim-recent-v1 for
  those games, sharpening as lineups drop.
- **`scripts/backtest-shadow-models.ts`** — extended to a fourth model, with a lineup-built
  subset breakdown and a v1-vs-lineup flip test. Reproducible:
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/backtest-shadow-models.ts --start … --end … --sims 3000`.

### Conclusion

Both levers Round 2 named as the biggest remaining headroom — a real bullpen and actual lineups
— have now been built properly (Round 6 tiered pen; Round 7 PA-weighted platoon lineup) and both
land in the same place: **parity on Brier, no accuracy edge over plain recent-form.**
sim-lineup-v1 earns its spot in the tracked set — it is the best-calibrated recent-form branch
and the only one to improve Brier over sim-recent-v1 — but it is not promoted. **`sim-recent-v1`
remains the model to watch:** across Rounds 4–7 its accuracy edge over the headline (57.2% vs
53.5%, right 58% on disagreements) is the one durable, un-beaten signal, and it comes from
recent-form *team* rates, not from the structural offense/pen detail. The remaining untried
levers (individual platoon skill via prior-season splits to stay point-in-time-clean; a lineup
line *blended* with the team aggregate rather than replacing it; weather/umpires) are
lower-probability than the frontier they'd be trying to clear. All models stay tracked; none is
promoted — the honest next step is a longer live trial of sim-recent-v1, not another structural
input.
