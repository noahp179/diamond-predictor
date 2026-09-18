/**
 * nfl-td-markets.ts — the two narrow touchdown markets beside the anytime board.
 *
 * Anytime touchdown is the board's main question and runs a within-game pairwise
 * ranker (nfl-td-ranker.ts). These two are different questions on the same
 * eighteen features, and each was fitted and judged on its own terms rather than
 * assumed to want the same model:
 *
 *   td2   two or more touchdowns by one player. 3.7% of candidates manage it.
 *         The ranker LOSES here (13.6% top-1 against the logistic's 14.3%) —
 *         a within-game ranker needs within-game pairs to learn from, and a
 *         market this rare barely supplies any. So this one is a logistic.
 *
 *   td1   the game's first touchdown. Exactly one winner per game, and 5.3% of
 *         the time it is a defender or a returner that no board candidate could
 *         have been. Twenty-four models were compared (research/nfl-td-scorer/
 *         bakeoff_first.py) and NOTHING beat the L2 logistic significantly —
 *         the Poisson led by 0.7 points on four discordant games with a
 *         calibration error of 0.164, which is unusable for a board that
 *         multiplies five stated probabilities together.
 *
 * WHAT THESE NUMBERS ARE NOT. Both markets are long shots and the board says so
 * rather than dressing them up. The best 2+ pick in a game converts about one
 * time in seven; the best first-touchdown pick about one in six. Neither
 * backtest contains a single winning five-leg slip, because at 1 in 2,097 and
 * 1 in 1,620 across seventeen held-out weeks you would not expect one. The
 * evidence line on the card states the expected count next to the observed zero
 * so the zero cannot be read as a verdict.
 *
 * Both are the same arithmetic — standardize, logistic, shrink toward the base
 * rate — so they share one inference path. The shrink is monotone and cannot
 * reorder a card; it was selected by rolling origin inside the training seasons
 * on the legs a SLIP takes, not on the lead pick per game, because these models
 * exist only to fill slips. Tuning td2 on lead picks first left the top of its
 * range understated by 18% per leg, which compounds to 2.3x over five.
 */
import td1 from "./nfl-td1-model.json";
import td2 from "./nfl-td2-model.json";

export type TdMarket = "anytime" | "td1" | "td2";

type Spec = {
  features: string[];
  mean: number[];
  std: number[];
  w: number[];
  intercept: number;
  platt_a?: number;
  platt_b?: number;
  shrink: number;
  base: number;
};

const SPECS: Record<"td1" | "td2", Spec> = {
  td1: td1 as unknown as Spec,
  td2: td2 as unknown as Spec,
};

/** Raw features in, calibrated probability out. Standardization, the logistic,
 *  the optional Platt step and the shrink all live here so no caller can get an
 *  uncalibrated number by accident. */
export function inferMarket(market: "td1" | "td2", x: number[]): number {
  const m = SPECS[market];
  let z = m.intercept;
  for (let i = 0; i < m.w.length; i++) z += m.w[i] * ((x[i] - m.mean[i]) / m.std[i]);
  let p = 1 / (1 + Math.exp(-z));
  if (m.platt_a != null && m.platt_b != null && (m.platt_a !== 1 || m.platt_b !== 0)) {
    const s = Math.log(p / (1 - p));
    p = 1 / (1 + Math.exp(-(m.platt_a * s + m.platt_b)));
  }
  return (1 - m.shrink) * p + m.shrink * m.base;
}

/** The linear spec `explain()` reads, so a leg on these boards carries the same
 *  kind of reasoning the anytime board does — read out of the model's own
 *  coefficients rather than written by hand. */
export const MARKET_SPEC = {
  td1: { features: td1.features, coef: td1.w, mean: td1.mean, std: td1.std },
  td2: { features: td2.features, coef: td2.w, mean: td2.mean, std: td2.std },
};

/** Sizes each market offers. Fifteen and twenty are deliberately absent: at
 *  these base rates a fifteen-leg slip is a number with no meaning attached to
 *  it, and a first-touchdown slip cannot exceed the number of games anyway. */
export const MARKET_SIZES: Record<"td1" | "td2", number[]> = {
  td1: td1.sizes,
  td2: td2.sizes,
};

/** Per-market selection floors, re-derived on each market's own probability
 *  scale — these models top out near 0.37 where the anytime ranker reaches
 *  0.70, so the anytime floors would empty the board. */
export const MARKET_FLOOR: Record<"td1" | "td2", Record<number, number>> = {
  td1: Object.fromEntries(Object.entries(td1.floors).map(([k, v]) => [Number(k), v])),
  td2: Object.fromEntries(Object.entries(td2.floors).map(([k, v]) => [Number(k), v])),
};

/**
 * Legs one game may contribute.
 *
 * For td1 this is 1 and it is STRUCTURAL, not a preference. Exactly one player
 * scores a game's first touchdown — verified across 1,424 games, none has two —
 * so two legs from one game is not a correlated slip but an impossible one, and
 * no multiplicative correction can express that. For td2 two players on one team
 * can both score twice, so it is priced like the anytime board.
 */
export const MARKET_MAX_PER_GAME: Record<"td1" | "td2", number> = {
  td1: td1.maxPerGame,
  td2: 2,
};

/** Correlation correction. td1 has none because one leg per game means every
 *  pair is in a different game, which is the independence case. td2 borrows the
 *  anytime board's factors — its own two seasons contain a handful of
 *  co-scoring pairs, far too few to estimate from, and the mechanism (a finite
 *  goal line, a shared game script) is the same one. */
export const MARKET_PAIR_FACTOR: Record<"td1" | "td2", { sameTeam: number; opposed: number }> = {
  td1: { sameTeam: 1, opposed: 1 },
  td2: (td2 as unknown as { pair_factor: { sameTeam: number; opposed: number } }).pair_factor,
};

export const MARKET_EVIDENCE = {
  td1: td1.size_evidence as Record<string, { stated: number; oneIn: number; slips: number; won: number; expected: number }>,
  td2: td2.size_evidence as Record<string, { stated: number; oneIn: number; slips: number; won: number; expected: number }>,
};

export const MARKET_HELDOUT = { td1: td1.heldout, td2: td2.heldout };

export const MARKET_LABEL: Record<TdMarket, string> = {
  anytime: "Anytime TD",
  td1: "First TD",
  td2: "2+ TDs",
};

/** Reproduce the vectors the Python fit scored. Cheap, and it catches a
 *  transposed feature or a mean paired with the wrong scale — neither of which
 *  throws, and both of which would put plausible percentages on the board. */
export function marketSelfTest(): { ok: boolean; worst: number; n: number } {
  let worst = 0;
  let n = 0;
  for (const [k, art] of [["td1", td1], ["td2", td2]] as const) {
    for (const t of art.selftest) {
      worst = Math.max(worst, Math.abs(inferMarket(k, t.x) - t.p));
      n++;
    }
  }
  return { ok: worst < 1e-9, worst, n };
}
