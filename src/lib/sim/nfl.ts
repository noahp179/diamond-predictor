/**
 * nfl.ts — a snap-by-snap football engine.
 *
 * The state is what a broadcast shows: quarter, clock, down, distance, ball
 * on, score, timeouts. Each snap the offense calls a run or a pass from its
 * own pass rate bent by the situation (third-and-long, two-minute drill,
 * protecting a lead); the ball goes to a player in proportion to his carries
 * or targets; and the yards come from a distribution centred on that
 * player's own yards per carry or per catch, adjusted for the defense.
 *
 * Completion is the quarterback's accuracy combined with the receiver's catch
 * rate by odds ratio, so a 70% passer throwing to a reliable tight end
 * completes more than the same passer throwing deep to a field-stretcher.
 * Sacks are the quarterback's rate against the pass rush he's facing;
 * interceptions his rate against the coverage. Touchdowns are not drawn
 * separately — they happen when a gain carries past the goal line, which
 * is why red-zone offense comes out compressed the way it really is.
 *
 * Around it: fourth-down decisions, field goals with a distance curve and the
 * kicker's own accuracy, punts, kickoffs under the 2025 rules, turnovers,
 * penalties, timeouts, the two-minute warning, hurry-up and clock-killing,
 * kneel-downs, two-point tries, onside kicks, and overtime with both teams
 * guaranteed a possession.
 */

import { available, Box, clock, finish, Log, ordinal, Rng } from "./core";
import { NFL } from "./columns";
import type {
  GameResult,
  NflEnv,
  NflPlayer,
  NflTeam,
  SimMatchup,
  SimOverrides,
  Side,
} from "./types";

type NflMatchup = Extract<SimMatchup, { league: "nfl" }>;

// Calibration — two average teams on a neutral field score the league's
// points per game, run ~63 offensive plays each, and a home team wins ~55%.
// See SIMULATOR.md.
// A player's yards per carry and per catch already include the carries that
// were stopped by the goal line; the engine stops them at the goal line again,
// so its mean gains sit a little above the season averages they come from.
const RUN_YDS = 1.1;
/** Share of tackles made by two players, each credited (official totals). */
const ASSISTED_TKL = 0.6;
/** Concentration of tackles and sacks on the defenders who make them. */
const DEF_POW = 1.3;
/** Kneel-downs a starting quarterback's season carries hold per game. */
const KNEELS_PER_GAME = 0.8;
const PASS_YDS = 1.07;
/**
 * Game-to-game form. The same two teams do not play the same game twice —
 * game plans, weather, the injuries that happen during it — and play-level
 * randomness alone leaves simulated margins tighter than real ones (about 12
 * points around the spread instead of the NFL's ~13.5). Each side draws an
 * efficiency multiplier for the day.
 */
const FORM_SD = 0.075;
const CMP_CAL = 1.0;
const HOME_EDGE = 0.02;
/** Used only when a team's season splits are missing: points allowed, regressed. */
const DEF_FALLBACK = 0.35;
const RUNOFF = 36; // seconds between snaps with the clock running
const PENALTY_RATE = 0.05;

interface TeamPrep {
  team: NflTeam;
  qb: number;
  backupQb: number;
  rushers: number[];
  rushW: number[];
  /** The starter's yards per designed run (his season line less kneels). */
  qbYpc: number;
  targets: number[];
  targetW: number[];
  kicker: number;
  punter: number;
  def: number[];
  tackleW: number[];
  sackW: number[];
  intW: number[];
  /** Offensive efficiency multiplier (home field). */
  off: number;
  /**
   * What this defense does to the offense facing it, each relative to the
   * league (1 = average): completion odds, yards per completion, sack odds,
   * interception rate, yards per carry. From the season splits of what
   * opponents did against it, nudged by today's pass rushers and ball-hawks.
   */
  vs: { cmpOdds: number; ypc: number; sackOdds: number; int: number; rush: number };
  /** This offense's time between snaps relative to the league's (pace). */
  tempo: number;
  maxFg: number;
}

export interface NflPrep {
  m: NflMatchup;
  t: [TeamPrep, TeamPrep];
  env: NflEnv;
  playoff: boolean;
}

function prepTeam(
  team: NflTeam,
  side: Side,
  o: SimOverrides,
  m: NflMatchup,
  neutral: boolean,
): TeamPrep {
  const benched = new Set(o.benched);
  const activated = new Set(o.activated);
  const P = team.players;
  const ok = (i: number) => available(P[i], benched, activated);
  const idx = P.map((_, i) => i);
  // The starter: most attempts per game, over a sample of at least a few
  // games — a backup's long career should not outrank this year's starter.
  const qbScore = (i: number) => P[i].passAtt * Math.min(P[i].sample, 4);
  const qbs = idx.filter((i) => P[i].pos === "QB" && ok(i)).sort((a, b) => qbScore(b) - qbScore(a));
  const want = o.starter?.[side];
  let qb = want ? P.findIndex((p) => p.id === want) : -1;
  if (qb < 0) qb = qbs[0] ?? idx.find((i) => P[i].pos === "QB") ?? 0;
  const backupQb = qbs.find((i) => i !== qb) ?? qb;
  const rushers = idx.filter(
    (i) => ok(i) && P[i].carries > 0.05 && (P[i].pos !== "QB" || i === qb) && P[i].unit !== "def",
  );
  const targets = idx.filter(
    (i) => ok(i) && P[i].targets > 0.05 && P[i].pos !== "QB" && P[i].unit !== "def",
  );
  // A starting quarterback's season carries include the kneel-downs that end
  // halves and games. The engine kneels on its own, so they come out of his
  // designed runs, and his yards per carry is what he gains when he means it.
  const q = P[qb];
  const kneels = q && q.passAtt >= 15 ? Math.min(KNEELS_PER_GAME, 0.5 * q.carries) : 0;
  const qbRuns = q ? Math.max(0.05, q.carries - kneels) : 0;
  const qbYpc = q
    ? Math.min(1.6 * q.ypc_r, (q.ypc_r * q.carries + kneels) / Math.max(0.05, qbRuns))
    : 0;
  const kickers = idx.filter((i) => (P[i].pos === "PK" || P[i].pos === "K") && ok(i));
  const punters = idx.filter((i) => P[i].pos === "P" && ok(i));
  const kicker = kickers.sort((a, b) => P[b].sample - P[a].sample)[0] ?? -1;
  const punter = punters.sort((a, b) => P[b].sample - P[a].sample)[0] ?? -1;
  const def = idx.filter((i) => ok(i) && P[i].unit === "def");
  const env = m.env;
  // The defense this team puts out. Its season splits say what opponents have
  // done against it; the players dressed today adjust the pass rush and the
  // ball-hawking for whoever is missing (~2.6 sacks and ~0.8 picks a game is
  // a full-strength defense).
  const t = team.tend ?? {};
  const ratio = (key: string) => (t[key] ? t[key].value / Math.max(1e-9, t[key].league) : null);
  const oddsRatio = (key: string) =>
    t[key] ? odds(t[key].value) / Math.max(1e-9, odds(t[key].league)) : null;
  const fallback = 1 + DEF_FALLBACK * (team.pa / Math.max(1, env.ppg) - 1);
  const sackSum = def.reduce((a, i) => a + P[i].sacks, 0);
  const intSum = def.reduce((a, i) => a + P[i].ints, 0);
  const rushF = Math.max(0.7, Math.min(1.35, 1 + 0.5 * (sackSum / 2.6 - 1)));
  const coverF = Math.max(0.7, Math.min(1.35, 1 + 0.5 * (intSum / 0.8 - 1)));
  const vs = {
    cmpOdds: oddsRatio("defCmp") ?? Math.pow(fallback, 0.8),
    ypc: ratio("defYpc") ?? fallback,
    sackOdds:
      Math.pow(oddsRatio("defSack") ?? 1 / Math.sqrt(fallback), 0.75) * Math.pow(rushF, 0.25),
    int: Math.pow(ratio("defInt") ?? Math.pow(fallback, -0.7), 0.75) * Math.pow(coverF, 0.25),
    rush: ratio("defYpcRush") ?? fallback,
  };
  const pace = t.pace;
  const tempo = pace ? Math.max(0.85, Math.min(1.15, pace.league / Math.max(1, pace.value))) : 1;
  const k = kicker >= 0 ? P[kicker] : null;
  return {
    team,
    qb,
    backupQb,
    rushers,
    rushW: rushers.map((i) => (i === qb ? qbRuns : P[i].carries)),
    qbYpc,
    targets,
    targetW: targets.map((i) => P[i].targets),
    kicker,
    punter,
    def,
    // Raised to a power for the same reason as usage in nba.ts: per-game
    // lines from deeper or different depth charts overlap, and the starters
    // make the plays.
    tackleW: def.map((i) => Math.pow(P[i].tackles, DEF_POW)),
    sackW: def.map((i) => Math.pow(P[i].sacks + 0.01, DEF_POW)),
    intW: def.map((i) => P[i].ints + 0.005),
    off: neutral ? 1 : side === "home" ? 1 + HOME_EDGE : 1 - HOME_EDGE,
    vs,
    tempo,
    maxFg: k
      ? Math.max(50, Math.min(62, 53 + 25 * (k.fgSkill - 1) + (k.longFg >= 55 ? 3 : 0)))
      : 50,
  };
}

export function prepareNfl(m: NflMatchup, o: SimOverrides): NflPrep {
  const neutral = o.neutral ?? m.ctx.neutral;
  return {
    m,
    t: [prepTeam(m.home, "home", o, m, neutral), prepTeam(m.away, "away", o, m, neutral)],
    env: m.env,
    playoff: o.playoff ?? m.ctx.playoff,
  };
}

// ------------------------------------------------------------- helpers

const odds = (p: number) => p / Math.max(1e-6, 1 - p);
const prob = (o: number) => o / (1 + o);

/** League field-goal make rate by distance (yards from the kick spot). */
function fgCurve(dist: number): number {
  // ~97% from 30, ~90% from 40, ~72% from 50, ~58% from 55 — today's
  // kickers, not the 2010s'.
  return 1 / (1 + Math.exp(-(7.2 - 0.125 * dist)));
}

const QUARTER = 900;
const REG_OT = 600;
const PLAYOFF_OT = 900;

// ------------------------------------------------------------------ game

export function playNfl(prep: NflPrep, seed: number, record: boolean): GameResult {
  const rng = new Rng(seed);
  const flavor = new Rng(seed ^ 0x5bd1e995);
  const T = prep.t;
  const env = prep.env;
  const box = new Box(T[0].team.players.length, T[1].team.players.length, NFL.N, record);
  const log = new Log(record, box);
  const P = (s: number, i: number): NflPlayer => T[s].team.players[i];
  const nm = (s: number, i: number) => (i >= 0 ? P(s, i).short : T[s].team.abbr);
  const score = [0, 0];
  const periods = { home: [0, 0, 0, 0], away: [0, 0, 0, 0] };
  const team = [0, 1].map(() => ({
    YDS: 0,
    PASS: 0,
    RUSH: 0,
    FD: 0,
    TO: 0,
    PLAYS: 0,
    TOP: 0,
    PEN: 0,
    PENY: 0,
    SACKS: 0,
  }));
  const timeouts = [3, 3];
  const qb = [T[0].qb, T[1].qb];
  const form = [0, 1].map(() => Math.max(0.8, Math.min(1.2, 1 + rng.normal(0, FORM_SD))));

  let quarter = 1;
  let clk = QUARTER;
  let poss = 0;
  let yl = 25; // yards from the offense's own goal line
  let down = 1;
  let toGo = 10;
  let warned = false; // two-minute warning given this half
  let stopped = true; // is the clock stopped before the next snap?
  let gameOver = false;
  // Overtime bookkeeping.
  let otPossessions = [0, 0];
  let otSudden = false;

  const ot = () => quarter > 4;
  const half = () => (quarter <= 2 ? 1 : 2);
  const diff = (s: number) => score[s] - score[1 - s];
  const lateHalf = () => (quarter === 2 || quarter === 4 || (ot() && !prep.playoff)) && clk <= 120;

  const spot = () => {
    const s = poss;
    if (yl === 50) return "50";
    return yl < 50 ? `${T[s].team.abbr} ${yl}` : `${T[1 - s].team.abbr} ${100 - yl}`;
  };
  const sit = () => `${ordinal(down)} & ${100 - yl <= toGo ? "Goal" : toGo} at ${spot()}`;
  const absBall = () => (poss === 0 ? yl : 100 - yl);

  const ev = (
    side: number | null,
    text: string,
    extra: { scoring?: boolean; big?: boolean } = {},
  ) =>
    log.push({
      period: quarter,
      clock: clock(clk),
      side: side === null ? null : side === 0 ? "home" : "away",
      text,
      home: score[0],
      away: score[1],
      sit: sit(),
      ball: absBall(),
      ...extra,
    });

  const addScore = (s: number, pts: number) => {
    score[s] += pts;
    const q = Math.min(quarter, 5) - 1;
    const arr = s === 0 ? periods.home : periods.away;
    while (arr.length <= q) arr.push(0);
    arr[q] += pts;
  };

  // ------------------------------------------------------------ clock

  /** Burn `sec` off the clock; returns false if the quarter ran out. */
  const burn = (sec: number): boolean => {
    const t = Math.min(sec, clk);
    // Two-minute warning: the clock stops at 2:00 of each half.
    if (!warned && (quarter === 2 || quarter === 4) && clk > 120 && clk - t <= 120) {
      team[poss].TOP += clk - 120;
      clk = 120;
      warned = true;
      stopped = true;
      if (log.on) ev(null, "Two-minute warning");
      return true;
    }
    clk -= t;
    team[poss].TOP += t;
    return clk > 0;
  };

  const hurry = (s: number) =>
    (quarter === 2 && clk <= 120) ||
    (quarter === 4 && diff(s) < 0 && clk <= 300) ||
    (quarter === 4 && diff(s) < -8 && clk <= 600) ||
    (ot() && diff(s) < 0);
  const milk = (s: number) => quarter === 4 && diff(s) > 0 && clk <= 420;

  /** Time between the end of one play and the next snap. */
  const betweenPlays = () => {
    if (stopped) {
      stopped = false;
      return 0;
    }
    const s = poss;
    // The defense, trailing late, stops the clock with a timeout.
    const d = 1 - s;
    if (timeouts[d] > 0 && diff(d) < 0 && ((quarter === 4 && clk <= 150) || (ot() && clk <= 120))) {
      timeouts[d]--;
      if (log.on) ev(d, `Timeout ${T[d].team.abbr} (${timeouts[d]} left)`);
      return 0;
    }
    // The offense in its two-minute drill spends its own.
    if (timeouts[s] > 0 && hurry(s) && clk <= 60 && (quarter === 2 || diff(s) < 0)) {
      timeouts[s]--;
      if (log.on) ev(s, `Timeout ${T[s].team.abbr} (${timeouts[s]} left)`);
      return 0;
    }
    if (hurry(s)) return rng.uniform(10, 17);
    if (milk(s)) return rng.uniform(36, 40);
    if (ot()) return rng.uniform(18, 28);
    return Math.max(10, rng.normal(RUNOFF * T[s].tempo, 4));
  };

  // ------------------------------------------------------- possession

  const changePossession = (newYl: number) => {
    if (ot()) otPossessions[poss]++;
    poss = 1 - poss;
    yl = Math.max(1, Math.min(99, Math.round(newYl)));
    down = 1;
    toGo = Math.min(10, 100 - yl);
    stopped = true;
    checkOtEnd();
  };

  const checkOtEnd = () => {
    if (!ot()) return;
    if (otSudden) {
      if (score[0] !== score[1]) gameOver = true;
      return;
    }
    if (otPossessions[0] >= 1 && otPossessions[1] >= 1) {
      if (score[0] !== score[1]) gameOver = true;
      else otSudden = true;
    }
  };

  // ------------------------------------------------------------ kicks

  const kickoff = (kicking: number, onside = false) => {
    const recv = 1 - kicking;
    poss = recv;
    stopped = true;
    if (onside) {
      if (rng.chance(0.1)) {
        poss = kicking;
        yl = 48;
        if (log.on)
          ev(kicking, `Onside kick — RECOVERED by ${T[kicking].team.abbr}!`, { big: true });
      } else {
        yl = 55;
        if (log.on) ev(recv, `Onside kick recovered by ${T[recv].team.abbr}`);
      }
      down = 1;
      toGo = 10;
      return;
    }
    if (rng.chance(0.004)) {
      // Returned all the way.
      yl = 75;
      down = 1;
      toGo = 10;
      if (log.on) ev(recv, `Kickoff returned for a TOUCHDOWN!`, { scoring: true, big: true });
      touchdown(recv, -1, "kick return");
      return;
    }
    if (rng.chance(0.38)) {
      yl = 35;
      burn(0);
      if (log.on) ev(recv, `Kickoff, touchback`);
    } else {
      yl = Math.round(Math.max(8, Math.min(60, rng.normal(29, 7))));
      burn(rng.uniform(5, 8));
      if (log.on) ev(recv, `Kickoff returned to the ${spot()}`);
    }
    down = 1;
    toGo = 10;
  };

  const punt = () => {
    const s = poss;
    burn(rng.uniform(6, 9));
    const pi = T[s].punter;
    const pNet = pi >= 0 ? P(s, pi).puntNet : 41;
    const dist = 100 - yl;
    let net = Math.round(rng.normal(pNet, 7.5));
    // Pinned: inside the opponent's 40, punters aim short of the end zone.
    if (dist < 45) net = Math.min(net, dist - rng.int(3, 15));
    net = Math.max(15, net);
    if (pi >= 0) {
      box.add(s, pi, NFL.PUNT, 1);
      box.add(s, pi, NFL.PNYD, Math.min(net, dist - 20));
    }
    if (rng.chance(0.003)) {
      if (log.on) ev(s, `${nm(s, pi)} punt returned for a TOUCHDOWN!`, { big: true });
      changePossession(100 - Math.min(99, yl + net));
      yl = 99;
      touchdown(poss, -1, "punt return");
      return;
    }
    const landing = yl + net;
    if (landing >= 100) {
      if (log.on) ev(s, `${nm(s, pi)} punts ${dist} yards into the end zone, touchback`);
      changePossession(20);
    } else {
      if (log.on)
        ev(s, `${nm(s, pi)} punts ${net} yards${flavor.chance(0.4) ? ", fair catch" : ""}`);
      changePossession(100 - landing);
    }
  };

  const fieldGoal = (): boolean => {
    const s = poss;
    const ki = T[s].kicker;
    const dist = 100 - yl + 17;
    const skill = ki >= 0 ? P(s, ki).fgSkill : 0.9;
    const p = prob(odds(fgCurve(dist)) * Math.pow(skill, 4));
    const good = rng.chance(p);
    burn(5);
    if (ki >= 0) {
      box.add(s, ki, NFL.FGA, 1);
      if (good) {
        box.add(s, ki, NFL.FGM, 1);
        box.max(s, ki, NFL.FGLNG, dist);
      }
    }
    if (good) {
      addScore(s, 3);
      if (log.on)
        ev(s, `${nm(s, ki)} ${dist}-yard field goal is GOOD`, {
          scoring: true,
          big: lateHalf() || ot(),
        });
      afterScore(s);
    } else {
      if (log.on) ev(s, `${nm(s, ki)} ${dist}-yard field goal is NO GOOD`, { big: lateHalf() });
      changePossession(Math.max(20, 100 - (yl - 7)));
    }
    return good;
  };

  /** After a score: kick off, unless the game (or overtime) is over. */
  const afterScore = (s: number) => {
    if (ot()) {
      otPossessions[s]++;
      checkOtEnd();
      if (gameOver) return;
    }
    // Trailing by a score or two late, the team that just scored onside-kicks.
    const behind = -diff(s);
    const onside = quarter === 4 && clk <= 150 && behind >= 1 && behind <= 16;
    kickoff(s, onside);
  };

  const touchdown = (s: number, scorer: number, how: string) => {
    addScore(s, 6);
    void how;
    // Extra point or two?
    const d = diff(s); // after the six
    const late = quarter >= 4;
    const goFor2 = late && [-2, -5, -9, -10, -12, 1, 5].includes(d) && !(ot() && otSudden);
    if (ot() && otSudden) {
      gameOver = true;
      return;
    }
    if (goFor2 || rng.chance(0.025)) {
      const ok = rng.chance(0.48);
      if (ok) {
        addScore(s, 2);
        const who = rng.chance(0.55) ? pickTarget(s, true) : pickRusher(s, true);
        if (who >= 0) box.add(s, who, NFL.TWOPT, 1);
      }
      if (log.on) ev(s, `Two-point try ${ok ? "is GOOD" : "fails"}`, { scoring: ok });
    } else {
      const ki = T[s].kicker;
      const p = ki >= 0 ? P(s, ki).xpPct : 0.94;
      const ok = rng.chance(p);
      if (ki >= 0) {
        box.add(s, ki, NFL.XPA, 1);
        if (ok) box.add(s, ki, NFL.XPM, 1);
      }
      if (ok) addScore(s, 1);
      if (log.on)
        ev(s, `${nm(s, ki)} extra point ${ok ? "is good" : "is NO GOOD"}`, { scoring: ok });
    }
    void scorer;
    afterScore(s);
  };

  const safety = (s: number) => {
    // `s` is the defense scoring two.
    addScore(s, 2);
    if (log.on) ev(s, `SAFETY — ${T[s].team.abbr} score two`, { scoring: true, big: true });
    if (ot()) {
      gameOver = true;
      return;
    }
    // Free kick from the 20: the scoring side receives around its own 40.
    poss = s;
    yl = Math.round(rng.normal(40, 6));
    down = 1;
    toGo = 10;
    stopped = true;
  };

  // ------------------------------------------------------------ choices

  const pickRusher = (s: number, redZone: boolean): number => {
    const tp = T[s];
    if (!tp.rushers.length) return tp.qb;
    const w = tp.rushers.map(
      (i, k) => tp.rushW[k] * (redZone ? Math.sqrt(P(s, i).rushTd / 0.035) : 1),
    );
    const pick = tp.rushers[rng.pick(w)];
    // The injured starter's runs go to whoever is under centre now.
    return pick === tp.qb ? qb[s] : pick;
  };

  const pickTarget = (s: number, redZone: boolean): number => {
    const tp = T[s];
    if (!tp.targets.length) return -1;
    const w = tp.targets.map(
      (i, k) => tp.targetW[k] * (redZone ? Math.sqrt(P(s, i).recTd / 0.05) : 1),
    );
    return tp.targets[rng.pick(w)];
  };

  /** Credit the tackle on a play: one man, and often a second sharing it —
   *  official totals count an assisted tackle for each, which is what the
   *  season lines being compared against hold. Returns the first. */
  const tackle = (d: number): number => {
    const t = tackler(d);
    if (t < 0) return t;
    box.add(d, t, NFL.TKL, 1);
    if (rng.chance(ASSISTED_TKL)) {
      const t2 = tackler(d);
      if (t2 >= 0 && t2 !== t) box.add(d, t2, NFL.TKL, 1);
    }
    return t;
  };

  const tackler = (d: number): number => {
    const tp = T[d];
    if (!tp.def.length) return -1;
    return tp.def[rng.pick(tp.tackleW)];
  };

  const passRate = (s: number): number => {
    // The team's season pass rate already includes its third downs and its
    // comebacks, so the early-down base sits a little under it.
    let p = T[s].team.passRate - 0.04;
    const dist = 100 - yl;
    if (down === 3) p = toGo >= 5 ? 0.9 : toGo >= 3 ? 0.72 : 0.45;
    else if (down === 4) p = toGo >= 3 ? 0.85 : 0.5;
    else if (down === 2 && toGo >= 8) p += 0.08;
    else if (down === 1) p -= 0.05;
    const d = diff(s);
    if (hurry(s)) p = Math.max(p, 0.82);
    else if (milk(s)) p = Math.min(p, 0.28);
    else if (half() === 2 && d <= -9) p += 0.1;
    else if (quarter === 4 && d >= 10) p -= 0.15;
    if (dist <= 2) p = Math.min(p, 0.42);
    return Math.max(0.15, Math.min(0.95, p));
  };

  /** Fourth down: go, kick or punt. */
  const fourthDown = (): "go" | "fg" | "punt" => {
    const s = poss;
    const dist = 100 - yl;
    const fgDist = dist + 17;
    const inRange = fgDist <= T[s].maxFg;
    const d = diff(s);
    const late = quarter === 4 || ot();
    const timeLeft = clk;
    // Late and needing a touchdown: there is no punting.
    if (late && d < -3 && timeLeft <= 300) return "go";
    if (late && d < 0 && timeLeft <= 120 && !inRange) return "go";
    if (late && d >= -3 && d <= 0 && inRange && (timeLeft <= 120 || toGo > 3)) return "fg";
    if (ot() && otPossessions[1 - s] >= 1 && d < 0 && !inRange) return "go";
    if (toGo <= 1 && yl >= 35 && dist > 2) return rng.chance(0.7) ? "go" : inRange ? "fg" : "punt";
    if (toGo <= 1 && dist <= 2) return rng.chance(0.55) ? "go" : "fg";
    if (inRange) return toGo <= 2 && dist <= 10 && rng.chance(0.35) ? "go" : "fg";
    if (toGo <= 3 && yl >= 55) return rng.chance(0.5) ? "go" : "punt";
    if (toGo <= 2 && yl >= 45) return rng.chance(0.35) ? "go" : "punt";
    return "punt";
  };

  // ------------------------------------------------------------ plays

  const gain = (s: number, yards: number, rusher: boolean) => {
    team[s].YDS += yards;
    if (rusher) team[s].RUSH += yards;
    else team[s].PASS += yards;
  };

  /** Advance the chains after a gain; returns true if the drive continues. */
  const spotBall = (yards: number): boolean => {
    yl += yards;
    if (yards >= toGo) {
      down = 1;
      toGo = Math.min(10, 100 - yl);
      team[poss].FD++;
      return true;
    }
    toGo -= yards;
    down++;
    if (down > 4) {
      if (log.on) ev(1 - poss, `Turnover on downs`);
      changePossession(100 - yl);
      return false;
    }
    return true;
  };

  const runYards = (mean: number): number => {
    // Most runs bunch around three yards; one in twenty-five breaks loose.
    if (rng.chance(0.04)) return Math.round(9 + rng.exp(11));
    const mb = (mean - 0.04 * 20) / 0.96;
    return Math.round(rng.gamma(2.5, (mb + 2) / 2.5) - 2);
  };

  const catchYards = (mean: number): number => {
    if (rng.chance(0.05)) return Math.round(20 + rng.exp(14));
    const mb = (mean - 0.05 * 34) / 0.95;
    return Math.round(rng.gamma(1.8, (Math.max(2, mb) + 1.5) / 1.8) - 1.5);
  };

  const runPlay = () => {
    const s = poss;
    const d = 1 - s;
    const dist = 100 - yl;
    const r = pickRusher(s, dist <= 20);
    const pl = P(s, r);
    const ypc = r === T[s].qb ? T[s].qbYpc : pl.ypc_r;
    const mean = ypc * RUN_YDS * T[d].vs.rush * T[s].off * form[s];
    let y = runYards(mean);
    if (y > dist) y = dist;
    team[s].PLAYS++;
    box.add(s, r, NFL.CAR, 1);
    // Fumble?
    if (rng.chance(pl.fumble)) {
      box.add(s, r, NFL.RYD, y);
      gain(s, y, true);
      box.add(s, r, NFL.FUM, 1);
      team[s].TO++;
      burn(6);
      const rec = tackler(d);
      if (log.on)
        ev(s, `${nm(s, r)} runs for ${y}, FUMBLES — recovered by ${nm(d, rec)}`, { big: true });
      changePossession(100 - Math.min(99, yl + Math.max(0, y)));
      return;
    }
    box.add(s, r, NFL.RYD, y);
    box.max(s, r, NFL.RLNG, y);
    gain(s, y, true);
    const dir = [
      "up the middle",
      "off left tackle",
      "off right tackle",
      "around left end",
      "around right end",
    ][flavor.int(0, 4)];
    if (yl + y <= 0) {
      burn(5);
      if (log.on) ev(s, `${nm(s, r)} ${dir}, tackled in the end zone`);
      safety(d);
      return;
    }
    if (y >= dist) {
      box.add(s, r, NFL.RTD, 1);
      burn(rng.uniform(4, 7));
      if (log.on) ev(s, `TOUCHDOWN — ${nm(s, r)} ${dist}-yard run`, { scoring: true, big: true });
      yl = 100;
      touchdown(s, r, "run");
      return;
    }
    const t = tackle(d);
    burn(rng.uniform(4, 7));
    // Out of bounds stops the clock only late in a half.
    stopped =
      lateHalf() || (quarter === 4 && clk <= 300) ? rng.chance(hurry(s) ? 0.35 : 0.08) : false;
    if (log.on)
      ev(
        s,
        `${nm(s, r)} ${dir} for ${y} yard${Math.abs(y) === 1 ? "" : "s"}${t >= 0 ? ` (${nm(d, t)})` : ""}`,
        { big: y >= 20 },
      );
    spotBall(y);
  };

  const passPlay = () => {
    const s = poss;
    const d = 1 - s;
    const q = qb[s];
    const qp = P(s, q);
    const dist = 100 - yl;
    team[s].PLAYS++;
    // Sack?
    // The quarterback's sack rate against this pass rush, by odds ratio.
    const pSack = Math.min(0.2, prob(odds(qp.sackRate) * T[d].vs.sackOdds));
    if (rng.chance(pSack)) {
      const loss = Math.max(1, Math.round(rng.normal(7, 2.5)));
      const sacker = T[d].def.length ? T[d].def[rng.pick(T[d].sackW)] : -1;
      box.add(s, q, NFL.SK, 1);
      box.add(s, q, NFL.SKY, loss);
      if (sacker >= 0) box.add(d, sacker, NFL.DSK, 1);
      team[s].SACKS++;
      gain(s, -loss, false);
      burn(rng.uniform(5, 7));
      if (log.on) ev(s, `${nm(s, q)} sacked by ${nm(d, sacker)} for -${loss}`);
      if (yl - loss <= 0) return safety(d);
      // Strip-sack.
      if (rng.chance(0.06)) {
        box.add(s, q, NFL.FUM, 1);
        team[s].TO++;
        if (log.on)
          ev(s, `${nm(s, q)} FUMBLES on the sack — ${T[d].team.abbr} recover`, { big: true });
        changePossession(100 - (yl - loss));
        return;
      }
      spotBall(-loss);
      return;
    }
    const tgt = pickTarget(s, dist <= 20);
    box.add(s, q, NFL.ATT, 1);
    if (tgt >= 0) box.add(s, tgt, NFL.TGT, 1);
    // Interception?
    const pInt = Math.min(0.12, qp.intRate * T[d].vs.int);
    const where = [
      "short left",
      "short middle",
      "short right",
      "deep left",
      "deep middle",
      "deep right",
    ][flavor.int(0, 5)];
    if (rng.chance(pInt)) {
      box.add(s, q, NFL.INT, 1);
      team[s].TO++;
      const picker = T[d].def.length ? T[d].def[rng.pick(T[d].intW)] : -1;
      if (picker >= 0) box.add(d, picker, NFL.DINT, 1);
      const air = Math.min(dist - 1, Math.max(1, Math.round(rng.gamma(2, 6.5))));
      const ret = Math.round(Math.max(0, rng.gamma(1.1, 9)));
      burn(rng.uniform(6, 9));
      const newYl = 100 - (yl + air);
      if (newYl + ret >= 100) {
        if (log.on)
          ev(
            d,
            `${nm(s, q)} pass ${where} INTERCEPTED by ${nm(d, picker)} and returned for a TOUCHDOWN`,
            { scoring: true, big: true },
          );
        if (picker >= 0) box.add(d, picker, NFL.DTD, 1);
        changePossession(99);
        yl = 100;
        touchdown(poss, picker, "interception return");
        return;
      }
      if (log.on) ev(s, `${nm(s, q)} pass ${where} INTERCEPTED by ${nm(d, picker)}`, { big: true });
      changePossession(newYl + ret);
      return;
    }
    if (tgt < 0) {
      burn(5);
      stopped = true;
      spotBall(0);
      return;
    }
    const rp = P(s, tgt);
    // Completion: QB accuracy × receiver's hands, relative to the league,
    // against this coverage.
    const pCmp = prob(
      ((odds(qp.cmpPct) * odds(rp.catchRate)) / odds(env.cmpPct)) *
        CMP_CAL *
        T[s].off *
        form[s] *
        T[d].vs.cmpOdds,
    );
    if (!rng.chance(Math.min(0.92, pCmp))) {
      burn(rng.uniform(4, 7));
      stopped = true;
      if (log.on) ev(s, `${nm(s, q)} pass incomplete ${where} intended for ${nm(s, tgt)}`);
      spotBall(0);
      return;
    }
    const mean =
      rp.ypr * Math.pow(qp.ypc / env.ypc, 0.6) * PASS_YDS * T[d].vs.ypc * T[s].off * form[s];
    let y = catchYards(mean);
    if (y > dist) y = dist;
    if (yl + y <= 0) y = 1 - yl;
    box.add(s, q, NFL.CMP, 1);
    box.add(s, q, NFL.PYD, y);
    box.add(s, tgt, NFL.REC, 1);
    box.add(s, tgt, NFL.REYD, y);
    box.max(s, tgt, NFL.RELNG, y);
    gain(s, y, false);
    if (rng.chance(rp.fumble * 0.6)) {
      box.add(s, tgt, NFL.FUM, 1);
      team[s].TO++;
      burn(6);
      if (log.on)
        ev(
          s,
          `${nm(s, q)} pass ${where} to ${nm(s, tgt)} for ${y}, FUMBLE — ${T[d].team.abbr} recover`,
          { big: true },
        );
      changePossession(100 - Math.min(99, yl + y));
      return;
    }
    if (y >= dist) {
      box.add(s, q, NFL.PTD, 1);
      box.add(s, tgt, NFL.RETD, 1);
      burn(rng.uniform(5, 8));
      if (log.on)
        ev(s, `TOUCHDOWN — ${nm(s, q)} ${dist}-yard pass to ${nm(s, tgt)}`, {
          scoring: true,
          big: true,
        });
      yl = 100;
      touchdown(s, tgt, "pass");
      return;
    }
    const t = tackle(d);
    burn(rng.uniform(5, 8));
    const oob = hurry(s) ? 0.35 : 0.12;
    stopped = (lateHalf() || (quarter === 4 && clk <= 300)) && rng.chance(oob);
    if (log.on)
      ev(
        s,
        `${nm(s, q)} pass ${where} to ${nm(s, tgt)} for ${y} yard${Math.abs(y) === 1 ? "" : "s"}${t >= 0 ? ` (${nm(d, t)})` : ""}`,
        { big: y >= 25 },
      );
    spotBall(y);
  };

  const penalty = (): boolean => {
    if (!rng.chance(PENALTY_RATE)) return false;
    const s = poss;
    const onOffense = rng.chance(0.47);
    const pass = rng.chance(0.6);
    if (onOffense) {
      const hold = pass && rng.chance(0.55);
      const yds = hold ? 10 : 5;
      const loss = Math.min(yds, Math.floor((yl - 1) / 2) || 1);
      yl -= loss;
      toGo += loss;
      team[s].PEN++;
      team[s].PENY += loss;
      if (log.on)
        ev(
          s,
          `PENALTY ${T[s].team.abbr}: ${hold ? "offensive holding" : "false start"}, ${loss} yards`,
        );
      stopped = !hold;
      if (hold) burn(6);
      return true;
    }
    const d = 1 - s;
    const pi = pass && rng.chance(0.35);
    let yds = pi ? Math.min(Math.max(5, Math.round(rng.gamma(2, 9))), 99 - yl) : 5;
    yds = Math.min(yds, Math.max(1, Math.floor((100 - yl) / 2)));
    team[d].PEN++;
    team[d].PENY += yds;
    yl += yds;
    if (pi || yds >= toGo) {
      down = 1;
      toGo = Math.min(10, 100 - yl);
      team[s].FD++;
    } else toGo -= yds;
    if (log.on)
      ev(
        d,
        `PENALTY ${T[d].team.abbr}: ${pi ? "pass interference" : flavor.chance(0.5) ? "offside" : "defensive holding"}, ${yds} yards${pi ? ", automatic first down" : ""}`,
      );
    if (pi) burn(6);
    stopped = true;
    return true;
  };

  const kneel = (): boolean => {
    const s = poss;
    const d = 1 - s;
    if (quarter === 4 && diff(s) > 0) {
      const kneels = 4 - down + 1;
      const canBurn = kneels * 40 - timeouts[d] * 38;
      if (clk <= canBurn && clk > 0) return true;
    }
    // Run out the half from deep in their own end rather than risk a turnover.
    if (quarter === 2 && clk <= 25 && yl < 30 && diff(s) >= -3 && !stopped) return true;
    return false;
  };

  // ---------------------------------------------------------- the snap

  const snap = () => {
    const s = poss;
    // Clock runs between plays.
    const between = betweenPlays();
    if (between > 0 && !burn(between)) return;
    if (clk <= 0) return;
    if (kneel()) {
      box.add(s, qb[s], NFL.CAR, 1);
      box.add(s, qb[s], NFL.RYD, -1);
      gain(s, -1, true);
      team[s].PLAYS++;
      burn(rng.uniform(2, 3));
      if (log.on) ev(s, `${nm(s, qb[s])} kneels`);
      yl -= 1;
      down++;
      toGo += 1;
      // The clock runs out on its own: give the next snap its runoff.
      stopped = false;
      if (down > 4) changePossession(100 - yl);
      return;
    }
    // End of half: kick it if in range with the clock nearly gone.
    const fgDist = 100 - yl + 17;
    const inRange = fgDist <= T[s].maxFg;
    const fgHelps = quarter !== 4 || (diff(s) >= -3 && diff(s) <= 0) || ot();
    if ((quarter === 2 || quarter === 4 || ot()) && clk <= 6 && inRange && fgHelps) {
      fieldGoal();
      return;
    }
    if (down === 4) {
      const call = fourthDown();
      if (call === "punt") return punt();
      if (call === "fg") return void fieldGoal();
    }
    if (penalty()) return;
    if (rng.chance(passRate(s))) passPlay();
    else runPlay();
    // Quarterback injury: rare, but it is the event that most changes a game.
    if (rng.chance(0.0012) && T[s].backupQb !== qb[s]) {
      qb[s] = T[s].backupQb;
      if (log.on)
        ev(s, `${nm(s, T[s].qb)} is injured — ${nm(s, qb[s])} takes over at quarterback`, {
          big: true,
        });
    }
  };

  // ---------------------------------------------------------- the game

  const opening = rng.chance(0.5) ? 0 : 1;
  if (log.on) ev(null, `${T[opening].team.name} will receive the opening kickoff`);
  kickoff(1 - opening);

  let guard = 0;
  while (!gameOver && guard++ < 600) {
    snap();
    if (gameOver) break;
    if (clk > 0) continue;
    // End of a quarter.
    if (log.on) ev(null, `End of ${quarter <= 4 ? `${ordinal(quarter)} quarter` : "overtime"}`);
    if (quarter === 2) {
      quarter = 3;
      clk = QUARTER;
      timeouts[0] = timeouts[1] = 3;
      warned = false;
      kickoff(opening);
      continue;
    }
    if (quarter === 1 || quarter === 3) {
      quarter++;
      clk = QUARTER;
      stopped = true;
      continue;
    }
    // End of regulation or of an overtime period.
    if (score[0] !== score[1]) break;
    if (ot() && !prep.playoff) break; // a tie
    quarter++;
    clk = prep.playoff ? PLAYOFF_OT : REG_OT;
    timeouts[0] = timeouts[1] = 2;
    warned = true;
    if (quarter === 5) {
      otPossessions = [0, 0];
      otSudden = false;
      const recv = rng.chance(0.5) ? 0 : 1;
      if (log.on) ev(null, `Overtime: ${T[recv].team.name} win the toss and will receive`);
      kickoff(1 - recv);
    } else stopped = true;
  }

  const wentOt = quarter > 4;
  const tie = score[0] === score[1];
  if (log.on)
    ev(
      null,
      tie
        ? `Final: tie, ${score[0]}–${score[1]}`
        : `Final${wentOt ? " (OT)" : ""}: ${T[score[0] > score[1] ? 0 : 1].team.name} win`,
    );
  return finish(score[0], score[1], periods, box, log, {
    ot: wentOt,
    tie,
    team: { home: team[0], away: team[1] },
    status: wentOt ? (tie ? "Final/OT (tie)" : "Final/OT") : "Final",
  });
}

export function simulateNfl(
  m: NflMatchup,
  o: SimOverrides,
  seed: number,
  record: boolean,
): GameResult {
  return playNfl(prepareNfl(m, o), seed, record);
}

export function checkInvariants(m: NflMatchup, r: GameResult): string[] {
  const errs: string[] = [];
  for (const side of ["home", "away"] as const) {
    let pts = 0;
    for (const row of r.box[side]) {
      pts +=
        6 * (row[NFL.RTD] + row[NFL.RETD] + row[NFL.DTD]) +
        3 * row[NFL.FGM] +
        row[NFL.XPM] +
        2 * row[NFL.TWOPT];
    }
    // Return touchdowns credited to nobody and safeties are not in the box,
    // so the box can only fall short of the score, never exceed it.
    if (pts > r[side]) errs.push(`${side}: box points ${pts} > score ${r[side]}`);
    const per = r.periods[side].reduce((a, b) => a + b, 0);
    if (per !== r[side]) errs.push(`${side}: periods ${per} != ${r[side]}`);
  }
  void m;
  return errs;
}
