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
export function buildParlay(candidates: ParlayCandidate[], threshold: number): Parlay {
  const qualified = candidates.filter((c) => c.prob >= threshold);

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
  };
}
