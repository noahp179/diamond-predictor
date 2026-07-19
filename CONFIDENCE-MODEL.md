# A separate confidence model — not the prediction restated

_Run `npx tsx scripts/confidence-model.ts [nba|nfl|both]`. Walk-forward over the
odds datasets (22,109 NBA / 4,327 NFL scored picks), no lookahead; the fitted
layers refit per season on prior seasons only._

**The idea (yours):** today the "confidence" on a card is just the prediction
model's own win probability — which is circular. A _separate_ confidence
algorithm should look at other data and estimate **how likely this particular
pick is to be correct**, without being the prediction algorithm. Then we can
check whether that separate signal sorts the picks better.

**Setup.** The prediction is fixed — the margin-of-victory **Elo pick** (what
the live pages use). The target is simply _did that pick win_. Each confidence
estimator scores every pick; we measure how well it separates the winning picks
from the losing ones with **AUC** (0.5 = useless, 1.0 = perfect) and with
**accuracy at matched coverage** (keep the top X% most-confident picks — whose
top slice wins most).

## Results

**NBA** — the Elo pick is right 66.0% overall.

| Confidence estimator               | AUC       | top 25%   | top 50% | top 75% | uses                           |
| ---------------------------------- | --------- | --------- | ------- | ------- | ------------------------------ |
| **C0 · self-prob (baseline)**      | 0.640     | 81.2%     | 75.3%   | 70.3%   | the Elo prob (circular)        |
| C1 · model agreement               | 0.597     | 72.6%     | 72.3%   | 71.6%   | other models only              |
| **C2 · market-only**               | **0.686** | **84.4%** | 78.0%   | 72.5%   | the market line                |
| C3 · meta (no self, **no market**) | 0.652     | 82.0%     | 75.6%   | 71.2%   | agreement+spread+gap+rest+form |
| C4 · meta (no self, + market)      | 0.685     | 84.1%     | 77.8%   | 72.4%   | ↑ + market                     |
| C5 · meta (+ self, + market)       | 0.685     | 84.2%     | 77.9%   | 72.4%   | everything                     |

**NFL** — the Elo pick is right 64.2% overall.

| Confidence estimator               | AUC       | top 25%   | top 50% | top 75% | uses                           |
| ---------------------------------- | --------- | --------- | ------- | ------- | ------------------------------ |
| **C0 · self-prob (baseline)**      | 0.618     | 77.0%     | 72.2%   | 67.8%   | the Elo prob (circular)        |
| C1 · model agreement               | 0.594     | 70.4%     | 70.2%   | 68.3%   | other models only              |
| **C2 · market-only**               | **0.671** | **81.0%** | 75.5%   | 70.3%   | the market line                |
| C3 · meta (no self, **no market**) | 0.628     | 77.0%     | 72.3%   | 68.8%   | agreement+spread+gap+rest+form |
| C4 · meta (no self, + market)      | 0.666     | 80.1%     | 75.1%   | 69.9%   | ↑ + market                     |
| C5 · meta (+ self, + market)       | 0.665     | 80.3%     | 75.2%   | 70.0%   | everything                     |

## What it says — your instinct was right

1. **A separate confidence signal beats the circular one.** Ranking the Elo
   picks by _something other than the Elo probability_ sorts winners from losers
   better: AUC rises from 0.640 → 0.686 (NBA) and 0.618 → 0.671 (NFL), and the
   top-25%-confidence slice climbs **81.2% → 84.4%** (NBA) and **77.0% → 81.0%**
   (NFL). Same prediction, better-sorted confidence.

2. **The market line is the star ingredient.** The single best confidence signal
   is the **market's own read on the Elo pick** (C2) — i.e. _trust the Elo pick
   more when the betting line also strongly favors that side, less when the line
   disagrees._ The full meta-model (C4/C5) doesn't beat plain C2; it basically
   rediscovers "lean on the market."

3. **Even without the market, a separate confidence helps a little.** The
   market-free meta (C3) — cross-model **agreement**, how tightly the models
   **cluster**, the **rating-gap** magnitude, **rest**, and **form** — edges the
   circular baseline (AUC 0.652 vs 0.640 NBA; 0.628 vs 0.618 NFL). Modest, but
   real, and it needs no odds — so it works on pages that don't fetch a line.

4. **Model agreement _alone_ (C1) is not enough** — it's coarse (only 0/⅙/…/1)
   and actually trails self-prob. Agreement only helps as one input to the meta.

5. **The meta confidence is well-calibrated.** When C5 claims 80%+ it's right
   85% of the time; 70–80% → 73–76%; 60–70% → 63–65%. So its number can be shown
   as an honest "chance this pick is correct."

## The honest caveat

This does **not** beat the market or create an edge — it's a better _confidence
layer on our own pick_. And because the market is the key ingredient, most of
the gain is really "the market is a sharper probability than our model, so use
it to grade our pick." When the line disagrees with the Elo pick, confidence
correctly drops — which is exactly the behaviour you want, and it's why the
top-slice accuracy jumps.

## Recommendation (how to ship it)

Replace the current circular confidence tier with a **separate** one:

- **Where a line is available** (the Best Odds pages already fetch ESPN odds;
  the slate/Recommended pages could too): confidence = the **market's prob for
  our pick** (C2) — trivial to compute, the strongest signal, and calibrated.
  Tiers (Safe/Strong/Lean) would then track real win rate far better.
- **Where no line is fetched:** the market-free meta (C3) as a lighter drop-in —
  a fixed formula over agreement/spread/gap/rest/form — still better than the
  circular baseline.

Say the word and I'll wire the market-informed confidence into the cards (it
means fetching the line on the slate pages, a few extra ESPN calls) and retune
the Safe/Strong/Lean thresholds to the calibration table above.

_(Companion: `MODEL-BAKEOFF.md`, `ACCURACY-BACKTEST.md`, `NBA-NFL-ANALYSIS.md`.)_
