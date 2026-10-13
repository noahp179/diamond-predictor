/**
 * soccer.ts — the minute-by-minute football engine (Champions League).
 *
 * A match is played one minute at a time. In each minute each side scores at
 *
 *     (its 90-minute goal rate / 90) × minute effect × game-state effect
 *                                     × man-advantage effect
 *
 * and is shown a red card at that minute's red-card rate. The 90-minute goal
 * rates come from the match model (ucl-model.ts). The effects come from
 * research/ucl/sim_ucl.py, fitted by Poisson regression on the goal and red-card
 * logs of every European match since 2014-15 (ucl-sim.json):
 *
 *   minute       goals come later in matches; minute 45 and 90 hold all of their
 *                half's stoppage time, so they score at 3x and 7x a normal minute
 *   game state   a side that leads OR trails scores at ~0.84x the level rate —
 *                level matches are the open ones
 *   red cards    a side a man down scores at ~0.55x, a man up at ~1.65x
 *
 * Because the effects were fitted against the model's own rates, a simulated
 * match averages what the model expects rather than drifting from it; in the
 * backtest the simulator's 1X2 scored the same RPS as the closed-form model and
 * got the draw rate right where the closed form did not (18.6% simulated, 19.3%
 * real, 22.5% closed form).
 *
 * Knockouts: a level tie goes to 30 minutes of extra time (scored at the
 * measured extra-time factor) and then a shoot-out, which is a coin toss —
 * hosts won 49.5% of 212 European shoot-outs. In a second leg the game state is
 * the AGGREGATE score, because that is what the trailing side is chasing.
 *
 * Pure and seeded, so a match can be replayed exactly.
 */

import simConstants from "../ucl-sim.json";
import { Rng } from "./core";

export type SoccerSimConstants = {
  bucket: number[];
  state: Record<string, number>;
  man: Record<string, number>;
  redRate: number[];
  buckets: [number, number][];
  ownGoalShare: number;
  etFactor: number;
  shootoutHome: number;
};

export const SOCCER_SIM = simConstants as unknown as SoccerSimConstants & {
  fittedOn: number;
  shootoutSample: { n: number; homeWon: number };
  backtest?: Record<string, unknown>;
};

export type Scorer = { id: string; name: string; pos: string; share: number };

export type SoccerSide = {
  name: string;
  abbr: string;
  /** Expected 90-minute goals from the match model. */
  rate: number;
  /** Who scores this side's goals, as shares of its goals (own goals excluded;
   *  the shares sum to 1 − own-goal share). Empty → goals are unattributed. */
  scorers: Scorer[];
};

export type SoccerSimOptions = {
  /** A level match (or tie) goes to extra time and penalties. */
  knockout?: boolean;
  /** Second leg of a two-legged tie: the first leg's score, from the point of
   *  view of THIS match's home and away sides. */
  firstLeg?: { home: number; away: number } | null;
};

export type MatchEvent = {
  minute: number;
  side: "home" | "away";
  kind: "goal" | "own" | "red";
  player?: string;
};

export type MatchResult = {
  /** Goals after 90 minutes — what 1X2 markets settle on. */
  hg90: number;
  ag90: number;
  /** Goals after extra time (equal to the 90-minute score without it). */
  hg: number;
  ag: number;
  extraTime: boolean;
  /** Shoot-out winner, when there was one. */
  shootout: "home" | "away" | null;
  /** Who goes through, in a knockout. */
  advances: "home" | "away" | null;
  /** Scorer ids for each goal in order, home and away (own goals are "og"). */
  homeScorers: string[];
  awayScorers: string[];
  events?: MatchEvent[];
};

const STATE_KEYS = ["-2", "-1", "0", "1", "2"];

/** Minute (1-90) → scoring effect and red-card rate, built once. */
function minuteTables(c: SoccerSimConstants) {
  const eff = new Array<number>(91).fill(1);
  const red = new Array<number>(91).fill(0);
  c.buckets.forEach(([lo, hi], b) => {
    for (let m = lo; m <= hi; m += 1) {
      eff[m] = Math.exp(c.bucket[b]);
      red[m] = c.redRate[b];
    }
  });
  return { eff, red };
}

/** Knuth's Poisson sampler — the per-minute means are tiny, so it is fast. */
function poisson(rng: Rng, mean: number): number {
  if (mean <= 0) return 0;
  const L = Math.exp(-mean);
  let k = 0;
  let p = rng.next();
  while (p > L) {
    k += 1;
    p *= rng.next();
  }
  return k;
}

function pickScorer(rng: Rng, scorers: Scorer[], ownShare: number): string {
  let u = rng.next();
  if (u < ownShare) return "og";
  u -= ownShare;
  for (const s of scorers) {
    if (u < s.share) return s.id;
    u -= s.share;
  }
  return scorers.length ? scorers[scorers.length - 1].id : "?";
}

export class SoccerEngine {
  private eff: number[];
  private red: number[];
  private state: number[];
  private man: [number, number, number];

  constructor(private c: SoccerSimConstants = SOCCER_SIM) {
    const { eff, red } = minuteTables(c);
    this.eff = eff;
    this.red = red;
    this.state = STATE_KEYS.map((k) => Math.exp(c.state[k] ?? 0));
    this.man = [Math.exp(c.man["-1"]), Math.exp(c.man["0"] ?? 0), Math.exp(c.man["1"])];
  }

  play(
    rng: Rng,
    home: SoccerSide,
    away: SoccerSide,
    opts: SoccerSimOptions = {},
    log = false,
  ): MatchResult {
    const events: MatchEvent[] | undefined = log ? [] : undefined;
    const lead = opts.firstLeg ? opts.firstLeg.home - opts.firstLeg.away : 0;
    let hg = 0;
    let ag = 0;
    let hr = 0;
    let ar = 0;
    const homeScorers: string[] = [];
    const awayScorers: string[] = [];
    const og = this.c.ownGoalShare;

    const minute = (m: number, rateScale: number, eff: number, redRate: number) => {
      // Aggregate state in a second leg: that is what the trailing side chases.
      const gd = Math.max(-2, Math.min(2, hg - ag + lead));
      const man = Math.max(-1, Math.min(1, ar - hr));
      const muH = (home.rate / 90) * rateScale * eff * this.state[gd + 2] * this.man[man + 1];
      const muA = (away.rate / 90) * rateScale * eff * this.state[-gd + 2] * this.man[-man + 1];
      const nh = poisson(rng, muH);
      const na = poisson(rng, muA);
      for (let i = 0; i < nh; i += 1) {
        const who = pickScorer(rng, home.scorers, og);
        homeScorers.push(who);
        events?.push({ minute: m, side: "home", kind: who === "og" ? "own" : "goal", player: who });
      }
      for (let i = 0; i < na; i += 1) {
        const who = pickScorer(rng, away.scorers, og);
        awayScorers.push(who);
        events?.push({ minute: m, side: "away", kind: who === "og" ? "own" : "goal", player: who });
      }
      hg += nh;
      ag += na;
      if (rng.next() < redRate) {
        hr += 1;
        events?.push({ minute: m, side: "home", kind: "red" });
      }
      if (rng.next() < redRate) {
        ar += 1;
        events?.push({ minute: m, side: "away", kind: "red" });
      }
    };

    for (let m = 1; m <= 90; m += 1) minute(m, 1, this.eff[m], this.red[m]);
    const hg90 = hg;
    const ag90 = ag;

    let extraTime = false;
    let shootout: "home" | "away" | null = null;
    let advances: "home" | "away" | null = null;
    if (opts.knockout) {
      const margin = () => hg - ag + lead;
      if (margin() === 0) {
        extraTime = true;
        // Extra-time minutes carry the late-match minute effect (76-89).
        const late = this.eff[80];
        for (let m = 91; m <= 120; m += 1) minute(m, this.c.etFactor, late, this.red[80]);
      }
      if (margin() === 0) {
        shootout = rng.next() < this.c.shootoutHome ? "home" : "away";
        advances = shootout;
      } else advances = margin() > 0 ? "home" : "away";
    }

    return { hg90, ag90, hg, ag, extraTime, shootout, advances, homeScorers, awayScorers, events };
  }
}

// --------------------------------------------------------------- batches

export type SoccerBatch = {
  n: number;
  home: number;
  draw: number;
  away: number;
  /** [i][j] = matches ending i-j after 90 minutes (9 = nine or more). */
  scores: number[][];
  /** Total goals after 90 minutes, 0..10 (10 = ten or more). */
  totals: number[];
  bttsYes: number;
  homeCleanSheet: number;
  awayCleanSheet: number;
  homeGoals: number;
  awayGoals: number;
  /** Knockout only. */
  extraTime: number;
  shootouts: number;
  advanceHome: number;
  /** Matches in which each scorer id scored at least once / scored first. */
  anytime: Record<string, number>;
  first: Record<string, number>;
  twoPlus: Record<string, number>;
};

const CAP = 9;

export function emptyBatch(): SoccerBatch {
  return {
    n: 0,
    home: 0,
    draw: 0,
    away: 0,
    scores: Array.from({ length: CAP + 1 }, () => new Array<number>(CAP + 1).fill(0)),
    totals: new Array<number>(11).fill(0),
    bttsYes: 0,
    homeCleanSheet: 0,
    awayCleanSheet: 0,
    homeGoals: 0,
    awayGoals: 0,
    extraTime: 0,
    shootouts: 0,
    advanceHome: 0,
    anytime: {},
    first: {},
    twoPlus: {},
  };
}

export function addResult(b: SoccerBatch, r: MatchResult, firstScorer: string | null) {
  b.n += 1;
  if (r.hg90 > r.ag90) b.home += 1;
  else if (r.hg90 === r.ag90) b.draw += 1;
  else b.away += 1;
  b.scores[Math.min(r.hg90, CAP)][Math.min(r.ag90, CAP)] += 1;
  b.totals[Math.min(r.hg90 + r.ag90, 10)] += 1;
  if (r.hg90 > 0 && r.ag90 > 0) b.bttsYes += 1;
  if (r.ag90 === 0) b.homeCleanSheet += 1;
  if (r.hg90 === 0) b.awayCleanSheet += 1;
  b.homeGoals += r.hg90;
  b.awayGoals += r.ag90;
  if (r.extraTime) b.extraTime += 1;
  if (r.shootout) b.shootouts += 1;
  if (r.advances === "home") b.advanceHome += 1;
  // Scorer markets settle on 90 minutes too, so extra-time goals are left out.
  const counts = new Map<string, number>();
  for (const id of r.homeScorers.slice(0, r.hg90)) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of r.awayScorers.slice(0, r.ag90)) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, c] of counts) {
    if (id === "og") continue;
    b.anytime[id] = (b.anytime[id] ?? 0) + 1;
    if (c >= 2) b.twoPlus[id] = (b.twoPlus[id] ?? 0) + 1;
  }
  if (firstScorer && firstScorer !== "og") b.first[firstScorer] = (b.first[firstScorer] ?? 0) + 1;
}

export function mergeBatch(a: SoccerBatch, b: SoccerBatch): SoccerBatch {
  const out = emptyBatch();
  for (const k of [
    "n",
    "home",
    "draw",
    "away",
    "bttsYes",
    "homeCleanSheet",
    "awayCleanSheet",
    "homeGoals",
    "awayGoals",
    "extraTime",
    "shootouts",
    "advanceHome",
  ] as const)
    out[k] = a[k] + b[k];
  for (let i = 0; i <= CAP; i += 1)
    for (let j = 0; j <= CAP; j += 1) out.scores[i][j] = a.scores[i][j] + b.scores[i][j];
  for (let i = 0; i < out.totals.length; i += 1) out.totals[i] = a.totals[i] + b.totals[i];
  for (const key of ["anytime", "first", "twoPlus"] as const) {
    for (const src of [a[key], b[key]])
      for (const [id, c] of Object.entries(src)) out[key][id] = (out[key][id] ?? 0) + c;
  }
  return out;
}

/** Play `n` matches. Events are logged so the first scorer is known. */
export function runBatch(
  n: number,
  seed: number,
  home: SoccerSide,
  away: SoccerSide,
  opts: SoccerSimOptions = {},
  engine = new SoccerEngine(),
): SoccerBatch {
  const rng = new Rng(seed);
  const b = emptyBatch();
  for (let i = 0; i < n; i += 1) {
    const r = engine.play(rng, home, away, opts, true);
    const firstGoal = r.events!.find((e) => e.kind !== "red" && e.minute <= 90);
    addResult(b, r, firstGoal?.player ?? null);
  }
  return b;
}
