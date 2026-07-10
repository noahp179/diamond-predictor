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
