/**
 * ucl-model.ts — the Champions League match model, as pure arithmetic.
 *
 * Shared by the server (which replays results into ratings) and the browser
 * (which prices any pairing of clubs for the simulator), so it holds no I/O and
 * imports only the small frozen constants file.
 *
 * The model, frozen by research/ucl/ship_ucl.py:
 *
 *   1. ONE Elo across every club in Europe. Domestic results rank clubs within
 *      their league; European results (all three UEFA competitions and their
 *      qualifiers) rank the leagues against each other. That is the only way to
 *      put Arsenal, Slavia Prague and Sabah on one scale — the five domestic
 *      league models are islands and cannot.
 *   2. The rating gap becomes a goal rate for each side (a Poisson model with
 *      its own Champions League terms: more goals and stronger favourites than
 *      the European pool), and a Dixon-Coles corrected scoreline matrix gives
 *      home/draw/away, over/under and both-teams-to-score.
 *
 * research/ucl/common.py is the reference implementation of every function
 * here; scripts/test-ucl.ts replays Python's own fixture through this file.
 */

import model from "./ucl-model.json";

export type UclElo = {
  k: number;
  eu_mult: number;
  hfa: number;
  gd_exp: number;
  carry: number;
  promo: number;
  euro_prior: number;
  leaguePrior: Record<string, number>;
};

export type UclModelFile = {
  name: string;
  algorithm: string;
  elo: UclElo;
  goals: { home: number[]; away: number[]; rho: number; trainedThrough: number; nTrain: number };
  priors: { home: number; draw: number; away: number; goals: number };
  comps: string[];
  backtest: {
    pooled: Record<string, { n: number; rps: number; logloss: number; brier: number; acc: number }>;
    perSeason: ({ season: number; n: number } & Record<
      string,
      { n: number; rps: number; logloss: number; brier: number; acc: number } | number
    >)[];
    calibration: { lo: number; hi: number; n: number; predicted: number; actual: number }[];
    scorelines: Record<string, number>;
    live: { n: number; rps: number; logloss: number; brier: number; acc: number } | null;
    liveSeason: number;
  };
};

export const UCL_MODEL = model as unknown as UclModelFile;

/** UEFA's club competitions. A match in one of these moves league levels. */
export const EUROPE = new Set([
  "uefa.champions",
  "uefa.champions_qual",
  "uefa.europa",
  "uefa.europa_qual",
  "uefa.europa.conf",
  "uefa.europa.conf_qual",
  "uefa.super_cup",
]);

/** Every competition the replay reads — the same list the research fetched. */
export const UCL_COMPS: string[] = UCL_MODEL.comps;

/**
 * ESPN's season label: 2025 is 2025-26, and July opens a season. August 2020
 * belongs to the season before — the 2019-20 Champions League finished then.
 */
export function seasonOf(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (date.slice(0, 7) === "2020-08") return 2019;
  return m >= 7 ? y : y - 1;
}

/** One completed match as the replay reads it. `date` is ESPN's ISO string. */
export type UclResult = {
  id: string;
  comp: string;
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  neutral: boolean;
};

export type RatingState = {
  rating: Map<string, number>;
  /** Each club's domestic league, when ESPN carries one. */
  league: Map<string, string>;
  /** The season of the last match folded in, or null before any. */
  season: number | null;
};

export type Snapshot = {
  cutoff: string;
  season: number;
  nMatches: number;
  clubs: Record<string, [number, string | null]>;
};

export function stateFromSnapshot(snap: Snapshot): RatingState {
  const rating = new Map<string, number>();
  const league = new Map<string, string>();
  for (const [id, [r, lg]] of Object.entries(snap.clubs)) {
    rating.set(id, r);
    if (lg) league.set(id, lg);
  }
  return { rating, league, season: snap.season };
}

/** Sort key the research uses: kickoff time, then ESPN id. */
export function byKickoff(a: UclResult, b: UclResult): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold matches (oldest first) into a rating state, in place.
 *
 * `observer` sees each match with both ratings as they stood BEFORE it — the
 * only honest numbers to have priced it with. Mirrors common.replay_state line
 * for line, including the order a new club is seeded in: the home side joins
 * its league before the away side's starting rating is taken from that
 * league's mean.
 */
export function replayInto(
  state: RatingState,
  matches: UclResult[],
  elo: UclElo = UCL_MODEL.elo,
  observer?: (m: UclResult, rh: number, ra: number) => void,
): RatingState {
  const { rating, league } = state;

  const leagueMean = (comp: string): number | null => {
    let sum = 0;
    let n = 0;
    for (const [t, lg] of league) {
      if (lg === comp) {
        sum += rating.get(t)!;
        n += 1;
      }
    }
    return n >= 6 ? sum / n : null;
  };

  for (const m of matches) {
    const s = seasonOf(m.date);
    if (state.season !== null && s !== state.season) {
      // New season: each domestic club moves part of the way back to its
      // league's mean. The league's own level is what Europe taught the model
      // and is left alone.
      const sums = new Map<string, [number, number]>();
      for (const [t, lg] of league) {
        const cur = sums.get(lg) ?? [0, 0];
        cur[0] += rating.get(t)!;
        cur[1] += 1;
        sums.set(lg, cur);
      }
      for (const [t, lg] of league) {
        const [sum, n] = sums.get(lg)!;
        const mu = sum / n;
        rating.set(t, mu + elo.carry * (rating.get(t)! - mu));
      }
    }
    state.season = s;

    const eu = EUROPE.has(m.comp);
    for (const t of [m.home, m.away]) {
      if (!rating.has(t)) {
        if (eu) rating.set(t, elo.euro_prior);
        else {
          const mu = leagueMean(m.comp);
          rating.set(t, mu !== null ? mu - elo.promo : (elo.leaguePrior[m.comp] ?? 1400));
        }
      }
      if (!eu) league.set(t, m.comp);
    }

    const rh = rating.get(m.home)!;
    const ra = rating.get(m.away)!;
    observer?.(m, rh, ra);

    const adv = m.neutral ? 0 : elo.hfa;
    const exp = 1 / (1 + 10 ** (-(rh + adv - ra) / 400));
    const gd = m.hg - m.ag;
    const res = gd > 0 ? 1 : gd === 0 ? 0.5 : 0;
    const k = elo.k * (eu ? elo.eu_mult : 1);
    const d = k * (Math.abs(gd) + 1) ** elo.gd_exp * (res - exp);
    rating.set(m.home, rh + d);
    rating.set(m.away, ra - d);
  }
  return state;
}

// ------------------------------------------------------------- goal model

/**
 * 90-minute goal rates for each side.
 *
 * log(rate) = b0 + b1·gap + b2·home [+ b3 + b4·gap in the Champions League],
 * with gap = (home rating − away rating)/400, sign-flipped for the away side.
 * `ucl` is false only for pricing other European ties, which the site does not
 * do today; it is here so the parity grid can check both branches.
 */
export function goalRates(
  homeRating: number,
  awayRating: number,
  neutral = false,
  ucl = true,
): { home: number; away: number } {
  const gap = (homeRating - awayRating) / 400;
  const h = neutral ? 0 : 1;
  const u = ucl ? 1 : 0;
  const [b0, b1, b2, b3, b4] = UCL_MODEL.goals.home;
  const [a0, a1, a2, a3, a4] = UCL_MODEL.goals.away;
  return {
    home: Math.exp(b0 + b1 * gap + b2 * h + b3 * u + b4 * u * gap),
    away: Math.exp(a0 - a1 * gap + a2 * h + a3 * u - a4 * u * gap),
  };
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  return f;
}

/** Dixon-Coles scoreline matrix, P[i][j] = P(home i, away j), normalised. */
export function scoreMatrix(lh: number, la: number, rho = UCL_MODEL.goals.rho, maxGoals = 10) {
  const ph: number[] = [];
  const pa: number[] = [];
  for (let i = 0; i <= maxGoals; i += 1) {
    ph.push((Math.exp(-lh) * lh ** i) / factorial(i));
    pa.push((Math.exp(-la) * la ** i) / factorial(i));
  }
  const P = ph.map((x) => pa.map((y) => x * y));
  P[0][0] *= 1 - lh * la * rho;
  P[0][1] *= 1 + lh * rho;
  P[1][0] *= 1 + la * rho;
  P[1][1] *= 1 - rho;
  let total = 0;
  for (const row of P)
    for (let j = 0; j < row.length; j += 1) total += row[j] = Math.max(0, row[j]);
  for (const row of P) for (let j = 0; j < row.length; j += 1) row[j] /= total;
  return P;
}

export type MatchPrice = {
  home: number;
  draw: number;
  away: number;
  xgHome: number;
  xgAway: number;
  over25: number;
  btts: number;
  /** The six likeliest scorelines. */
  scores: { score: string; p: number }[];
};

export function priceRates(lh: number, la: number): MatchPrice {
  const P = scoreMatrix(lh, la);
  let home = 0;
  let draw = 0;
  let away = 0;
  let under = 0;
  const flat: { score: string; p: number }[] = [];
  for (let i = 0; i < P.length; i += 1) {
    for (let j = 0; j < P.length; j += 1) {
      const p = P[i][j];
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
      if (i + j <= 2) under += p;
      if (i <= 6 && j <= 6) flat.push({ score: `${i}-${j}`, p });
    }
  }
  const rowZero = P[0].reduce((s, x) => s + x, 0);
  const colZero = P.reduce((s, r) => s + r[0], 0);
  flat.sort((a, b) => b.p - a.p);
  return {
    home,
    draw,
    away,
    xgHome: lh,
    xgAway: la,
    over25: 1 - under,
    btts: 1 - rowZero - colZero + P[0][0],
    scores: flat.slice(0, 6),
  };
}

/** Price a pairing straight from two ratings. */
export function priceMatch(homeRating: number, awayRating: number, neutral = false): MatchPrice {
  const r = goalRates(homeRating, awayRating, neutral, true);
  return priceRates(r.home, r.away);
}
