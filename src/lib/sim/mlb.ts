/**
 * mlb.ts — a plate-appearance-by-plate-appearance baseball engine.
 *
 * Each plate appearance is one draw from seven outcomes — walk, strikeout,
 * home run, triple, double, single, ball in play for an out — with the
 * probability of each set by the odds-ratio method: the batter's rate times
 * the pitcher's rate over the league's, then normalised. A .400 OBP hitter
 * against an ace and against a mop-up man are different plate appearances,
 * which is the whole point of simulating at this level.
 *
 * Around the matchup: a base-out state machine with realistic advancement
 * (a single scores the runner from second about six times in ten), double
 * plays, sacrifice flies, stolen bases, reached-on-error, the park, a starter
 * who tires the third time through the order and gets pulled on a pitch count
 * or a bad inning, a bullpen used by leverage — closer in a save situation,
 * set-up man in the eighth, the long men when it's out of hand — the ghost
 * runner in regular-season extras, and a walk-off ending.
 */

import { available, Box, finish, Log, ordinal, Rng } from "./core";
import { MLB } from "./columns";
import type {
  GameResult,
  MlbBatter,
  MlbEnv,
  MlbPitcher,
  MlbTeam,
  PaRates,
  SimMatchup,
  SimOverrides,
  Side,
} from "./types";

type MlbMatchup = Extract<SimMatchup, { league: "mlb" }>;

// Calibration — two average lineups in a neutral park score the league's
// runs per game, and an average home team wins ~53%. See SIMULATOR.md.
const RUN_CAL = 1.01;
const HOME_ONBASE = 0.012;
const TTO_MULT = 1.05; // third time through the order
const MAX_PITCHES = 108;

interface TeamPrep {
  team: MlbTeam;
  /** Batting order: indices into team.batters. */
  order: number[];
  /** The named starter, or -1 to draw one from the rotation each game. */
  starter: number; // index into team.pitchers
  /** The rotation, weighted by starts, for when nobody is named. */
  rotation: number[];
  /** Bullpen by role, indices into team.pitchers. */
  closer: number;
  setup: number[];
  middle: number[];
  long: number[];
  homeF: number;
}

export interface MlbPrep {
  m: MlbMatchup;
  t: [TeamPrep, TeamPrep];
  env: MlbEnv;
  park: number;
  playoff: boolean;
  nBatters: [number, number];
}

const quality = (p: MlbPitcher) => p.rates.so - p.rates.bb - 3 * p.rates.hr;

function lineupFor(team: MlbTeam, ok: (p: MlbBatter) => boolean): number[] {
  const pool = team.batters
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => ok(b) && b.pos !== "SP" && b.pos !== "RP" && b.pos !== "P")
    .sort((a, b) => b.b.pa - a.b.pa)
    .slice(0, 9);
  // Fewer than nine healthy position players: pull in anyone left.
  if (pool.length < 9)
    for (const [i, b] of team.batters.entries())
      if (pool.length < 9 && !pool.some((x) => x.i === i)) pool.push({ b, i });
  // A conventional order: best on-base man leads off, the best overall hitter
  // bats second, the next two hit third and fourth, the rest by OPS.
  const byOps = pool.slice().sort((a, b) => b.b.ops - a.b.ops);
  const top4 = byOps.slice(0, 5);
  const lead = top4.slice().sort((a, b) => b.b.obp - a.b.obp)[0];
  const rest = byOps.filter((x) => x !== lead);
  const order = [lead, rest[0], rest[1], rest[2], ...rest.slice(3)].filter(Boolean);
  return order.map((x) => x.i);
}

function prepTeam(team: MlbTeam, side: Side, o: SimOverrides, neutral: boolean): TeamPrep {
  const benched = new Set(o.benched);
  const activated = new Set(o.activated);
  const ok = (p: { id: string; status: string }) => available(p, benched, activated);
  const order = lineupFor(team, ok);
  const arms = team.pitchers.map((p, i) => ({ p, i })).filter(({ p }) => ok(p));
  const want = o.starter?.[side] ?? team.probable;
  // Nobody named (a made-up matchup, or a game whose probables are not out
  // yet): each simulated game draws its starter from the rotation in
  // proportion to starts, so a thousand games see the staff, not just the ace.
  const starter = want && want !== "rotation" ? team.pitchers.findIndex((p) => p.id === want) : -1;
  const rotation = arms
    .filter(({ p }) => p.starts >= 3 && p.bfPerStart >= 12)
    .sort((a, b) => b.p.starts - a.p.starts)
    .slice(0, 5)
    .map(({ i }) => i);
  if (!rotation.length && arms.length) rotation.push(arms[0].i);
  const pen = arms.filter(
    ({ i, p }) => i !== starter && !rotation.includes(i) && (p.starts < 5 || p.bfPerStart < 12),
  );
  // The pen: closer by saves, set-up men by holds, then the rest by quality.
  // Arms that mostly start but aren't today's starter are the long men.
  const byS = pen.slice().sort((a, b) => b.p.saves - a.p.saves || quality(b.p) - quality(a.p));
  const closer = byS[0]?.i ?? -1;
  const rest = pen.filter(({ i }) => i !== closer);
  const setup = rest
    .slice()
    .sort((a, b) => b.p.holds - a.p.holds || quality(b.p) - quality(a.p))
    .slice(0, 2)
    .map(({ i }) => i);
  const middle = rest
    .filter(({ i }) => !setup.includes(i))
    .sort((a, b) => quality(b.p) - quality(a.p))
    .map(({ i }) => i);
  // Long men: arms with starts behind them who are not in today's rotation.
  const long = arms
    .filter(
      ({ i, p }) => i !== starter && !rotation.includes(i) && p.starts >= 3 && p.bfPerStart >= 9,
    )
    .map(({ i }) => i);
  const homeF = neutral ? 1 : side === "home" ? 1 + HOME_ONBASE : 1 - HOME_ONBASE;
  return { team, order, starter, rotation, closer, setup, middle, long, homeF };
}

export function prepareMlb(m: MlbMatchup, o: SimOverrides): MlbPrep {
  const neutral = o.neutral ?? m.ctx.neutral;
  return {
    m,
    t: [prepTeam(m.home, "home", o, neutral), prepTeam(m.away, "away", o, neutral)],
    env: m.env,
    park: neutral ? 100 : (m.ctx.park ?? 100),
    playoff: o.playoff ?? m.ctx.playoff,
    nBatters: [m.home.batters.length, m.away.batters.length],
  };
}

// --------------------------------------------------------- the matchup

const KEYS = ["bb", "so", "hr", "b3", "b2", "b1"] as const;
type Outcome = (typeof KEYS)[number] | "out";

const odds = (x: number) => x / Math.max(1e-6, 1 - x);

/**
 * Odds-ratio combination of batter, pitcher and league for each outcome: the
 * batter's odds, times how much better or worse than the league this pitcher
 * is at allowing it.
 */
function paProbs(b: PaRates, p: PaRates, env: MlbEnv, onBase: number, park: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (const k of KEYS) {
    const o = (odds(b[k]) * odds(p[k])) / Math.max(1e-9, odds(env.pRates[k]));
    let v = o / (1 + o);
    if (k !== "so") v *= onBase;
    if (k === "hr") v *= Math.pow(park / 100, 1.3);
    else if (k !== "so" && k !== "bb") v *= Math.pow(park / 100, 0.6);
    out.push(v);
    sum += v;
  }
  if (sum > 0.85) for (let i = 0; i < out.length; i++) out[i] *= 0.85 / sum;
  return out;
}

// ------------------------------------------------------------------ game

export function playMlb(prep: MlbPrep, seed: number, record: boolean): GameResult {
  const rng = new Rng(seed);
  const flavor = new Rng(seed ^ 0x5bd1e995);
  const T = prep.t;
  const env = prep.env;
  const nb = prep.nBatters;
  const box = new Box(
    nb[0] + T[0].team.pitchers.length,
    nb[1] + T[1].team.pitchers.length,
    MLB.N,
    record,
  );
  const log = new Log(record, box);
  const pIdx = (s: number, p: number) => nb[s] + p;
  const score = [0, 0];
  const hits = [0, 0];
  const errors = [0, 0];
  const lob = [0, 0];
  const periods = { home: [] as number[], away: [] as number[] };
  const lineupPos = [0, 0];
  // Today's starters: the named one, or a draw from the rotation.
  const starters = T.map((tp) => {
    if (tp.starter >= 0) return tp.starter;
    const w = tp.rotation.map((i) => Math.max(1, tp.team.pitchers[i].starts));
    return tp.rotation[rng.pick(w)] ?? 0;
  });
  // Per pitching side: current pitcher, his pitches and batters faced today,
  // the order he came in, and who's been used.
  const cur = [starters[0], starters[1]];
  const pitches = [0, 0];
  const faced = [0, 0];
  const runsThisOuting = [0, 0];
  const used = [new Set<number>([starters[0]]), new Set<number>([starters[1]])];
  const appearances = [1, 1];
  // Leash: the pitch count this starter is allowed today.
  const leash = [0, 1].map((s) => {
    const p = T[s].team.pitchers[starters[s]];
    const expected = Math.max(60, Math.min(MAX_PITCHES, (p?.bfPerStart ?? 22) * 3.9));
    return expected + rng.normal(0, 9);
  });
  T.forEach((tp, s) => {
    tp.order.forEach((b, k) => box.add(s, b, MLB.ORDER, k + 1));
    box.add(s, pIdx(s, starters[s]), MLB.APP, 1);
  });

  const bat = (s: number, b: number): MlbBatter => T[s].team.batters[b];
  const pit = (s: number): MlbPitcher => T[s].team.pitchers[cur[s]];
  // Who is the pitcher of record for the win and the loss.
  // [side, pitcher index]; a holder object because closures update it.
  const decision: { win: [number, number] | null; lose: [number, number] | null } = {
    win: null,
    lose: null,
  };
  let leader = -1; // side currently ahead
  const starterOuts = [0, 0];

  let inning = 1;
  let half: 0 | 1 = 0; // 0 top (away bats), 1 bottom (home bats)
  let outs = 0;
  // Bases hold the batter index of the runner, or -1; plus who "owns" him.
  let bases: number[] = [-1, -1, -1];
  let owner: number[] = [-1, -1, -1];
  let earned: boolean[] = [true, true, true];

  const battingSide = () => (half === 0 ? 1 : 0);
  const fieldSide = () => (half === 0 ? 0 : 1);
  const baseMask = () =>
    (bases[0] >= 0 ? 1 : 0) | (bases[1] >= 0 ? 2 : 0) | (bases[2] >= 0 ? 4 : 0);

  const label = () => `${half === 0 ? "Top" : "Bot"} ${ordinal(inning)}`;
  const ev = (
    side: number | null,
    text: string,
    extra: { scoring?: boolean; big?: boolean } = {},
  ) =>
    log.push({
      period: inning,
      clock: label(),
      side: side === null ? null : side === 0 ? "home" : "away",
      text,
      home: score[0],
      away: score[1],
      bases: baseMask(),
      outs,
      ...extra,
    });

  const walkoffDone = () => inning >= 9 && half === 1 && score[0] > score[1];

  const updateLeader = (f: number, resp: number) => {
    const nowLeader = score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1;
    if (nowLeader === leader) return;
    // The pitcher of record for the side that just went ahead, and the one
    // who gave up the go-ahead run.
    if (nowLeader >= 0) {
      decision.win = [nowLeader, cur[nowLeader]];
      decision.lose = [f, resp];
    } else {
      decision.win = null;
      decision.lose = null;
    }
    leader = nowLeader;
  };

  /** One run in: the runner scores, the batter maybe gets the RBI, and the
   *  pitcher who put the runner on base is charged with it. */
  const credit = (
    s: number,
    runner: number,
    by: number,
    rbi: boolean,
    resp: number,
    isEarned: boolean,
  ) => {
    const f = 1 - s;
    score[s]++;
    box.add(s, runner, MLB.R, 1);
    if (rbi && by >= 0) box.add(s, by, MLB.RBI, 1);
    box.add(f, pIdx(f, resp), MLB.PR, 1);
    if (isEarned) box.add(f, pIdx(f, resp), MLB.PER, 1);
    runsThisOuting[f]++;
    updateLeader(f, resp);
  };

  /** Put the batter's runner on base `b` (0-2), credited to the current pitcher. */
  const place = (b: number, runner: number, isEarned = true) => {
    bases[b] = runner;
    owner[b] = cur[fieldSide()];
    earned[b] = isEarned;
  };
  const clear = (b: number) => {
    bases[b] = -1;
    owner[b] = -1;
    earned[b] = true;
  };
  const move = (from: number, to: number) => {
    bases[to] = bases[from];
    owner[to] = owner[from];
    earned[to] = earned[from];
    clear(from);
  };
  /** Runner on `from` scores — unless the game has already been won on
   *  this play, in which case only the winning run counts. */
  const home = (s: number, from: number, by: number, rbi: boolean) => {
    const r = bases[from];
    if (r < 0) return;
    if (!walkoffDone())
      credit(s, r, by, rbi, owner[from] >= 0 ? owner[from] : cur[1 - s], earned[from]);
    clear(from);
  };

  const addPitches = (f: number, n: number) => {
    pitches[f] += n;
    box.add(f, pIdx(f, cur[f]), MLB.NP, n);
  };

  const outBy = (f: number, n = 1) => {
    outs += n;
    box.add(f, pIdx(f, cur[f]), MLB.OUTS, n);
    if (appearances[f] === 1) starterOuts[f] += n;
  };

  // ---------------------------------------------------------- bullpen

  const fresh = (list: number[], f: number) => list.filter((i) => i >= 0 && !used[f].has(i));

  const bring = (f: number, p: number, why: string) => {
    if (p < 0 || p === cur[f]) return;
    const before = pit(f);
    cur[f] = p;
    used[f].add(p);
    pitches[f] = 0;
    faced[f] = 0;
    runsThisOuting[f] = 0;
    appearances[f]++;
    box.add(f, pIdx(f, p), MLB.APP, appearances[f]);
    if (log.on)
      ev(f, `Pitching change: ${pit(f).short} replaces ${before.short}${why ? ` (${why})` : ""}`);
  };

  /** Should the fielding side make a change before this batter? */
  const manage = (f: number) => {
    const s = 1 - f;
    const tp = T[f];
    const lead = score[f] - score[s];
    const isStarter = appearances[f] === 1;
    const late = inning >= 8;
    const atInningStart = outs === 0 && baseMask() === 0;
    if (isStarter) {
      const tired = pitches[f] >= leash[f];
      const shelled = runsThisOuting[f] >= 5 && inning >= 3 ? true : runsThisOuting[f] >= 7;
      const struggling =
        runsThisOuting[f] >= 4 && baseMask() !== 0 && inning >= 5 && rng.chance(0.4);
      if (!tired && !shelled && !struggling) return;
    } else {
      // Relievers go an inning; long men longer.
      const isLong = tp.long.includes(cur[f]);
      const limit = isLong ? 40 : 22;
      if (!(atInningStart && faced[f] >= 3) && pitches[f] < limit && runsThisOuting[f] < 3) return;
      if (!atInningStart && pitches[f] < limit + 8 && runsThisOuting[f] < 3) return;
    }
    // Choose by leverage.
    const save = lead >= 1 && lead <= 3;
    let next = -1;
    if (inning >= 9 && (save || (lead === 0 && f === 0))) next = fresh([tp.closer], f)[0] ?? -1;
    if (next < 0 && late && Math.abs(lead) <= 3) next = fresh(tp.setup, f)[0] ?? -1;
    if (next < 0 && Math.abs(lead) >= 5 && inning <= 6) next = fresh(tp.long, f)[0] ?? -1;
    if (next < 0 && Math.abs(lead) >= 4) {
      const mid = fresh(tp.middle, f);
      next = mid[mid.length - 1] ?? -1; // the back of the pen
    }
    if (next < 0) next = fresh(tp.middle, f)[0] ?? -1;
    if (next < 0) next = fresh(tp.setup.concat(tp.long, [tp.closer]), f)[0] ?? -1;
    if (next < 0) return; // nobody left: he stays in
    bring(f, next, isStarter ? `${Math.round(pitches[f])} pitches` : "");
  };

  // ---------------------------------------------------------- the PA

  const paOutcome = (s: number, b: number): Outcome => {
    const f = 1 - s;
    const batter = bat(s, b);
    const p = pit(f);
    const tto = appearances[f] === 1 && faced[f] >= 18 ? TTO_MULT : 1;
    const probs = paProbs(
      batter.rates,
      p?.rates ?? env.pRates,
      env,
      T[s].homeF * tto * RUN_CAL,
      prep.park,
    );
    const r = rng.next();
    let acc = 0;
    for (let i = 0; i < KEYS.length; i++) {
      acc += probs[i];
      if (r < acc) return KEYS[i];
    }
    return "out";
  };

  const pitchCount = (o: Outcome): number => {
    const base = o === "so" ? 4.8 : o === "bb" ? 5.6 : 3.3;
    return Math.max(1, Math.round(base + rng.normal(0, 1.4)));
  };

  const name = (s: number, b: number) => bat(s, b).short;
  const field = ["left", "left-center", "center", "right-center", "right"];
  const where = () => field[flavor.int(0, 4)];

  const steal = (s: number) => {
    const f = 1 - s;
    if (outs >= 2 && rng.chance(0.5)) return;
    if (bases[0] >= 0 && bases[1] < 0) {
      const r = bases[0];
      if (rng.chance(bat(s, r).sbAttempt)) {
        if (rng.chance(0.79)) {
          box.add(s, r, MLB.SB, 1);
          move(0, 1);
          if (log.on) ev(s, `${name(s, r)} steals second`);
        } else {
          box.add(s, r, MLB.CS, 1);
          clear(0);
          outBy(f);
          if (log.on) ev(s, `${name(s, r)} caught stealing second`);
        }
      }
    } else if (bases[1] >= 0 && bases[2] < 0 && outs < 2) {
      const r = bases[1];
      if (rng.chance(bat(s, r).sbAttempt * 0.15)) {
        if (rng.chance(0.82)) {
          box.add(s, r, MLB.SB, 1);
          move(1, 2);
          if (log.on) ev(s, `${name(s, r)} steals third`);
        } else {
          box.add(s, r, MLB.CS, 1);
          clear(1);
          outBy(f);
          if (log.on) ev(s, `${name(s, r)} caught stealing third`);
        }
      }
    }
  };

  const plateAppearance = (s: number) => {
    const f = 1 - s;
    manage(f);
    steal(s);
    if (outs >= 3) return;
    const slot = lineupPos[s] % T[s].order.length;
    const b = T[s].order[slot];
    lineupPos[s]++;
    const o = paOutcome(s, b);
    const pi = pIdx(f, cur[f]);
    addPitches(f, pitchCount(o));
    faced[f]++;
    box.add(f, pi, MLB.BF, 1);
    box.add(s, b, MLB.PA, 1);
    const who = name(s, b);
    const before = score[s];

    if (o === "bb") {
      box.add(s, b, MLB.BB, 1);
      box.add(f, pi, MLB.PBB, 1);
      // Forced advances only.
      if (bases[0] >= 0) {
        if (bases[1] >= 0) {
          if (bases[2] >= 0) home(s, 2, b, true);
          move(1, 2);
        }
        move(0, 1);
      }
      place(0, b);
      if (log.on)
        ev(s, before < score[s] ? `${who} walks, forcing in a run` : `${who} walks`, {
          scoring: score[s] > before,
        });
      return;
    }
    box.add(s, b, MLB.AB, 1);
    if (o === "so") {
      box.add(s, b, MLB.SO, 1);
      box.add(f, pi, MLB.PSO, 1);
      outBy(f);
      if (log.on) ev(s, `${who} strikes out ${flavor.chance(0.25) ? "looking" : "swinging"}`);
      return;
    }
    if (o === "out") return ballInPlayOut(s, b);
    // A hit.
    hits[s]++;
    box.add(s, b, MLB.H, 1);
    box.add(f, pi, MLB.PH, 1);
    if (o === "hr") {
      box.add(s, b, MLB.HR, 1);
      box.add(f, pi, MLB.PHR, 1);
      const n = (bases[0] >= 0 ? 1 : 0) + (bases[1] >= 0 ? 1 : 0) + (bases[2] >= 0 ? 1 : 0);
      // Every run on a home run counts, walk-off or not.
      for (const k of [2, 1, 0])
        if (bases[k] >= 0) {
          credit(s, bases[k], b, true, owner[k] >= 0 ? owner[k] : cur[f], earned[k]);
          clear(k);
        }
      credit(s, b, b, true, cur[f], true);
      const label = n === 3 ? "grand slam" : n === 0 ? "solo home run" : `${n + 1}-run homer`;
      if (log.on) ev(s, `${who} hits a ${label} to ${where()} field`, { scoring: true, big: true });
      return;
    }
    if (o === "b3") {
      box.add(s, b, MLB.D3, 1);
      for (const k of [2, 1, 0]) home(s, k, b, true);
      place(2, b);
      if (log.on)
        ev(
          s,
          `${who} triples to ${where()} field${score[s] > before ? `, ${score[s] - before} scoring` : ""}`,
          { scoring: score[s] > before },
        );
      return;
    }
    if (o === "b2") {
      box.add(s, b, MLB.D2, 1);
      home(s, 2, b, true);
      home(s, 1, b, true);
      if (bases[0] >= 0) {
        if (rng.chance(outs === 2 ? 0.6 : 0.42)) home(s, 0, b, true);
        else move(0, 2);
      }
      place(1, b);
      if (log.on)
        ev(
          s,
          `${who} doubles to ${where()}${score[s] > before ? `, ${score[s] - before} scoring` : ""}`,
          { scoring: score[s] > before },
        );
      return;
    }
    // Single.
    home(s, 2, b, true);
    if (bases[1] >= 0) {
      if (rng.chance(outs === 2 ? 0.85 : 0.6)) home(s, 1, b, true);
      else move(1, 2);
    }
    if (bases[0] >= 0) {
      if (bases[2] < 0 && rng.chance(outs === 2 ? 0.35 : 0.27)) move(0, 2);
      else move(0, 1);
    }
    place(0, b);
    if (log.on)
      ev(
        s,
        `${who} singles to ${where()}${score[s] > before ? `, ${score[s] - before} scoring` : ""}`,
        { scoring: score[s] > before },
      );
  };

  const ballInPlayOut = (s: number, b: number) => {
    const f = 1 - s;
    const who = name(s, b);
    const r = rng.next();
    const kind = r < 0.44 ? "ground" : r < 0.8 ? "fly" : r < 0.93 ? "line" : "pop";
    // Reached on error, ~1.5% of balls in play that would be outs.
    if (rng.chance(0.016)) {
      errors[f]++;
      if (bases[2] >= 0) home(s, 2, -1, false);
      if (bases[1] >= 0) move(1, 2);
      if (bases[0] >= 0) move(0, 1);
      place(0, b, false);
      if (log.on) ev(s, `${who} reaches on a fielding error`);
      return;
    }
    const before = score[s];
    if (kind === "ground") {
      if (bases[0] >= 0 && outs < 2 && rng.chance(0.47)) {
        // 6-4-3.
        clear(0);
        outBy(f, 2);
        if (outs < 3) {
          if (bases[2] >= 0) home(s, 2, b, false);
          if (bases[1] >= 0) move(1, 2);
        }
        if (log.on) ev(s, `${who} grounds into a double play`);
        return;
      }
      outBy(f);
      if (outs < 3) {
        if (bases[2] >= 0 && rng.chance(0.45)) home(s, 2, b, true);
        if (bases[1] >= 0 && bases[2] < 0 && rng.chance(0.55)) move(1, 2);
        if (bases[0] >= 0 && bases[1] < 0 && rng.chance(0.75)) move(0, 1);
      }
      if (log.on)
        ev(s, `${who} grounds out${score[s] > before ? ", run scores" : ""}`, {
          scoring: score[s] > before,
        });
      return;
    }
    outBy(f);
    if (kind === "fly" && outs < 3) {
      if (bases[2] >= 0 && rng.chance(0.72)) {
        home(s, 2, b, true);
        if (log.on) ev(s, `${who} hits a sacrifice fly to ${where()}`, { scoring: true });
        // A sac fly is not an at-bat.
        box.add(s, b, MLB.AB, -1);
        return;
      }
      if (bases[1] >= 0 && bases[2] < 0 && rng.chance(0.3)) move(1, 2);
    }
    if (log.on) {
      const text =
        kind === "fly" ? `flies out to ${where()}` : kind === "line" ? "lines out" : "pops out";
      ev(s, `${who} ${text}`);
    }
  };

  // ---------------------------------------------------------- innings

  for (;;) {
    for (half = 0; half <= 1; half = (half + 1) as 0 | 1) {
      const s = battingSide();
      const f = fieldSide();
      // Bottom of the ninth (or later) with the home side already ahead.
      if (half === 1 && inning >= 9 && score[0] > score[1]) {
        periods.home.push(-1);
        break;
      }
      outs = 0;
      bases = [-1, -1, -1];
      owner = [-1, -1, -1];
      earned = [true, true, true];
      const startRuns = score[s];
      if (inning > 9 && !prep.playoff) {
        // The automatic runner: the hitter who made the last out of the
        // previous inning, unearned against the pitcher.
        const last = T[s].order[(lineupPos[s] - 1 + T[s].order.length) % T[s].order.length];
        bases[1] = last;
        owner[1] = cur[f];
        earned[1] = false;
      }
      if (log.on)
        ev(
          null,
          `${half === 0 ? "Top" : "Bottom"} of the ${ordinal(inning)} — ${T[f].team.pitchers[cur[f]]?.short ?? "?"} pitching`,
        );
      let guard = 0;
      while (outs < 3 && guard++ < 60) {
        plateAppearance(s);
        if (walkoffDone()) break;
      }
      if (outs >= 3)
        lob[s] += (bases[0] >= 0 ? 1 : 0) + (bases[1] >= 0 ? 1 : 0) + (bases[2] >= 0 ? 1 : 0);
      (s === 0 ? periods.home : periods.away).push(score[s] - startRuns);
      if (walkoffDone()) {
        if (log.on) ev(0, `Walk-off! ${T[0].team.name} win it`, { big: true, scoring: true });
        break;
      }
    }
    if (inning >= 9 && score[0] !== score[1]) break;
    if (inning >= 60) break; // a safety valve; no real game has come close
    inning++;
  }
  // A bottom half not played is stored as -1: zero in the sums, an "x" on
  // the scoreboard (team.home.skipBottom says which).
  const extraInnings = inning > 9;

  // Decisions. The winner is the pitcher of record when his side took the
  // lead for good — but a starter needs five innings for it; short of that
  // the first reliever after him gets it.
  const winSide = score[0] > score[1] ? 0 : 1;
  const { win: winP, lose: loseP } = decision;
  if (winP && loseP) {
    const ws = winP[0];
    let wp = winP[1];
    if (wp === starters[ws] && starterOuts[ws] < 15) {
      const relief = [...used[ws]].find((p) => p !== starters[ws]);
      if (relief !== undefined) wp = relief;
    }
    box.add(ws, pIdx(ws, wp), MLB.DEC, 1);
    box.add(loseP[0], pIdx(loseP[0], loseP[1]), MLB.DEC, 2);
    // Save: the last pitcher, not the winner, who finished a game won by
    // three or fewer.
    const last = cur[winSide];
    if (last !== wp && score[winSide] - score[1 - winSide] <= 3 && appearances[winSide] > 1)
      box.add(winSide, pIdx(winSide, last), MLB.DEC, 3);
  }

  if (log.on)
    ev(
      winSide,
      `Final${extraInnings ? `/${inning}` : ""}: ${T[winSide].team.name} ${Math.max(score[0], score[1])}, ${T[1 - winSide].team.name} ${Math.min(score[0], score[1])}`,
    );

  return finish(
    score[0],
    score[1],
    {
      home: periods.home.map((x) => Math.max(0, x)),
      away: periods.away,
    },
    box,
    log,
    {
      ot: extraInnings,
      tie: false,
      team: {
        home: {
          H: hits[0],
          E: errors[0],
          LOB: lob[0],
          skipBottom: periods.home.includes(-1) ? 1 : 0,
        },
        away: { H: hits[1], E: errors[1], LOB: lob[1] },
      },
      status: extraInnings ? `Final/${inning}` : "Final",
    },
  );
}

export function simulateMlb(
  m: MlbMatchup,
  o: SimOverrides,
  seed: number,
  record: boolean,
): GameResult {
  return playMlb(prepareMlb(m, o), seed, record);
}

/** Lineup and pitching staff as the engine will use them — for the UI. */
export function mlbPlan(m: MlbMatchup, o: SimOverrides) {
  const p = prepareMlb(m, o);
  return p.t.map((t) => ({ order: t.order, starter: t.starter, closer: t.closer, setup: t.setup }));
}

export function checkInvariants(m: MlbMatchup, r: GameResult): string[] {
  const errs: string[] = [];
  for (const side of ["home", "away"] as const) {
    const nB = m[side].batters.length;
    let runs = 0;
    let rbi = 0;
    let outs = 0;
    for (let i = 0; i < r.box[side].length; i++) {
      const row = r.box[side][i];
      if (i < nB) {
        runs += row[MLB.R];
        rbi += row[MLB.RBI];
        if (row[MLB.H] < row[MLB.D2] + row[MLB.D3] + row[MLB.HR]) errs.push("hits < xbh");
      } else outs += row[MLB.OUTS];
    }
    if (runs !== r[side]) errs.push(`${side} runs ${runs} != ${r[side]}`);
    if (rbi > runs) errs.push("rbi > runs");
    void outs;
  }
  return errs;
}
