/**
 * lib-zoo.ts — the shared algorithm zoo + evaluation harness for the NBA/NFL
 * expedition. Every algorithm here is sport-agnostic; the per-sport drivers
 * (analyze-nba.ts / analyze-nfl.ts) wire them to their corpus and frozen
 * hyperparameters. Pure math, no I/O.
 *
 * Rating systems (updated game-by-game, strictly walk-forward):
 *   EloEngine       — classic Elo; optional 538-style margin-of-victory
 *                     multiplier and between-season regression to the mean
 *   Glicko2Engine   — Glickman's Glicko-2 (rating + deviation + volatility)
 *   PythagTracker   — season-to-date Pythagorean expectation with a prior,
 *                     combined via log5 + a home-advantage logit shift
 *   RidgeMargin     — "SRS done right": ridge regression on score margins
 *                     with exponential recency decay → expected margin → Φ
 *   OffDefRidge     — separate offense/defense ratings fit on points scored
 *   BradleyTerry    — decayed, L2-regularized Bradley-Terry (wins only)
 *
 * Fitted models (refit walk-forward by the drivers):
 *   logisticFit / logisticPredict — IRLS logistic regression with L2
 *   GbmModel        — gradient-boosted depth-2 trees, logistic loss
 *   MlpModel        — one-hidden-layer neural net, seeded and deterministic
 *
 * Market math: American-odds implied probabilities, proportional devig,
 * spread → win-probability via a normal margin model.
 *
 * Evaluation: Brier / log loss / accuracy, calibration tables, seeded
 * bootstrap CIs, flat-bet ROI simulation for edge tests.
 */

// ------------------------------------------------------------------ numerics

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function logit(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Standard normal CDF (Zelen & Severo approximation, |err| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/** Deterministic 32-bit RNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A mutated). */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const x = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (piv !== col) {
      [A[col], A[piv]] = [A[piv], A[col]];
      [x[col], x[piv]] = [x[piv], x[col]];
    }
    const d = A[col][col] || 1e-9;
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      x[r] -= f * x[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / (A[r][r] || 1e-9);
  }
  return x;
}

// ---------------------------------------------------------------------- Elo

export type EloConfig = {
  k: number;
  /** Home advantage in rating points (0 for neutral-site games). */
  hfa: number;
  /** 538-style margin-of-victory multiplier on/off. */
  mov: boolean;
  /** Between seasons: r ← mean + carry·(r − mean). */
  carry: number;
  mean: number; // long-run mean rating (1505 in 538's convention)
  init: number; // rating for a never-seen franchise (538 used 1300)
};

export class EloEngine {
  private r = new Map<string, number>();
  private seasonSeen = new Map<string, number>();
  constructor(private cfg: EloConfig) {}

  rating(team: string): number {
    return this.r.get(team) ?? this.cfg.init;
  }

  private carryIfNewSeason(team: string, season: number) {
    const prev = this.seasonSeen.get(team);
    if (prev !== undefined && season > prev) {
      const { mean, carry } = this.cfg;
      this.r.set(team, mean + carry * (this.rating(team) - mean));
    }
    this.seasonSeen.set(team, season);
  }

  /** P(home win). Call before update(). */
  prob(home: string, away: string, season: number, neutral = 0): number {
    this.carryIfNewSeason(home, season);
    this.carryIfNewSeason(away, season);
    const diff = this.rating(home) - this.rating(away) + (neutral ? 0 : this.cfg.hfa);
    return 1 / (1 + Math.pow(10, -diff / 400));
  }

  /** result: 1 home win, 0 away win, 0.5 tie. margin: home score − away score. */
  update(home: string, away: string, season: number, result: number, margin: number, neutral = 0) {
    const p = this.prob(home, away, season, neutral);
    let mult = 1;
    if (this.cfg.mov) {
      const winnerDiff =
        (result >= 0.5 ? 1 : -1) *
        (this.rating(home) - this.rating(away) + (neutral ? 0 : this.cfg.hfa));
      mult = Math.log(Math.abs(margin) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
      if (!Number.isFinite(mult) || mult < 0) mult = 1;
    }
    const delta = this.cfg.k * mult * (result - p);
    this.r.set(home, this.rating(home) + delta);
    this.r.set(away, this.rating(away) - delta);
  }
}

// ------------------------------------------------------------------ Glicko-2

export type Glicko2Config = {
  tau: number; // volatility constraint (0.2–1.2 typical)
  rd0: number; // initial rating deviation
  sigma0: number; // initial volatility
  /** Home advantage in rating points (applied on the Glicko scale). */
  hfa: number;
  /** Between seasons, φ ← min(√(φ² + inflate²), rd0) on the Glicko-2 scale. */
  inflate: number;
};

const GLICKO_SCALE = 173.7178;

type GlickoState = { mu: number; phi: number; sigma: number };

export class Glicko2Engine {
  private s = new Map<string, GlickoState>();
  private seasonSeen = new Map<string, number>();
  constructor(private cfg: Glicko2Config) {}

  private get(team: string): GlickoState {
    let st = this.s.get(team);
    if (!st) {
      st = { mu: 0, phi: this.cfg.rd0 / GLICKO_SCALE, sigma: this.cfg.sigma0 };
      this.s.set(team, st);
    }
    return st;
  }

  private carryIfNewSeason(team: string, season: number) {
    const prev = this.seasonSeen.get(team);
    if (prev !== undefined && season > prev) {
      const st = this.get(team);
      const inf = this.cfg.inflate / GLICKO_SCALE;
      st.phi = Math.min(Math.sqrt(st.phi * st.phi + inf * inf), this.cfg.rd0 / GLICKO_SCALE);
    }
    this.seasonSeen.set(team, season);
  }

  /** Rating in Elo-like points (1500-centered) for feature use. */
  rating(team: string): number {
    return 1500 + GLICKO_SCALE * this.get(team).mu;
  }

  prob(home: string, away: string, season: number, neutral = 0): number {
    this.carryIfNewSeason(home, season);
    this.carryIfNewSeason(away, season);
    const h = this.get(home);
    const a = this.get(away);
    const hfaMu = (neutral ? 0 : this.cfg.hfa) / GLICKO_SCALE;
    const g = 1 / Math.sqrt(1 + (3 * (h.phi ** 2 + a.phi ** 2)) / Math.PI ** 2);
    return sigmoid(g * (h.mu + hfaMu - a.mu));
  }

  update(home: string, away: string, season: number, result: number, neutral = 0) {
    this.carryIfNewSeason(home, season);
    this.carryIfNewSeason(away, season);
    const hfaMu = (neutral ? 0 : this.cfg.hfa) / GLICKO_SCALE;
    const h = this.get(home);
    const a = this.get(away);
    // one-game rating period for each side; opponent state frozen this game
    const nh = this.updateOne(h, { ...a, mu: a.mu - hfaMu }, result);
    const na = this.updateOne(a, { ...h, mu: h.mu + hfaMu }, 1 - result);
    this.s.set(home, nh);
    this.s.set(away, na);
  }

  private updateOne(self: GlickoState, opp: GlickoState, score: number): GlickoState {
    const g = 1 / Math.sqrt(1 + (3 * opp.phi ** 2) / Math.PI ** 2);
    const E = sigmoid(g * (self.mu - opp.mu));
    const v = 1 / (g * g * E * (1 - E));
    const delta = v * g * (score - E);
    // volatility update (Glickman's Illinois algorithm)
    const a0 = Math.log(self.sigma ** 2);
    const tau = this.cfg.tau;
    const phi2 = self.phi ** 2;
    const f = (x: number) =>
      (Math.exp(x) * (delta ** 2 - phi2 - v - Math.exp(x))) / (2 * (phi2 + v + Math.exp(x)) ** 2) -
      (x - a0) / (tau * tau);
    let A = a0;
    let B: number;
    if (delta ** 2 > phi2 + v) B = Math.log(delta ** 2 - phi2 - v);
    else {
      let k = 1;
      while (f(a0 - k * tau) < 0) k++;
      B = a0 - k * tau;
    }
    let fA = f(A);
    let fB = f(B);
    for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
      const C = A + ((A - B) * fA) / (fB - fA);
      const fC = f(C);
      if (fC * fB <= 0) {
        A = B;
        fA = fB;
      } else fA = fA / 2;
      B = C;
      fB = fC;
    }
    const sigma = Math.exp(A / 2);
    const phiStar = Math.sqrt(phi2 + sigma ** 2);
    const phi = 1 / Math.sqrt(1 / phiStar ** 2 + 1 / v);
    const mu = self.mu + phi ** 2 * g * (score - E);
    return { mu, phi, sigma };
  }
}

// -------------------------------------------------------- Pythagorean + log5

export type PythagConfig = {
  exponent: number;
  /** Prior weight in games of league-average scoring on each side. */
  priorGames: number;
  leagueAvgPts: number;
  /** Home advantage as a logit shift on the log5 probability. */
  homeLogit: number;
};

export class PythagTracker {
  private pf = new Map<string, number>(); // keyed team|season
  private pa = new Map<string, number>();
  private n = new Map<string, number>();
  constructor(private cfg: PythagConfig) {}

  expectation(team: string, season: number): number {
    const key = `${team}|${season}`;
    const g = this.n.get(key) ?? 0;
    const { priorGames, leagueAvgPts, exponent } = this.cfg;
    const pf = ((this.pf.get(key) ?? 0) + priorGames * leagueAvgPts) / (g + priorGames);
    const pa = ((this.pa.get(key) ?? 0) + priorGames * leagueAvgPts) / (g + priorGames);
    const fx = Math.pow(pf, exponent);
    return fx / (fx + Math.pow(pa, exponent));
  }

  prob(home: string, away: string, season: number, neutral = 0): number {
    const ph = this.expectation(home, season);
    const pa = this.expectation(away, season);
    const log5 = (ph * (1 - pa)) / (ph * (1 - pa) + pa * (1 - ph));
    return sigmoid(logit(log5) + (neutral ? 0 : this.cfg.homeLogit));
  }

  update(team: string, season: number, scored: number, allowed: number) {
    const key = `${team}|${season}`;
    this.pf.set(key, (this.pf.get(key) ?? 0) + scored);
    this.pa.set(key, (this.pa.get(key) ?? 0) + allowed);
    this.n.set(key, (this.n.get(key) ?? 0) + 1);
  }
}

// ------------------------------------------------- ridge margin ratings (SRS)

export type PastGame = {
  t: number; // epoch days
  home: string;
  away: string;
  hs: number;
  as: number;
  neutral: 0 | 1;
};

export type RidgeMarginConfig = {
  lambda: number; // ridge on team ratings
  halflifeDays: number;
  windowDays: number; // hard cutoff to keep fits fast
};

/** Fit team ratings r and home edge h minimizing
 *  Σ w·(margin − (r_h − r_a + h·(1−neutral)))² + λ‖r‖².
 *  Returns predicted margin for any matchup. */
export class RidgeMargin {
  private idx = new Map<string, number>();
  private ratings: number[] = [];
  private hfa = 0;
  fitted = false;

  constructor(private cfg: RidgeMarginConfig) {}

  fit(games: PastGame[], now: number) {
    const cut = now - this.cfg.windowDays;
    const use = games.filter((g) => g.t >= cut);
    if (use.length < 50) return;
    this.idx.clear();
    for (const g of use) {
      if (!this.idx.has(g.home)) this.idx.set(g.home, this.idx.size);
      if (!this.idx.has(g.away)) this.idx.set(g.away, this.idx.size);
    }
    const T = this.idx.size;
    const n = T + 1; // + home edge
    const A: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const b = Array(n).fill(0);
    const lnHalf = Math.LN2 / this.cfg.halflifeDays;
    for (const g of use) {
      const w = Math.exp(-lnHalf * (now - g.t));
      const hi = this.idx.get(g.home)!;
      const ai = this.idx.get(g.away)!;
      const hEdge = g.neutral ? 0 : 1;
      const y = g.hs - g.as;
      // design row x: +1 at hi, −1 at ai, hEdge at T
      const cols = [
        [hi, 1],
        [ai, -1],
        [T, hEdge],
      ] as const;
      for (const [i, xi] of cols) for (const [j, xj] of cols) A[i][j] += w * xi * xj;
      for (const [i, xi] of cols) b[i] += w * xi * y;
    }
    for (let i = 0; i < T; i++) A[i][i] += this.cfg.lambda; // not the HFA term
    // pin Σr = 0 (soft) to remove the translation null space
    for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) A[i][j] += 1e-4;
    const x = solveLinear(A, b);
    this.ratings = x.slice(0, T);
    this.hfa = x[T];
    this.fitted = true;
  }

  rating(team: string): number {
    const i = this.idx.get(team);
    return i === undefined ? 0 : this.ratings[i];
  }

  margin(home: string, away: string, neutral = 0): number {
    return this.rating(home) - this.rating(away) + (neutral ? 0 : this.hfa);
  }
}

// ------------------------------------------------ offense/defense ridge model

export type OffDefConfig = RidgeMarginConfig;

/** Points model: hs ≈ o_h − d_a + base + hEdge/2 ; as ≈ o_a − d_h + base − hEdge/2.
 *  Predicts an expected margin like RidgeMargin but through separate
 *  offense/defense ratings, so team style (pace-adjusted scoring/allowing)
 *  enters the fit. */
export class OffDefRidge {
  private idx = new Map<string, number>();
  private off: number[] = [];
  private def: number[] = [];
  private base = 0;
  private hEdge = 0;
  fitted = false;

  constructor(private cfg: OffDefConfig) {}

  fit(games: PastGame[], now: number) {
    const cut = now - this.cfg.windowDays;
    const use = games.filter((g) => g.t >= cut);
    if (use.length < 50) return;
    this.idx.clear();
    for (const g of use) {
      if (!this.idx.has(g.home)) this.idx.set(g.home, this.idx.size);
      if (!this.idx.has(g.away)) this.idx.set(g.away, this.idx.size);
    }
    const T = this.idx.size;
    const n = 2 * T + 2; // off_i, def_i, base, hEdge
    const A: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const b = Array(n).fill(0);
    const lnHalf = Math.LN2 / this.cfg.halflifeDays;
    const add = (cols: readonly (readonly [number, number])[], y: number, w: number) => {
      for (const [i, xi] of cols) for (const [j, xj] of cols) A[i][j] += w * xi * xj;
      for (const [i, xi] of cols) b[i] += w * xi * y;
    };
    for (const g of use) {
      const w = Math.exp(-lnHalf * (now - g.t));
      const hi = this.idx.get(g.home)!;
      const ai = this.idx.get(g.away)!;
      const hh = g.neutral ? 0 : 0.5;
      // home points row: off_h + def_a(−) + base + hEdge/2
      add(
        [
          [hi, 1],
          [T + ai, -1],
          [2 * T, 1],
          [2 * T + 1, hh],
        ],
        g.hs,
        w,
      );
      add(
        [
          [ai, 1],
          [T + hi, -1],
          [2 * T, 1],
          [2 * T + 1, -hh],
        ],
        g.as,
        w,
      );
    }
    for (let i = 0; i < 2 * T; i++) A[i][i] += this.cfg.lambda;
    for (let i = 0; i < 2 * T; i++) for (let j = 0; j < 2 * T; j++) A[i][j] += 1e-4;
    const x = solveLinear(A, b);
    this.off = x.slice(0, T);
    this.def = x.slice(T, 2 * T);
    this.base = x[2 * T];
    this.hEdge = x[2 * T + 1];
    this.fitted = true;
  }

  margin(home: string, away: string, neutral = 0): number {
    const { eh, ea } = this.points(home, away, neutral);
    return eh - ea;
  }

  /** Fitted league-average total in the current window (2·base). */
  avgTotal(): number {
    return 2 * this.base;
  }

  /** Expected points for each side — the information the margin-only model
   *  cannot see. (For win probability the margin decomposes exactly into the
   *  margin-only ridge; the totals are what make this family distinct.) */
  points(home: string, away: string, neutral = 0): { eh: number; ea: number } {
    const hi = this.idx.get(home);
    const ai = this.idx.get(away);
    const oh = hi === undefined ? 0 : this.off[hi];
    const dh = hi === undefined ? 0 : this.def[hi];
    const oa = ai === undefined ? 0 : this.off[ai];
    const da = ai === undefined ? 0 : this.def[ai];
    const hh = neutral ? 0 : this.hEdge;
    return {
      eh: oh - da + this.base + hh / 2,
      ea: oa - dh + this.base - hh / 2,
    };
  }
}

// ------------------------------------------------------------- Bradley-Terry

export type BradleyTerryConfig = {
  l2: number;
  halflifeDays: number;
  windowDays: number;
};

/** Decayed Bradley-Terry with home intercept: P(home) = σ(r_h − r_a + h).
 *  Fit by IRLS on win/loss outcomes only — the "results-only" fitted family. */
export class BradleyTerry {
  private idx = new Map<string, number>();
  private beta: number[] = [];
  fitted = false;

  constructor(private cfg: BradleyTerryConfig) {}

  fit(games: (PastGame & { result: number })[], now: number) {
    const cut = now - this.cfg.windowDays;
    const use = games.filter((g) => g.t >= cut);
    if (use.length < 50) return;
    this.idx.clear();
    for (const g of use) {
      if (!this.idx.has(g.home)) this.idx.set(g.home, this.idx.size);
      if (!this.idx.has(g.away)) this.idx.set(g.away, this.idx.size);
    }
    const T = this.idx.size;
    const n = T + 1;
    let beta = Array(n).fill(0);
    const lnHalf = Math.LN2 / this.cfg.halflifeDays;
    for (let iter = 0; iter < 20; iter++) {
      const A: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
      const g0 = Array(n).fill(0);
      for (const g of use) {
        const w = Math.exp(-lnHalf * (now - g.t));
        const hi = this.idx.get(g.home)!;
        const ai = this.idx.get(g.away)!;
        const hEdge = g.neutral ? 0 : 1;
        const eta = beta[hi] - beta[ai] + hEdge * beta[T];
        const p = sigmoid(eta);
        const W = w * Math.max(1e-6, p * (1 - p));
        const r = w * (g.result - p);
        const cols = [
          [hi, 1],
          [ai, -1],
          [T, hEdge],
        ] as const;
        for (const [i, xi] of cols) {
          g0[i] += r * xi;
          for (const [j, xj] of cols) A[i][j] += W * xi * xj;
        }
      }
      for (let i = 0; i < T; i++) {
        A[i][i] += this.cfg.l2;
        g0[i] -= this.cfg.l2 * beta[i];
      }
      for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) A[i][j] += 1e-4;
      const step = solveLinear(A, g0);
      let move = 0;
      for (let i = 0; i < n; i++) {
        beta[i] += step[i];
        move += Math.abs(step[i]);
      }
      if (move < 1e-6) break;
    }
    this.beta = beta;
    this.fitted = true;
  }

  logitDiff(home: string, away: string, neutral = 0): number {
    const T = this.idx.size;
    const hi = this.idx.get(home);
    const ai = this.idx.get(away);
    const rh = hi === undefined ? 0 : this.beta[hi];
    const ra = ai === undefined ? 0 : this.beta[ai];
    return rh - ra + (neutral ? 0 : this.beta[T]);
  }

  prob(home: string, away: string, neutral = 0): number {
    return sigmoid(this.logitDiff(home, away, neutral));
  }
}

// ------------------------------------------------------- logistic regression

export type Standardizer = { mean: number[]; sd: number[] };

export function fitStandardizer(X: number[][]): Standardizer {
  const k = X[0].length;
  const mean = Array(k).fill(0);
  const sd = Array(k).fill(0);
  for (const row of X) for (let j = 0; j < k; j++) mean[j] += row[j];
  for (let j = 0; j < k; j++) mean[j] /= X.length;
  for (const row of X) for (let j = 0; j < k; j++) sd[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j] / X.length) || 1;
  return { mean, sd };
}

export function applyStandardizer(s: Standardizer, x: number[]): number[] {
  return x.map((v, j) => (v - s.mean[j]) / s.sd[j]);
}

/** IRLS logistic regression with L2 (intercept unpenalized, appended last). */
export function logisticFit(X: number[][], y: number[], l2: number, iters = 25): number[] {
  const n = X.length;
  const k = X[0].length + 1; // + intercept
  let beta = Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const A: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
    const g = Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let eta = beta[k - 1];
      for (let j = 0; j < k - 1; j++) eta += beta[j] * xi[j];
      const p = sigmoid(eta);
      const W = Math.max(1e-6, p * (1 - p));
      const r = y[i] - p;
      for (let j = 0; j < k; j++) {
        const xj = j === k - 1 ? 1 : xi[j];
        g[j] += r * xj;
        for (let m = j; m < k; m++) {
          const xm = m === k - 1 ? 1 : xi[m];
          A[j][m] += W * xj * xm;
        }
      }
    }
    for (let j = 0; j < k; j++) for (let m = 0; m < j; m++) A[j][m] = A[m][j];
    for (let j = 0; j < k - 1; j++) {
      A[j][j] += l2;
      g[j] -= l2 * beta[j];
    }
    const step = solveLinear(A, g);
    let move = 0;
    for (let j = 0; j < k; j++) {
      beta[j] += step[j];
      move += Math.abs(step[j]);
    }
    if (move < 1e-7) break;
  }
  return beta;
}

export function logisticPredict(beta: number[], x: number[]): number {
  let eta = beta[beta.length - 1];
  for (let j = 0; j < x.length; j++) eta += beta[j] * x[j];
  return sigmoid(eta);
}

// --------------------------------------------------------- gradient boosting

export type GbmConfig = {
  trees: number;
  lr: number;
  subsample: number;
  seed: number;
  minLeaf: number;
};

type Split = { feat: number; thr: number };
type TreeNode = {
  split?: Split;
  left?: TreeNode;
  right?: TreeNode;
  value?: number;
};

/** Depth-2 gradient-boosted trees, logistic loss, Newton leaf values.
 *  Split search uses per-feature histograms over pre-computed bin indices,
 *  so a node costs O(k·n_node + k·bins) instead of O(k·bins·n_node). */
export class GbmModel {
  private trees: TreeNode[] = [];
  private base = 0;
  private thresholds: number[][] = [];
  private binIdx: Int8Array[] = []; // per feature: bin of each row

  constructor(private cfg: GbmConfig) {}

  fit(X: number[][], y: number[]) {
    const n = X.length;
    const k = X[0].length;
    const mean = y.reduce((a, b) => a + b, 0) / n;
    this.base = logit(mean);
    // candidate thresholds: ≤15 quantiles per feature; bin i = values ≤ thr[i]
    this.thresholds = [];
    this.binIdx = [];
    for (let j = 0; j < k; j++) {
      const vals = X.map((r) => r[j]).sort((a, b) => a - b);
      const qs = new Set<number>();
      for (let q = 1; q <= 15; q++) qs.add(vals[Math.min(n - 1, Math.floor((q / 16) * n))]);
      const thr = [...qs].sort((a, b) => a - b);
      this.thresholds.push(thr);
      const bins = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const v = X[i][j];
        let b = thr.length; // beyond the last threshold
        for (let m = 0; m < thr.length; m++)
          if (v <= thr[m]) {
            b = m;
            break;
          }
        bins[i] = b;
      }
      this.binIdx.push(bins);
    }
    const eta = new Float64Array(n).fill(this.base);
    const rand = rng(this.cfg.seed);
    this.trees = [];
    for (let t = 0; t < this.cfg.trees; t++) {
      const idx: number[] = [];
      for (let i = 0; i < n; i++) if (rand() < this.cfg.subsample) idx.push(i);
      if (idx.length < 20) continue;
      const grad = new Float64Array(n);
      const hess = new Float64Array(n);
      for (const i of idx) {
        const p = sigmoid(eta[i]);
        grad[i] = y[i] - p;
        hess[i] = Math.max(1e-6, p * (1 - p));
      }
      const tree = this.buildNode(idx, grad, hess, 2);
      this.trees.push(tree);
      for (let i = 0; i < n; i++) eta[i] += this.cfg.lr * this.evalTree(tree, X[i]);
    }
  }

  private buildNode(
    idx: number[],
    grad: Float64Array,
    hess: Float64Array,
    depth: number,
  ): TreeNode {
    let G = 0;
    let H = 0;
    for (const i of idx) {
      G += grad[i];
      H += hess[i];
    }
    const leafValue = clamp(G / (H + 1), -4, 4);
    if (depth === 0 || idx.length < 2 * this.cfg.minLeaf) return { value: leafValue };
    const k = this.thresholds.length;
    let best: { feat: number; bin: number; gain: number } | null = null;
    const NB = 17;
    const histG = new Float64Array(NB);
    const histH = new Float64Array(NB);
    const histN = new Int32Array(NB);
    for (let j = 0; j < k; j++) {
      histG.fill(0);
      histH.fill(0);
      histN.fill(0);
      const bins = this.binIdx[j];
      for (const i of idx) {
        const b = bins[i];
        histG[b] += grad[i];
        histH[b] += hess[i];
        histN[b]++;
      }
      let GL = 0;
      let HL = 0;
      let nL = 0;
      for (let b = 0; b < this.thresholds[j].length; b++) {
        GL += histG[b];
        HL += histH[b];
        nL += histN[b];
        const nR = idx.length - nL;
        if (nL < this.cfg.minLeaf || nR < this.cfg.minLeaf) continue;
        const GR = G - GL;
        const HR = H - HL;
        const gain = (GL * GL) / (HL + 1) + (GR * GR) / (HR + 1) - (G * G) / (H + 1);
        if (!best || gain > best.gain) best = { feat: j, bin: b, gain };
      }
    }
    if (!best || best.gain < 1e-4) return { value: leafValue };
    const bins = this.binIdx[best.feat];
    const li: number[] = [];
    const ri: number[] = [];
    for (const i of idx) (bins[i] <= best.bin ? li : ri).push(i);
    return {
      split: { feat: best.feat, thr: this.thresholds[best.feat][best.bin] },
      left: this.buildNode(li, grad, hess, depth - 1),
      right: this.buildNode(ri, grad, hess, depth - 1),
    };
  }

  private evalTree(node: TreeNode, x: number[]): number {
    while (node.split) {
      node = x[node.split.feat] <= node.split.thr ? node.left! : node.right!;
    }
    return node.value!;
  }

  predict(x: number[]): number {
    let eta = this.base;
    for (const t of this.trees) eta += this.cfg.lr * this.evalTree(t, x);
    return sigmoid(eta);
  }
}

// ------------------------------------------------------------------- MLP

export type MlpConfig = {
  hidden: number;
  epochs: number;
  lr: number;
  l2: number;
  seed: number;
};

/** One-hidden-layer (tanh) neural net, sigmoid output, SGD with momentum.
 *  Deterministic given the seed. Inputs must be pre-standardized. */
export class MlpModel {
  private W1: number[][] = [];
  private b1: number[] = [];
  private W2: number[] = [];
  private b2 = 0;

  constructor(private cfg: MlpConfig) {}

  fit(X: number[][], y: number[]) {
    const k = X[0].length;
    const H = this.cfg.hidden;
    const rand = rng(this.cfg.seed);
    const init = (fan: number) => (rand() * 2 - 1) * Math.sqrt(3 / fan);
    this.W1 = Array.from({ length: H }, () => Array.from({ length: k }, () => init(k)));
    this.b1 = Array(H).fill(0);
    this.W2 = Array.from({ length: H }, () => init(H));
    this.b2 = 0;
    const vW1 = this.W1.map((r) => r.map(() => 0));
    const vb1 = Array(H).fill(0);
    const vW2 = Array(H).fill(0);
    let vb2 = 0;
    const mom = 0.9;
    const order = X.map((_, i) => i);
    for (let ep = 0; ep < this.cfg.epochs; ep++) {
      const lr = this.cfg.lr / (1 + ep * 0.08);
      // seeded shuffle
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const i of order) {
        const x = X[i];
        const h = new Array(H);
        for (let u = 0; u < H; u++) {
          let s = this.b1[u];
          const w = this.W1[u];
          for (let j = 0; j < k; j++) s += w[j] * x[j];
          h[u] = Math.tanh(s);
        }
        let eta = this.b2;
        for (let u = 0; u < H; u++) eta += this.W2[u] * h[u];
        const p = sigmoid(eta);
        const dEta = p - y[i]; // dL/deta
        // output layer
        for (let u = 0; u < H; u++) {
          const g = dEta * h[u] + this.cfg.l2 * this.W2[u];
          vW2[u] = mom * vW2[u] - lr * g;
          this.W2[u] += vW2[u];
        }
        vb2 = mom * vb2 - lr * dEta;
        this.b2 += vb2;
        // hidden layer
        for (let u = 0; u < H; u++) {
          const dH = dEta * this.W2[u] * (1 - h[u] * h[u]);
          const w = this.W1[u];
          const vw = vW1[u];
          for (let j = 0; j < k; j++) {
            const g = dH * x[j] + this.cfg.l2 * w[j];
            vw[j] = mom * vw[j] - lr * g;
            w[j] += vw[j];
          }
          vb1[u] = mom * vb1[u] - lr * dH;
          this.b1[u] += vb1[u];
        }
      }
    }
  }

  predict(x: number[]): number {
    const H = this.cfg.hidden;
    let eta = this.b2;
    for (let u = 0; u < H; u++) {
      let s = this.b1[u];
      const w = this.W1[u];
      for (let j = 0; j < x.length; j++) s += w[j] * x[j];
      eta += this.W2[u] * Math.tanh(s);
    }
    return sigmoid(eta);
  }
}

// -------------------------------------------------------------- market math

/** American odds → implied probability (vig included). */
export function impliedProb(ml: number): number {
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

/** Proportional devig of a two-way market → P(home). */
export function devig(mlHome: number, mlAway: number): number {
  const qh = impliedProb(mlHome);
  const qa = impliedProb(mlAway);
  return qh / (qh + qa);
}

/** Profit per unit staked for a winning bet at American odds. */
export function payout(ml: number): number {
  return ml > 0 ? ml / 100 : 100 / -ml;
}

/** Spread (home-positive) → P(home win) via a normal margin model. */
export function spreadProb(spread: number, sigma: number): number {
  return normCdf(spread / sigma);
}

// --------------------------------------------------------------- evaluation

export type Scored = { y: number; p: number };

export function metrics(rows: Scored[]) {
  let acc = 0;
  let brier = 0;
  let ll = 0;
  for (const { y, p } of rows) {
    const pc = clamp(p, 1e-9, 1 - 1e-9);
    acc += (p > 0.5 ? 1 : 0) === y ? 1 : p === 0.5 ? 0.5 : 0;
    brier += (p - y) ** 2;
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = rows.length || 1;
  return { n: rows.length, acc: acc / n, brier: brier / n, logLoss: ll / n };
}

export function calibrationTable(rows: Scored[], edges = [0.5, 0.6, 0.7, 0.8, 1.01]) {
  // fold everything to the favored side
  const out: { bucket: string; n: number; claimed: number; actual: number }[] = [];
  let lo = edges[0];
  for (const hi of edges.slice(1)) {
    const sel = rows
      .map(({ y, p }) => (p >= 0.5 ? { pf: p, win: y } : { pf: 1 - p, win: 1 - y }))
      .filter((r) => r.pf >= lo && r.pf < hi);
    const n = sel.length;
    out.push({
      bucket: `${lo.toFixed(2)}–${Math.min(1, hi).toFixed(2)}`,
      n,
      claimed: n ? sel.reduce((a, r) => a + r.pf, 0) / n : 0,
      actual: n ? sel.reduce((a, r) => a + r.win, 0) / n : 0,
    });
    lo = hi;
  }
  return out;
}

/** Dev-fit temperature: p' = σ(a·logit(p)); returns a minimizing log loss. */
export function fitTemperature(rows: Scored[]): number {
  let best = 1;
  let bestLl = Infinity;
  for (let a = 0.3; a <= 1.61; a += 0.01) {
    let ll = 0;
    for (const { y, p } of rows) {
      const q = clamp(sigmoid(a * logit(p)), 1e-9, 1 - 1e-9);
      ll += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
    }
    if (ll < bestLl) {
      bestLl = ll;
      best = a;
    }
  }
  return Math.round(best * 100) / 100;
}

/** Seeded bootstrap percentile CI for the mean of xs. */
export function bootstrapCI(
  xs: number[],
  iters = 10000,
  seed = 7,
  lo = 0.05,
  hi = 0.95,
): [number, number] {
  const rand = rng(seed);
  const n = xs.length;
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(lo * iters)], means[Math.floor(hi * iters)]];
}

export function fmtPct(x: number, digits = 1): string {
  return (100 * x).toFixed(digits) + "%";
}

export function pad(s: string | number, w: number): string {
  return String(s).padStart(w);
}
