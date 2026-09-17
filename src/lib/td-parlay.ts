/**
 * td-parlay.ts — touchdown-scorer slips of 5, 10, 15 and 20 legs.
 *
 * ONE LEG PER GAME
 * ----------------
 * That is the whole construction, and it was measured rather than assumed.
 * research/cfb/parlay.py builds every slip on every held-out Saturday both
 * ways. On 220 identical slates, one leg per game won outright — 18 winning
 * slips against 15 — and, more usefully, its stated probability was honest:
 * 1.02x the independence product, against 0.82x when two legs shared a game.
 *
 * research/cfb/parlay_corr.py says why. Two OPPOSED players in the same game
 * score together only 0.754x as often as independence implies, against a
 * 0.964x control for players in different games. College football is decided
 * by blowouts: in one, the winning side's skill players score and the losing
 * side's do not, so a leg from each team is closer to a coin flip against
 * itself than two independent bets. Two players on the same team come in at
 * 0.954x — indistinguishable from the control — so the goal-line competition
 * everyone expects is not the effect that matters. It is the game script.
 *
 * Since a team plays one game a day, one leg per game caps teams at one free.
 *
 * WHAT THESE SLIPS ARE WORTH
 * --------------------------
 * College, held out on 2025-26 (research/cfb/parlay_final.json):
 *
 *      legs   stated   about     observed
 *         5    24.6%   1 in 4    6 of 19 slips
 *        10     4.4%   1 in 23   0 of 17  (0.7 expected)
 *        15     0.63%  1 in 159  0 of 16  (0.1 expected)
 *        20     0.07%  1 in 1,415  0 of 16  (0.01 expected)
 *
 * The zeroes are not a failure of the model and not evidence the slip works:
 * at ten legs and up the product predicts fewer than one winning slip in the
 * entire held-out period, so there is no sample. A twenty-leg slip is one
 * winning Saturday in fourteen hundred, and college football plays about
 * fourteen Saturdays a year. The page says the number; it does not dress it up.
 *
 * NFL, 2022-24 (research/nfl-td-scorer/parlay_nfl_metrics.json):
 *
 *      legs   stated   observed          buildable
 *         5    6.7%    4 of 53 slips     86% of weeks
 *        10    0.20%   0 of 42           82%
 *        15    0.007%  0 of 4            55%
 *        20    —       —                 never: a week has at most 16 games
 *
 * The NFL's twenty-leg ceiling is arithmetic, not statistics. One leg per game
 * caps a slip at the size of the slate, and no NFL Sunday has twenty games. A
 * slip that long has to double up, so `doubledUp` counts the games that did
 * and the card says what it costs.
 */

export type ParlayCandidate = {
  playerId: string;
  player: string;
  position?: string | null;
  team: string;
  gameId: number;
  matchup: string;
  prob: number;
  tier?: string | null;
  tierHit?: number | null;
  reasons: string[];
  against?: string | null;
};

export type ParlayLeg = ParlayCandidate & {
  /** 1-based position on the slip, surest first. */
  rank: number;
  /** True when this leg shares a game with another — only ever the result of
   *  a slate too small to fill the slip one game at a time. */
  sharesGame: boolean;
  /** True when this leg did not clear the size's floor. */
  belowFloor: boolean;
};

export type TdParlay = {
  size: number;
  legs: ParlayLeg[];
  /** Product of the leg probabilities. Honest at one leg per game; optimistic
   *  by roughly a fifth for each game that had to double up. */
  combinedProb: number;
  /** "about 1 in N". Rounded, because 1 in 1,415.3 is a false precision. */
  oneIn: number;
  /** Fair American price for `combinedProb`, before any book margin. */
  fairPrice: number;
  /** Mean leg probability — the number that falls as a slip gets longer. */
  meanLeg: number;
  /** The weakest leg on the slip. */
  worstLeg: number;
  /** Games contributing two legs, because the slate could not fill the slip. */
  doubledUp: number;
  /** Legs taken below the size's floor, for the same reason. */
  belowFloor: number;
  /** True when the slate could not fill `size` legs at all. */
  short: boolean;
  /** Games on the slate the slip could draw from. */
  gamesAvailable: number;
  floor: number;
};

/**
 * Minimum leg probability per size.
 *
 * The floor only bites at five legs, where being choosier measurably helps: on
 * the held-out seasons a five-leg slip hit 21.4% at a 0.35 floor and 31.6% at
 * 0.55. By ten legs a full Saturday's best twenty picks all clear 0.55 anyway,
 * so the floor stops mattering and the slip is simply the best the board has.
 * It stays lower there so a thin midweek slate can still fill one.
 */
export const SIZE_FLOOR: Record<number, number> = { 5: 0.55, 10: 0.45, 15: 0.45, 20: 0.45 };
export const PARLAY_SIZES = [5, 10, 15, 20];
const DEFAULT_FLOOR = 0.45;

/** Held-out evidence per size, quoted on the card. `observed` is deliberately
 *  kept next to `expected` so a zero cannot be read as a verdict. */
export const SIZE_EVIDENCE: Record<
  string,
  Record<number, { stated: number; oneIn: number; observed: string; note?: string }>
> = {
  cfb: {
    5: { stated: 0.2463, oneIn: 4, observed: "6 of 19 held-out slips" },
    10: { stated: 0.0435, oneIn: 23, observed: "0 of 17 (0.7 expected)" },
    15: { stated: 0.0063, oneIn: 159, observed: "0 of 16 (0.1 expected)" },
    20: { stated: 0.00071, oneIn: 1415, observed: "0 of 16 (0.01 expected)" },
  },
  nfl: {
    5: { stated: 0.0673, oneIn: 15, observed: "4 of 53 weeks, 2022-24" },
    10: { stated: 0.00198, oneIn: 505, observed: "0 of 42 (0.08 expected)" },
    15: { stated: 0.00007, oneIn: 14000, observed: "0 of 4 weeks that could fill it" },
    20: {
      stated: 0,
      oneIn: 0,
      observed: "never buildable one-per-game",
      note: "An NFL week has at most 16 games, so a 20-leg slip has to double up.",
    },
  },
};

const americanPrice = (p: number) =>
  p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);

/**
 * Build one slip.
 *
 * Candidates are taken best-first, each player once, and the constraints are
 * relaxed in the order that costs least, only as far as filling the slip
 * requires:
 *
 *   1. one leg per game, every leg clearing the floor — the construction the
 *      backtest validated, and the only one whose stated probability is honest
 *   2. two legs per game, still clearing the floor — what a twenty-leg NFL slip
 *      needs, since no week has twenty games
 *   3. one per game, reaching below the floor — a thin slate, where the choice
 *      is a weaker leg or a slip that is not the size it claims
 *   4. both at once
 *
 * Whatever it took is reported: `doubledUp` counts games contributing two legs
 * and `belowFloor` counts legs that did not clear the bar. Quietly returning a
 * four-leg "five-leg slip" is the worse failure, so it is the one avoided.
 */
export function buildTdParlay(candidates: ParlayCandidate[], size: number): TdParlay {
  const floor = SIZE_FLOOR[size] ?? DEFAULT_FLOOR;
  const byProb = [...candidates].sort((a, b) => b.prob - a.prob);
  const gamesAvailable = new Set(candidates.map((c) => c.gameId)).size;

  const perGame = new Map<number, number>();
  const seenPlayer = new Set<string>();
  const picked: ParlayCandidate[] = [];

  const passes: [number, number][] = [
    [1, floor],
    [2, floor],
    [1, 0],
    [2, 0],
  ];
  for (const [cap, minProb] of passes) {
    for (const c of byProb) {
      if (picked.length === size) break;
      if (c.prob < minProb) continue;
      if (seenPlayer.has(c.playerId)) continue;
      if ((perGame.get(c.gameId) ?? 0) >= cap) continue;
      seenPlayer.add(c.playerId);
      perGame.set(c.gameId, (perGame.get(c.gameId) ?? 0) + 1);
      picked.push(c);
    }
    if (picked.length === size) break;
  }

  // Surest first. Re-sorting after the two passes matters: a second-pass leg
  // can be stronger than a first-pass one from a thinner game.
  picked.sort((a, b) => b.prob - a.prob);

  const legs: ParlayLeg[] = picked.map((c, i) => ({
    ...c,
    rank: i + 1,
    sharesGame: (perGame.get(c.gameId) ?? 0) > 1,
    belowFloor: c.prob < floor,
  }));

  const combinedProb = legs.reduce((acc, l) => acc * l.prob, 1);
  const doubledUp = [...perGame.values()].filter((n) => n > 1).length;

  return {
    size,
    legs,
    combinedProb: legs.length ? combinedProb : 0,
    oneIn: legs.length && combinedProb > 0 ? Math.round(1 / combinedProb) : 0,
    fairPrice: legs.length ? americanPrice(combinedProb) : 0,
    meanLeg: legs.length ? legs.reduce((s, l) => s + l.prob, 0) / legs.length : 0,
    worstLeg: legs.length ? Math.min(...legs.map((l) => l.prob)) : 0,
    doubledUp,
    belowFloor: legs.filter((l) => l.prob < floor).length,
    short: legs.length < size,
    gamesAvailable,
    floor,
  };
}

/** Every requested size from one candidate pool. */
export function buildTdParlays(
  candidates: ParlayCandidate[],
  sizes: number[] = PARLAY_SIZES,
): TdParlay[] {
  return sizes.map((s) => buildTdParlay(candidates, s));
}
