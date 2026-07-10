// mlb-blend.ts — "odds-blend-v1"
// Confidence in the outcome, combining our model with the real market line.
//
// The Best Odds page ranks picks by how likely they are to WIN, not by how
// much we disagree with the sportsbook. Two views:
//   · market only        p = devigged DraftKings implied probability
//   · odds × model       p = σ((1−w)·logit(sim-elo-v2) + w·logit(market))
//
// The weight was chosen by backtest on the 187 settled games in Supabase
// (2026-05-31 → 2026-06-14, point-in-time features, historical DK lines;
// scripts/backtest-odds-blend.ts):
//
//   Brier ↓          model-only 0.2474 · market-only 0.2470 · blend 0.2467
//   accuracy         model-only 53.5%  · market-only 56.1%  · blend 56.1%
//
// The Brier curve is flat for w ∈ [0.40, 0.80] (all 0.2467) and fitting w
// more aggressively is noise-chasing (split-half argmins flipped 1.0 ↔ 0.0;
// walk-forward refitting scored 0.2478, worse than any fixed mid-range w).
// So the weight is a frozen mid-range constant, not a tuned parameter.
//
// Why the old ranking had to go: ranking by |model − market| edge surfaced
// the games where our model disagreed most with the market — picks whose
// average claimed win probability was 54.0% and which actually won 47.6%
// (top-3/day). Confidence ranking claims ~63% and behaves like it.

export const MODEL_VERSION_BLEND = "odds-blend-v1";

/** Market weight w in the logit blend. Frozen mid-range value; see above. */
export const MARKET_BLEND_WEIGHT = 0.65;

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

/**
 * Home-side win probability blending the model's number with the devigged
 * market's, in logit space.
 */
export function blendWithMarket(
  modelProb: number,
  marketProb: number,
  w: number = MARKET_BLEND_WEIGHT,
): number {
  return sigmoid((1 - w) * logit(clamp01(modelProb)) + w * logit(clamp01(marketProb)));
}

/** Win probability of the favored side — the "confidence in the outcome". */
export function pickProb(homeProb: number): number {
  return Math.max(homeProb, 1 - homeProb);
}
