/**
 * mlb-parlay.ts — assemble the day's parlay from model confidence alone.
 *
 * The rule the card follows:
 *   1. A leg qualifies on CONFIDENCE, never on price. A −1000 favourite belongs
 *      in the parlay if the model is sure; the payout is not an input.
 *   2. No two legs may overlap. If one leg's outcome logically guarantees
 *      another's, only one of them can be in — and it is the harder one, so
 *      long as it still clears the confidence bar. Confident in 6+ strikeouts?
 *      Then 5+ strikeouts is not a separate leg, it is the same bet priced
 *      shorter.
 *
 * Rule 2 is what the IMPLIES graph below encodes. It is real implication, not
 * a correlation heuristic: a home run *is* four total bases, a run batted in
 * and a hit, so a home-run leg swallows all of those for that batter.
 *
 * What this deliberately does NOT do is drop merely *correlated* legs — two
 * different hitters in the same lineup, or a starter's outs and his team's
 * moneyline. Those can all lose together, which is why the card reports the
 * independence assumption instead of pretending it away.
 */

/** Markets never offered, whatever the model says about them. */
export const EXCLUDED_MARKETS = new Set(["outs16"]);

/** A leg must clear this on its own before it can join any slip. */
export const LEG_FLOOR = 0.55;

/**
 * Per-size construction, tuned on the 2026 hold-out
 * (research/mlb-props/parlay_sizes.py).
 *
 * `maxPerGame` is the important one: legs drawn from the same game die
 * together, and capping them beat the uncapped slip in all twelve
 * floor x size combinations tested. A five-leg slip can afford one leg per
 * game; longer slips need two or they cannot be filled on a normal slate.
 *
 * `floor` raises the minimum quality of a leg. It cannot rise indefinitely with
 * length — a fifteen-leg slip has to reach deeper into the board, so its legs
 * are necessarily weaker than a five-leg slip's. That is arithmetic, not a
 * policy choice: the honest ceiling is to make each size as safe as it can be
 * and say plainly that mean leg quality falls as the slip grows.
 */
export const SIZE_RULES: Record<number, { floor: number; maxPerGame: number }> = {
  5: { floor: 0.7, maxPerGame: 1 },
  10: { floor: 0.66, maxPerGame: 2 },
  15: { floor: 0.66, maxPerGame: 2 },
};
const DEFAULT_RULE = { floor: 0.66, maxPerGame: 2 };

/**
 * Measured on the 2026 hold-out (research/mlb-props/parlay_sizes.py): how the
 * realised hit rate compared with the independence product, once one-leg-per-
 * player was enforced. At 5 and 10 legs the plain product is slightly
 * conservative; the 15-leg figure rests on a single winning slip in 128 days,
 * so it is noise and is deliberately not used to flatter the number.
 */
export const SIZE_EVIDENCE: Record<
  number,
  { predicted: number; realised: number; filled: string }
> = {
  5: { predicted: 0.3017, realised: 0.3529, filled: "119/129" },
  10: { predicted: 0.0644, realised: 0.082, filled: "122/129" },
  15: { predicted: 0.0125, realised: 0.0092, filled: "109/129" },
};

/** One candidate leg: a prop pick, or a game the model likes outright. */
export type ParlayCandidate = {
  /** Stable id for the subject the leg is about — a player, or a team+game. */
  subjectId: string;
  subject: string; // display name
  market: string; // "h1", "k6", "moneyline", …
  label: string; // "2+ hits", "6+ strikeouts", …
  prob: number; // calibrated probability the leg hits
  gameId: number;
  matchup: string;
  team: string;
  kind: "batter" | "pitcher" | "game";
  tier?: string | null;
  tierHitRate?: number | null;
  /** Conditions measured to undershoot their stated probability (EDGE-HUNT.md). */
  cautions?: string[];
};

export type ParlayLeg = ParlayCandidate & {
  /** Legs this one swallowed — the same bet at a shorter price. */
  absorbed: { market: string; label: string; prob: number }[];
};

export type Parlay = {
  legs: ParlayLeg[];
  threshold: number;
  /** Product of the leg probabilities — i.e. assuming the legs are independent. */
  combinedProb: number;
  /** Fair American price for that probability, before any book margin. */
  fairPrice: number;
  /** Legs sharing a game, which is where the independence assumption is weakest. */
  correlatedGames: { gameId: number; matchup: string; legs: number }[];
  /** Candidates that cleared the bar but were swallowed by a harder leg. */
  droppedForOverlap: number;
  /** Legs carrying a measured-underperformance caution. */
  cautioned: number;
};

/**
 * `market A implies market B` for the same subject: if A hits, B cannot fail.
 * Only direct edges are listed; the closure is computed below.
 *
 *   hits ladder      4+ ⇒ 3+ ⇒ 2+ ⇒ 1+
 *   total-bases      5+ ⇒ 4+ ⇒ 3+ ⇒ 2+ ⇒ 1+ hit
 *   n hits are at least n total bases, so h2 ⇒ tb2, h3 ⇒ tb3, h4 ⇒ tb4
 *   a home run is four total bases, a hit, an RBI and a run
 *   strikeouts       7+ ⇒ 6+ ⇒ 5+
 */
const IMPLIES: Record<string, string[]> = {
  h4: ["h3", "tb4"],
  h3: ["h2", "tb3"],
  h2: ["h1", "tb2"],
  tb5: ["tb4"],
  tb4: ["tb3"],
  tb3: ["tb2"],
  tb2: ["h1"],
  hr1: ["tb4", "h1", "rbi1", "r1"],
  k7: ["k6"],
  k6: ["k5"],
};

/** Transitive closure of IMPLIES, computed once. */
const CLOSURE: Record<string, Set<string>> = (() => {
  const out: Record<string, Set<string>> = {};
  const visit = (m: string, seen: Set<string>) => {
    for (const next of IMPLIES[m] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      visit(next, seen);
    }
    return seen;
  };
  for (const m of Object.keys(IMPLIES)) out[m] = visit(m, new Set<string>());
  return out;
})();

/** Does market `a` guarantee market `b` for the same subject? */
export function implies(a: string, b: string): boolean {
  return a !== b && (CLOSURE[a]?.has(b) ?? false);
}

const americanPrice = (p: number) =>
  p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);

/**
 * Build the parlay: every candidate at or above `threshold`, with overlapping
 * legs collapsed onto the hardest one that still clears the bar.
 *
 * Ordering note: thresholding happens FIRST, so a leg is only ever swallowed by
 * another leg we are also confident in. A pitcher at 5+ K 82% / 6+ K 73% /
 * 7+ K 60% contributes 6+ at a 65% bar, and 7+ at a 55% bar.
 */
export function buildParlay(
  candidates: ParlayCandidate[],
  threshold: number,
  dropCautioned = false,
): Parlay {
  const qualified = candidates.filter(
    (c) =>
      c.prob >= threshold &&
      !EXCLUDED_MARKETS.has(c.market) &&
      !(dropCautioned && (c.cautions?.length ?? 0) > 0),
  );

  // Group by subject — implication only ever holds within one player or game.
  const bySubject = new Map<string, ParlayCandidate[]>();
  for (const c of qualified) {
    const list = bySubject.get(c.subjectId) ?? [];
    list.push(c);
    bySubject.set(c.subjectId, list);
  }

  const legs: ParlayLeg[] = [];
  let dropped = 0;
  for (const group of bySubject.values()) {
    // Keep the maximal elements of the implication order: a leg survives unless
    // some other qualified leg for this subject guarantees it.
    for (const c of group) {
      const dominator = group.find((o) => implies(o.market, c.market));
      if (dominator) {
        dropped += 1;
        continue;
      }
      const absorbed = group
        .filter((o) => implies(c.market, o.market))
        .map((o) => ({ market: o.market, label: o.label, prob: o.prob }))
        .sort((a, b) => b.prob - a.prob);
      legs.push({ ...c, absorbed });
    }
  }

  // Hardest legs last reads better on a card: lead with what we are surest of.
  legs.sort((a, b) => b.prob - a.prob);

  // UNIQUENESS. Implication collapse is not enough — two legs for one player can
  // be logically independent (1+ hits and 1+ steal) and still be one bet in
  // spirit. A player appears at most once, at their strongest market.
  const seen = new Set<string>();
  const unique: ParlayLeg[] = [];
  for (const l of legs) {
    if (seen.has(l.subjectId)) {
      dropped += 1;
      continue;
    }
    seen.add(l.subjectId);
    unique.push(l);
  }
  legs.length = 0;
  legs.push(...unique);

  const combinedProb = legs.reduce((acc, l) => acc * l.prob, 1);
  const byGame = new Map<number, { gameId: number; matchup: string; legs: number }>();
  for (const l of legs) {
    const g = byGame.get(l.gameId) ?? { gameId: l.gameId, matchup: l.matchup, legs: 0 };
    g.legs += 1;
    byGame.set(l.gameId, g);
  }

  return {
    legs,
    threshold,
    combinedProb,
    fairPrice: legs.length ? americanPrice(combinedProb) : 0,
    correlatedGames: [...byGame.values()].filter((g) => g.legs > 1).sort((a, b) => b.legs - a.legs),
    droppedForOverlap: dropped,
    cautioned: legs.filter((l) => (l.cautions?.length ?? 0) > 0).length,
  };
}

/**
 * A slip of exactly `size` legs — the construction the backtest actually
 * validated. Every player contributes at most one leg, at their most likely
 * market, and the `size` most likely of those make the slip.
 *
 * Two constructions were tested on the 2026 hold-out. Taking each player's
 * SAFEST rung beat taking their longest one on every count: at five legs it hit
 * 31.0% against 20.2%, and at ten 7.0% against 1.6%. Longer rungs pay more per
 * leg and lose far more often than the extra price is worth, so the card builds
 * the safest slip and reports its fair price rather than chasing the payout.
 */
export function buildSizedParlay(
  candidates: ParlayCandidate[],
  size: number,
  dropCautioned = false,
): Parlay {
  const rule = SIZE_RULES[size] ?? DEFAULT_RULE;
  const full = buildParlay(candidates, rule.floor, dropCautioned);
  // Spread the slip across games. full.legs is already sorted by probability
  // and unique per player, so this keeps the best leg from each game first.
  const perGame = new Map<number, number>();
  const legs: ParlayLeg[] = [];
  for (const l of full.legs) {
    const used = perGame.get(l.gameId) ?? 0;
    if (used >= rule.maxPerGame) continue;
    perGame.set(l.gameId, used + 1);
    legs.push(l);
    if (legs.length === size) break;
  }
  const combinedProb = legs.reduce((acc, l) => acc * l.prob, 1);
  const byGame = new Map<number, { gameId: number; matchup: string; legs: number }>();
  for (const l of legs) {
    const g = byGame.get(l.gameId) ?? { gameId: l.gameId, matchup: l.matchup, legs: 0 };
    g.legs += 1;
    byGame.set(l.gameId, g);
  }
  return {
    ...full,
    legs,
    threshold: LEG_FLOOR,
    combinedProb,
    fairPrice: legs.length ? americanPrice(combinedProb) : 0,
    correlatedGames: [...byGame.values()].filter((g) => g.legs > 1).sort((a, b) => b.legs - a.legs),
    cautioned: legs.filter((l) => (l.cautions?.length ?? 0) > 0).length,
  };
}
