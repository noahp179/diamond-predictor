/**
 * td-parlay.ts — touchdown-scorer slips of 5, 10, 15 and 20 legs.
 *
 * STACKING A GAME IS PRICED, NOT BANNED
 * -------------------------------------
 * How many legs may come from one game is the caller's choice. What is not
 * negotiable is that the number next to the slip stays honest, and legs from
 * the same game do not behave independently, so the plain product is wrong for
 * them.
 *
 * research/cfb/parlay_corr.py measured it over every pair of candidates on
 * every held-out slate:
 *
 *      relationship          pairs   both scored   product   vs control
 *      same team               515        30.49%    31.95%        0.989
 *      same game, opposed      267        22.85%    30.29%        0.782
 *      different games      14,543        37.16%    38.53%        1.000
 *
 * The control is the important column: pairs from different games come in at
 * 0.964 of their product, so the model is very slightly optimistic across the
 * board, and the same-game numbers are read against that rather than against
 * 1.0. Doing so leaves the same-team effect at 0.989 — nothing — and the
 * opposed effect at 0.782, which is large.
 *
 * That is the opposite of the intuition. Two backs competing for one goal line
 * barely matter. What matters is the GAME SCRIPT: college football is decided
 * by blowouts, and in a blowout the winning side's skill players score while
 * the losing side's do not, so a leg from each team is close to a bet against
 * itself.
 *
 * So `adjustedProb` multiplies the product by 0.989 per same-team pair and
 * 0.782 per opposed pair. research/cfb/parlay_stack.json checks that against
 * real slips, and at five legs — the only size with enough wins to check — it
 * lands: predicted 0.89 against measured 0.90 at two legs per game, 0.86
 * against 0.89 at three, 0.84 against 0.88 uncapped.
 *
 * The honest limit of it: a per-pair factor multiplied over many overlapping
 * pairs is a first-order approximation, and it was validated at slips carrying
 * well under one opposed pair. A twenty-leg slip drawn from one game after
 * another carries thirteen, where the same arithmetic says 0.03 and nobody has
 * checked. `extrapolated` marks those slips so the page can say so.
 *
 * WHAT THESE SLIPS ARE WORTH
 * --------------------------
 * College, held out on 2025-26, against the calibrated extra-trees model
 * (research/cfb/export_forest.py):
 *
 *      legs   stated   about       observed
 *         5    19.1%   1 in 5        6 of 21 slips (4.0 expected)
 *        10     3.2%   1 in 31       1 of 17 (0.5 expected)
 *        15    0.42%   1 in 240      0 of 16 (0.07 expected)
 *        20   0.042%  1 in 2391     0 of 16 (0.01 expected)
 *
 * The five-leg row is the only one with a real sample, and it landed: six wins
 * against four expected. Below that there is nothing to learn — at fifteen legs
 * and up the product predicts well under one winning slip across the entire
 * held-out period, so a zero is arithmetic rather than evidence. A twenty-leg
 * slip is one winning Saturday in about two and a half thousand, and college
 * football plays roughly fourteen a year. The page says the number.
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
  /** Plain product of the leg probabilities — what independence would imply. */
  combinedProb: number;
  /** The product corrected for same-game correlation. This is the number the
   *  card leads with, because it is the one that survived the backtest. */
  adjustedProb: number;
  /** "about 1 in N", from `adjustedProb`. Rounded — 1 in 1,415.3 is a false
   *  precision. */
  oneIn: number;
  /** Fair American price for `adjustedProb`, before any book margin. */
  fairPrice: number;
  /** Same-game pairs on the slip, which is what the correction is applied to. */
  stackedPairs: { sameTeam: number; opposed: number };
  /** How much the correction moved the number: adjustedProb / combinedProb. */
  correlationFactor: number;
  /** True when the slip carries more opposed pairs than the correction was
   *  validated on, so the adjustment is an extrapolation rather than a
   *  measurement. */
  extrapolated: boolean;
  /** Legs per game this slip was allowed. */
  maxPerGame: number;
  /** Mean leg probability — the number that falls as a slip gets longer. */
  meanLeg: number;
  /** The weakest leg on the slip. */
  worstLeg: number;
  /** Games contributing more than one leg. */
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
 * Minimum leg probability per size, PER SPORT.
 *
 * A floor is a threshold on a probability SCALE, and the two boards no longer
 * share one. College runs a calibrated extra-trees model reaching into the 0.8s;
 * the NFL ranker shrinks 20% toward a 0.214 base rate and tops out near 0.70.
 * The college numbers applied to NFL probabilities are not the same bar — they
 * are a higher one, and carrying them across silently emptied the NFL board:
 * nineteen buildable five-leg weeks became four, and fifteen and twenty legs
 * became unbuildable outright.
 *
 * cfb  the floor only bites at five legs, where being choosier measurably
 *      helps: on the held-out seasons a five-leg slip hit 21.4% at a 0.35 floor
 *      and 31.6% at 0.55. By ten legs a full Saturday's best twenty picks all
 *      clear 0.55 anyway, so the floor stops mattering and the slip is simply
 *      the best the board has. It stays lower there so a thin midweek slate can
 *      still fill one.
 *
 * nfl  re-derived on the training seasons under the deployed ranker by
 *      research/nfl-td-scorer/floor_pick.py: the highest floor at each size
 *      that still fills 70% of the weeks with enough games to fill it at all.
 *      The floors fall with size because a Sunday has at most sixteen games and
 *      a twenty-leg slip has to reach further down the board by construction.
 */
export const SIZE_FLOOR: Record<string, Record<number, number>> = {
  cfb: { 5: 0.55, 10: 0.45, 15: 0.45, 20: 0.45 },
  nfl: { 5: 0.45, 10: 0.4, 15: 0.35, 20: 0.3 },
};
export const PARLAY_SIZES = [5, 10, 15, 20];
const DEFAULT_FLOOR = 0.45;

/**
 * Legs allowed from one game by default.
 *
 * Two, not one. One is the only setting that needs no correlation correction,
 * but it is also a restriction on what a slip can be — a reader who wants two
 * names out of a shootout should have them, and `adjustedProb` prices that
 * honestly. The selector goes up to unrestricted.
 */
export const DEFAULT_MAX_PER_GAME = 2;
export const MAX_PER_GAME_CHOICES = [1, 2, 3, Infinity];

/** Held-out evidence per size, quoted on the card. `observed` is deliberately
 *  kept next to `expected` so a zero cannot be read as a verdict. */
export const SIZE_EVIDENCE: Record<
  string,
  Record<number, { stated: number; oneIn: number; observed: string; note?: string }>
> = {
  cfb: {
    5: {
      stated: 0.1907,
      oneIn: 5,
      observed: "6 of 21 held-out slips (4.0 expected)",
    },
    10: {
      stated: 0.0321,
      oneIn: 31,
      observed: "1 of 17 (0.5 expected)",
    },
    15: {
      stated: 0.00417,
      oneIn: 240,
      observed: "0 of 16 (0.07 expected)",
    },
    20: {
      stated: 0.000418,
      oneIn: 2391,
      observed: "0 of 16 (0.01 expected)",
    },
  },
  nfl: {
    5: {
      stated: 0.063181,
      oneIn: 16,
      observed: "2 of 19 held-out weeks (1.20 expected)",
    },
    10: {
      stated: 0.00121439,
      oneIn: 823,
      observed: "0 of 19 held-out weeks (0.02 expected)",
    },
    15: {
      stated: 0.0000096017,
      oneIn: 104148,
      observed: "0 of 19 held-out weeks (0.00 expected)",
    },
    20: {
      stated: 0.000000036101,
      oneIn: 27700328,
      observed: "0 of 18 held-out weeks (0.00 expected)",
      note: "An NFL week has at most 16 games, so a 20-leg slip has to double up.",
    },
  },
};

/**
 * Measured per-pair correction, read against the different-games control,
 * PER SPORT — because the two sports disagree about the interesting one.
 *
 * cfb  re-measured on 2026-09-17 against the calibrated extra-trees model that
 *      replaced the logistic (research/cfb/export_forest.py). Both factors
 *      moved, and the control moved most: it was 0.964 under the logistic and
 *      is 0.990 now, which is the calibration working — independent pairs
 *      multiply almost exactly right. Against that control the same-team
 *      penalty is real where it used to be nothing (0.842 against 0.989), and
 *      the opposed penalty is essentially unchanged (0.758 against 0.782).
 *
 * nfl  measured on the held-out seasons under the ranker
 *      (research/nfl-td-scorer/export_ranker.py). Control 1.015 — the closest
 *      to exactly independent either board has produced.
 *
 * The same-team penalties agree almost exactly (0.842 college, 0.826 NFL): two
 * backs splitting one goal line is the same problem in both codes. The OPPOSED
 * factors do not, and the gap is large — 0.758 college against 0.883 NFL. Two
 * scorers on opposite sides of a college game are strongly anti-correlated
 * because college games are decided by blowouts, and a blowout is one team
 * scoring five times and the other none. NFL games stay close, both offences
 * keep taking meaningful snaps, and the penalty for taking one from each side
 * is correspondingly milder. Applying college's 0.758 to an NFL slip would have
 * under-priced every opposed pair on the card.
 */
export const PAIR_FACTOR: Record<string, { sameTeam: number; opposed: number }> = {
  cfb: { sameTeam: 0.842, opposed: 0.758 },
  nfl: { sameTeam: 0.826, opposed: 0.883 },
};
const DEFAULT_PAIR_FACTOR = PAIR_FACTOR.cfb;

/**
 * Opposed pairs beyond which the correction is extrapolating. The slips it was
 * checked against carried well under one; past a handful, multiplying a
 * per-pair factor over pairs that heavily overlap stops being a first-order
 * approximation of anything measured.
 */
const VALIDATED_OPPOSED_PAIRS = 3;

/** Same-game pairs on a slip, split by whether the two are opposed. */
function countStackedPairs(legs: ParlayCandidate[]): { sameTeam: number; opposed: number } {
  let sameTeam = 0;
  let opposed = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (legs[i].gameId !== legs[j].gameId) continue;
      if (legs[i].team === legs[j].team) sameTeam += 1;
      else opposed += 1;
    }
  }
  return { sameTeam, opposed };
}

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
 * Whatever it took is reported: `doubledUp` counts games contributing more than
 * one leg and `belowFloor` counts legs that did not clear the bar. Quietly
 * returning a four-leg "five-leg slip" is the worse failure, so it is avoided.
 *
 * `maxPerGame` is the caller's choice — one keeps the product honest with no
 * correction at all, and anything higher is priced by `adjustedProb` instead of
 * refused. Infinity is allowed and means "take the best legs on the board,
 * wherever they come from".
 */
export function buildTdParlay(
  candidates: ParlayCandidate[],
  size: number,
  maxPerGame = DEFAULT_MAX_PER_GAME,
  sport = "cfb",
): TdParlay {
  const floor = SIZE_FLOOR[sport]?.[size] ?? DEFAULT_FLOOR;
  const pair = PAIR_FACTOR[sport] ?? DEFAULT_PAIR_FACTOR;
  const byProb = [...candidates].sort((a, b) => b.prob - a.prob);
  const gamesAvailable = new Set(candidates.map((c) => c.gameId)).size;

  const perGame = new Map<number, number>();
  const seenPlayer = new Set<string>();
  const picked: ParlayCandidate[] = [];

  // Relax in the order that costs least: fill at the requested cap and floor
  // first, then widen the cap by one, then reach below the floor, then both.
  // Widening past the caller's cap only ever happens when the slate is too
  // small to fill the slip — an NFL week has no twenty games.
  const wider = Number.isFinite(maxPerGame) ? maxPerGame + 1 : maxPerGame;
  const passes: [number, number][] = [
    [maxPerGame, floor],
    [wider, floor],
    [maxPerGame, 0],
    [wider, 0],
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
  const stackedPairs = countStackedPairs(picked);
  const factor = pair.sameTeam ** stackedPairs.sameTeam * pair.opposed ** stackedPairs.opposed;
  const adjustedProb = legs.length ? combinedProb * factor : 0;

  return {
    size,
    legs,
    combinedProb: legs.length ? combinedProb : 0,
    adjustedProb,
    oneIn: adjustedProb > 0 ? Math.round(1 / adjustedProb) : 0,
    fairPrice: legs.length ? americanPrice(adjustedProb) : 0,
    stackedPairs,
    correlationFactor: legs.length ? factor : 1,
    extrapolated: stackedPairs.opposed > VALIDATED_OPPOSED_PAIRS,
    maxPerGame,
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
  maxPerGame = DEFAULT_MAX_PER_GAME,
  sport = "cfb",
): TdParlay[] {
  return sizes.map((s) => buildTdParlay(candidates, s, maxPerGame, sport));
}
