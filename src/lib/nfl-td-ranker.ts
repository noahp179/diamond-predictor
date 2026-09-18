/**
 * nfl-td-ranker.ts — the shipped NFL touchdown model.
 *
 * WHAT THIS IS, AND WHY IT IS NOT A CLASSIFIER
 * ---------------------------------------------
 * The board asks one question per game: of the names on this card, which is
 * likeliest to score? That is a comparison WITHIN a game. A classifier fitted
 * on `scored` pooled across every player-game answers a different question —
 * how does any player anywhere compare to any other — and is rewarded for
 * separating a workhorse back from a third-string receiver who will never
 * appear on the same card.
 *
 * This model is trained on the comparison the card actually makes. For every
 * training game it takes one player who scored and one who did not, subtracts
 * their feature vectors, and learns to call the sign of that difference. No
 * intercept: a difference of zero must give even odds.
 *
 * The consequence is visible and intended. Against the logistic it replaced, on
 * seasons neither model was fitted on, its AUC is LOWER (0.675 vs 0.688) and
 * its per-game top-1 is HIGHER (49.2% vs 44.9%). It trades the metric nobody
 * reads for the one on the screen. See research/nfl-td-scorer/rank_study.py.
 *
 * SCORE → PROBABILITY
 * -------------------
 * A ranker emits an unbounded score, and the card sells a percentage. Two
 * monotone steps convert it, and monotone is the whole point: neither can
 * reorder a card, so calibration can never change a pick.
 *
 *   platt    p = sigmoid(a·s + b), fitted on a held-back tail of the training
 *            seasons the ranker inside it never saw.
 *   shrink   blend 20% toward the base rate. Selected by rolling-origin inside
 *            the training seasons (research/nfl-td-scorer/shrink_pick.py), not
 *            by looking at the answer: the raw Platt output overstated its lead
 *            picks by about six points in two of three held-out seasons, and
 *            0.20 is the blend that zeroes that bias on average.
 *
 * Both are applied here so no caller can get an uncalibrated number by
 * accident.
 */
import art from "./nfl-td-ranker.json";

export const FEATURES: string[] = art.features;
export const CONSTANTS = art.constants;

/** The linear spec `explain()` reads. The ranker's coefficients ARE the
 *  within-game discriminating direction, so attributing a pick to the largest
 *  positive contributions is not an approximation here — it is the model. */
export const SPEC = {
  features: art.features,
  coef: art.w,
  mean: art.mean,
  std: art.std,
};

/** Raw features in → calibrated probability out. Standardization, the Platt
 *  mapping and the shrink all live inside, matching export_ranker.py. */
export function inferRanker(x: number[]): number {
  let s = 0;
  for (let i = 0; i < art.w.length; i++) s += art.w[i] * ((x[i] - art.mean[i]) / art.std[i]);
  const p = 1 / (1 + Math.exp(-(art.platt_a * s + art.platt_b)));
  return (1 - art.shrink) * p + art.shrink * art.base;
}

/**
 * Reproduce three vectors the Python fit scored, to the sixth decimal.
 *
 * This is not ceremony. The weights, the two Platt constants, the shrink and
 * the standardizer all crossed a language boundary as decimal text, and a
 * single transposed feature would still produce plausible-looking percentages
 * on the board with nothing to flag them. The check is cheap and it is exact.
 */
export function rankerSelfTest(): { ok: boolean; worst: number } {
  let worst = 0;
  for (const t of art.selftest) worst = Math.max(worst, Math.abs(inferRanker(t.x) - t.p));
  return { ok: worst < 1e-6, worst };
}

/** What the held-out seasons said about the model now running, for the card to
 *  quote. Fitted on 2021-24, measured on 2025-26. */
export const HELDOUT = art.heldout;
