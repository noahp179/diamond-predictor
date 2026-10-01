/**
 * nhl.ts — a shift-by-shift hockey engine.
 *
 * Time runs continuously. While a forward line and a defence pair are on the
 * ice, each skater generates shots on goal at his own per-60 rate and takes
 * penalties at his own rate; the next thing to happen is drawn from those
 * competing clocks (the waiting time to the first of several Poisson events).
 * A shot is a goal with the shooter's regressed shooting percentage, scaled by
 * how far the goalie's save percentage sits from the league's.
 *
 * Lines are built from ice time — the twelve forwards and six defencemen who
 * play the most dress, in threes and pairs — and get the ice in proportion to
 * how much they played. Power plays put the team's best power-play producers
 * out; penalty kills, the minutes-eaters. Trailing late, the goalie comes out
 * for an extra attacker. Tied after sixty, it is three-on-three and then a
 * shootout in the regular season, and twenty-minute sudden-death periods in
 * the playoffs.
 */

import { available, Box, clock, finish, Log, Rng } from "./core";
import { NHL } from "./columns";
import type {
  GameResult,
  NhlEnv,
  NhlGoalie,
  NhlSkater,
  NhlTeam,
  SimMatchup,
  SimOverrides,
  Side,
} from "./types";

type NhlMatchup = Extract<SimMatchup, { league: "nhl" }>;

// Calibration — two average teams reproduce the league's goals per game and
// a home team wins ~54%. See SIMULATOR.md.
const SHOT_CAL = 0.985;
const GOAL_CAL = 1.0;
const HOME_SHOTS = 0.04;
const EV_MULT = 0.94;
const PP_MULT = 1.8;
const SH_MULT = 0.42;
const PP_SH_BOOST = 1.18;
const OT_SHOTS = 1.6; // three-on-three opens the ice up
const EXTRA_ATTACKER = 1.6; // six skaters press for the tying goal
const VS_EXTRA_ATTACKER = 0.75; // the other side mostly defends — and shoots at an empty net
const OT_SH_BOOST = 1.25;
const MINOR_SHARE = 0.68; // of PIM/2 that are minors that put a team down a man
// Score effects: at even strength the trailing team pushes and the leading
// team sits back, so shot share tilts ~6% per goal of deficit (up to two).
const SCORE_SHOTS = 0.06;
const D_ASSIST = 0.8;
const PERIOD = 1200;
const REG_OT = 300;
const PLAYOFF_OT = 1200;

interface TeamPrep {
  team: NhlTeam;
  /** Forward lines and defence pairs as indices into team.skaters. */
  lines: number[][];
  pairs: number[][];
  lineW: number[];
  pairW: number[];
  pp: number[][];
  pk: { f: number[]; d: number[] };
  goalie: number; // index into team.goalies
  homeF: number;
  dressed: number[];
}

export interface NhlPrep {
  m: NhlMatchup;
  t: [TeamPrep, TeamPrep];
  env: NhlEnv;
  playoff: boolean;
}

function prepTeam(team: NhlTeam, side: Side, o: SimOverrides, neutral: boolean): TeamPrep {
  const benched = new Set(o.benched);
  const activated = new Set(o.activated);
  const ok = (p: { id: string; status: string }) => available(p, benched, activated);
  const byToi = (a: number, b: number) => team.skaters[b].toi - team.skaters[a].toi;
  let F = team.skaters
    .map((p, i) => (p.kind === "F" && ok(p) ? i : -1))
    .filter((i) => i >= 0)
    .sort(byToi);
  let D = team.skaters
    .map((p, i) => (p.kind === "D" && ok(p) ? i : -1))
    .filter((i) => i >= 0)
    .sort(byToi);
  // Short of bodies: dress whoever is listed rather than play a man down.
  if (F.length < 12)
    F = F.concat(
      team.skaters
        .map((p, i) => (p.kind === "F" && !F.includes(i) && !benched.has(p.id) ? i : -1))
        .filter((i) => i >= 0)
        .sort(byToi),
    );
  if (D.length < 6)
    D = D.concat(
      team.skaters
        .map((p, i) => (p.kind === "D" && !D.includes(i) && !benched.has(p.id) ? i : -1))
        .filter((i) => i >= 0)
        .sort(byToi),
    );
  F = F.slice(0, 12);
  D = D.slice(0, 6);
  while (F.length < 12 && F.length > 0) F.push(F[F.length % Math.max(1, F.length)]);
  while (D.length < 6 && D.length > 0) D.push(D[D.length % Math.max(1, D.length)]);
  const lines = [0, 1, 2, 3].map((k) => F.slice(k * 3, k * 3 + 3));
  const pairs = [0, 1, 2].map((k) => D.slice(k * 2, k * 2 + 2));
  const avgToi = (ids: number[]) =>
    ids.reduce((a, i) => a + team.skaters[i].toi, 0) / Math.max(1, ids.length);
  const lineW = lines.map(avgToi);
  const pairW = pairs.map(avgToi);
  const byPP = (a: number, b: number) => team.skaters[b].ppPts - team.skaters[a].ppPts;
  const fPP = F.slice().sort(byPP);
  const dPP = D.slice().sort(byPP);
  const pp = [fPP.slice(0, 4).concat(dPP.slice(0, 1)), fPP.slice(4, 7).concat(dPP.slice(1, 3))];
  const pk = { f: F.slice(3, 9), d: D.slice(0, 4) };
  const goalies = team.goalies.map((g, i) => (ok(g) ? i : -1)).filter((i) => i >= 0);
  const want = o.starter?.[side] ?? team.probable;
  let goalie = want ? team.goalies.findIndex((g) => g.id === want) : -1;
  if (goalie < 0) goalie = goalies.length ? goalies[0] : 0;
  const homeF = neutral ? 1 : side === "home" ? 1 + HOME_SHOTS : 1 - HOME_SHOTS;
  return { team, lines, pairs, lineW, pairW, pp, pk, goalie, homeF, dressed: F.concat(D) };
}

export function prepareNhl(m: NhlMatchup, o: SimOverrides): NhlPrep {
  const neutral = o.neutral ?? m.ctx.neutral;
  return {
    m,
    t: [prepTeam(m.home, "home", o, neutral), prepTeam(m.away, "away", o, neutral)],
    env: m.env,
    playoff: o.playoff ?? m.ctx.playoff,
  };
}

// ------------------------------------------------------------------ game

export function playNhl(prep: NhlPrep, seed: number, record: boolean): GameResult {
  const rng = new Rng(seed);
  // Words only: the play-by-play's choice of "wrist shot" or "slap shot" draws
  // from its own stream so a recorded game is the same game as an unrecorded
  // one with the same seed.
  const flavor = new Rng(seed ^ 0x5bd1e995);
  const T = prep.t;
  const env = prep.env;
  const nH = T[0].team.skaters.length + T[0].team.goalies.length;
  const nA = T[1].team.skaters.length + T[1].team.goalies.length;
  const box = new Box(nH, nA, NHL.N, record);
  const log = new Log(record, box);
  const gIdx = (s: number, g: number) => T[s].team.skaters.length + g;
  const sk = (s: number, i: number): NhlSkater => T[s].team.skaters[i];
  const goalieOf = (s: number): NhlGoalie | undefined => T[s].team.goalies[T[s].goalie];
  const score = [0, 0];
  const shots = [0, 0];
  const ppOpp = [0, 0];
  const ppGoals = [0, 0];
  const enGoals = [0, 0];
  const periods = { home: [] as number[], away: [] as number[] };
  const periodScore = [0, 0];

  for (let s = 0; s < 2; s++) {
    for (const i of new Set(T[s].dressed)) box.add(s, i, NHL.START, 1);
    if (goalieOf(s)) box.add(s, gIdx(s, T[s].goalie), NHL.START, 1);
  }

  // Shared rates: the opponent's shot suppression and the goalie's quality.
  const allow = [T[0].team.shotSuppression, T[1].team.shotSuppression];
  const lgSh = env.shPct;
  const goalieF = (s: number) => {
    const g = goalieOf(s);
    return g ? (1 - g.svPct) / Math.max(0.02, lgSh) : (1 - env.svPct) / lgSh;
  };
  const gf = [goalieF(0), goalieF(1)];
  // Special teams: this power play's season conversion against that penalty
  // kill's, each relative to the league, split between the two (geometric
  // mean) because the shooters' own percentages already carry some of it.
  const special = (s: number): number => {
    const pp = T[s].team.tend?.ppPct;
    const pk = T[1 - s].team.tend?.pkPct;
    if (!pp || !pk) return 1;
    const f =
      (pp.value / Math.max(1e-6, pp.league)) * ((1 - pk.value) / Math.max(1e-6, 1 - pk.league));
    return Math.max(0.75, Math.min(1.3, Math.sqrt(f)));
  };
  const ppF = [special(0), special(1)];

  let period = 1;
  let t = 0; // seconds into the current period
  let len = PERIOD;
  const ot = () => period > 3;
  // Penalty state: seconds remaining in each side's current minor, and who.
  const box_ = [[] as { left: number; who: number }[], [] as { left: number; who: number }[]];
  const pulled = [false, false];
  let onF: number[][] = [T[0].lines[0], T[1].lines[0]];
  let onD: number[][] = [T[0].pairs[0], T[1].pairs[0]];
  let shiftLeft = rng.uniform(35, 55);
  let curLine = [0, 0];
  let curPair = [0, 0];

  const skatersOn = (s: number) => box_[s].length; // men in the box
  const regOt = () => ot() && !prep.playoff;
  // Skaters a side has on the ice, not counting an extra attacker. In
  // three-on-three overtime a penalty adds a skater to the other side instead
  // of taking one away.
  const strength = (s: number) =>
    regOt() ? Math.min(5, 3 + skatersOn(1 - s)) : Math.max(3, 5 - Math.min(2, skatersOn(s)));

  const onIce = (s: number): number[] => {
    const n = strength(s);
    const set = Array.from(new Set(onF[s].concat(onD[s]))).slice(0, n);
    if (pulled[s]) {
      const extra = T[s].lines[0].concat(T[s].lines[1]).find((i) => !set.includes(i));
      if (extra !== undefined) set.push(extra);
    }
    return set;
  };

  /** n distinct picks, weighted, without replacement. */
  const pickN = (pool: number[], n: number, w: (i: number) => number): number[] => {
    const left = pool.slice();
    const out: number[] = [];
    while (out.length < n && left.length) {
      const k = rng.pick(left.map(w));
      out.push(left.splice(k, 1)[0]);
    }
    return out;
  };

  const name = (s: number, i: number) => sk(s, i).short;
  const ev = (
    side: number | null,
    text: string,
    extra: { scoring?: boolean; big?: boolean } = {},
  ) =>
    log.push({
      period,
      clock: clock(len - t),
      side: side === null ? null : side === 0 ? "home" : "away",
      text,
      home: score[0],
      away: score[1],
      sit: situation(),
      ...extra,
    });

  const situation = () => {
    const a = strength(0) + (pulled[0] ? 1 : 0);
    const b = strength(1) + (pulled[1] ? 1 : 0);
    if (a === b && a === 5) return pulled[0] || pulled[1] ? "" : "Even strength";
    return `${a}-on-${b}`;
  };

  const pickLines = () => {
    for (let s = 0; s < 2; s++) {
      const tp = T[s];
      if (regOt()) {
        // Three-on-three: two forwards and a defenceman, rotating through the
        // top two lines and pairs; a power play in overtime sends out the
        // first unit's top four.
        if (skatersOn(1 - s) > 0) {
          const unit = tp.pp[0];
          onF[s] = unit.filter((i) => sk(s, i).kind === "F").slice(0, 3);
          onD[s] = unit.filter((i) => sk(s, i).kind === "D").slice(0, 1);
          continue;
        }
        curLine[s] = (curLine[s] + 1) % 2;
        curPair[s] = (curPair[s] + 1) % 2;
        onF[s] = tp.lines[curLine[s]].slice(0, 2);
        onD[s] = tp.pairs[curPair[s]].slice(0, 1);
        continue;
      }
      const opp = 1 - s;
      if (skatersOn(opp) > 0 && skatersOn(s) === 0) {
        const unit = tp.pp[rng.chance(0.62) ? 0 : 1];
        onF[s] = unit.filter((i) => sk(s, i).kind === "F");
        onD[s] = unit.filter((i) => sk(s, i).kind === "D");
        continue;
      }
      if (skatersOn(s) > 0) {
        onF[s] = pickN(tp.pk.f, 2, (i) => sk(s, i).toi);
        onD[s] = pickN(tp.pk.d, 2, (i) => sk(s, i).toi);
        continue;
      }
      const lw = tp.lineW.map((w, i) => (i === curLine[s] ? w * 0.25 : w));
      const pw = tp.pairW.map((w, i) => (i === curPair[s] ? w * 0.35 : w));
      curLine[s] = rng.pick(lw);
      curPair[s] = rng.pick(pw);
      onF[s] = tp.lines[curLine[s]];
      onD[s] = tp.pairs[curPair[s]];
    }
  };

  const faceoff = (text: string | null) => {
    const c = [0, 1].map((s) => {
      const fs = onF[s];
      if (!fs.length) return -1;
      return fs.reduce((a, b) => (sk(s, b).fo60 > sk(s, a).fo60 ? b : a));
    });
    if (c[0] < 0 || c[1] < 0) return;
    const a = sk(0, c[0]).foPct;
    const b = sk(1, c[1]).foPct;
    const pHome = (a * (1 - b)) / (a * (1 - b) + b * (1 - a));
    const w = rng.chance(pHome) ? 0 : 1;
    box.add(w, c[w], NHL.FOW, 1);
    box.add(1 - w, c[1 - w], NHL.FOL, 1);
    if (log.on && text)
      ev(w, `${text}: ${name(w, c[w])} wins faceoff against ${name(1 - w, c[1 - w])}`);
  };

  const shotRate = (s: number): number => {
    const ice = onIce(s);
    let r = 0;
    for (const i of ice) r += sk(s, i).sog60;
    r /= 3600;
    // Skaters actually on the ice, before the extra attacker: a pulled goalie
    // is not a power play, and the side facing six attackers is not killing a
    // penalty — it is clearing pucks, some of them into the empty net.
    const me = strength(s);
    const them = strength(1 - s);
    const per5 = 5 / Math.max(1, ice.length - (pulled[s] ? 1 : 0));
    let mult = EV_MULT;
    if (me > them) mult = PP_MULT * per5;
    else if (me < them) mult = SH_MULT * per5;
    else if (!ot() && !pulled[0] && !pulled[1])
      mult *= 1 + SCORE_SHOTS * Math.max(-2, Math.min(2, score[1 - s] - score[s]));
    if (regOt()) mult = OT_SHOTS * per5 * (me > them ? 1.3 : 1);
    if (pulled[s]) mult *= EXTRA_ATTACKER;
    if (pulled[1 - s]) mult *= VS_EXTRA_ATTACKER;
    return r * mult * SHOT_CAL * allow[1 - s] * T[s].homeF;
  };

  const penRate = (s: number): number => {
    let r = 0;
    for (const i of onIce(s)) r += sk(s, i).pim60;
    // PIM/2 counts minors, majors and misconducts alike; the share that put a
    // team a man down is what matters here.
    return ((r / 2) * MINOR_SHARE * 5) / Math.max(1, onIce(s).length) / 3600;
  };

  const lead = (s: number) => score[s] - score[1 - s];

  // Who gets the helpers: each teammate on the ice by his assist rate, with
  // defencemen discounted — they are on the ice for more of the goals than
  // any one forward, so raw rates hand them about a fifth too many.
  const assistW = (i: number) => {
    const p = sk(goalSide, i);
    return (p.a60 + 0.03) * (p.kind === "D" ? D_ASSIST : 1);
  };
  let goalSide = 0;

  const goal = (s: number, shooter: number, pp: boolean, sh: boolean, en: boolean) => {
    goalSide = s;
    score[s]++;
    periodScore[s]++;
    box.add(s, shooter, NHL.G, 1);
    const mates = onIce(s).filter((i) => i !== shooter);
    const assists: number[] = [];
    if (mates.length && rng.chance(en ? 0.75 : pp ? 0.97 : 0.91)) {
      const a1 = mates[rng.pick(mates.map(assistW))];
      assists.push(a1);
      const rest = mates.filter((i) => i !== a1);
      if (rest.length && rng.chance(en ? 0.5 : pp ? 0.88 : 0.8))
        assists.push(rest[rng.pick(rest.map(assistW))]);
    }
    for (const a of assists) box.add(s, a, NHL.A, 1);
    if (pp) {
      ppGoals[s]++;
      box.add(s, shooter, NHL.PPP, 1);
      for (const a of assists) box.add(s, a, NHL.PPP, 1);
    } else {
      for (const i of onIce(s)) box.add(s, i, NHL.PM, 1);
      for (const i of onIce(1 - s)) box.add(1 - s, i, NHL.PM, -1);
    }
    const g = goalieOf(1 - s);
    if (g && !en) box.add(1 - s, gIdx(1 - s, T[1 - s].goalie), NHL.GA, 1);
    if (log.on) {
      const tag = en ? " (empty net)" : pp ? " (power play)" : sh ? " (shorthanded)" : "";
      const ast = assists.length
        ? ` — assists: ${assists.map((a) => name(s, a)).join(", ")}`
        : " — unassisted";
      const tie = score[0] === score[1];
      ev(s, `GOAL ${T[s].team.abbr}${tag}: ${name(s, shooter)}${ast}`, {
        scoring: true,
        big: (period >= 3 && Math.abs(score[0] - score[1]) <= 1) || tie,
      });
    }
    // A power-play goal ends the earliest minor.
    if (pp && box_[1 - s].length) box_[1 - s].shift();
    if (pulled[s] && lead(s) >= 0) pulled[s] = false;
    // Play stops: fresh lines and a faceoff at centre.
    pickLines();
    shiftLeft = rng.uniform(32, 52);
    faceoff(null);
  };

  const shot = (s: number) => {
    const d = 1 - s;
    const ice = onIce(s);
    if (!ice.length) return;
    const shooter = ice[rng.pick(ice.map((i) => sk(s, i).sog60))];
    const me = strength(s);
    const them = strength(d);
    const pp = me > them;
    const sh = me < them;
    if (pulled[d]) {
      // Shooting at an empty net from wherever the puck is: on target it is a
      // goal; the rest go wide and never count as shots.
      if (rng.chance(0.55)) {
        shots[s]++;
        enGoals[s]++;
        box.add(s, shooter, NHL.SOG, 1);
        return goal(s, shooter, false, sh, true);
      }
      if (log.on) ev(s, `${name(s, shooter)} misses the empty net`);
      return;
    }
    shots[s]++;
    box.add(s, shooter, NHL.SOG, 1);
    const g = goalieOf(d);
    if (g) box.add(d, gIdx(d, T[d].goalie), NHL.SA, 1);
    // Shooter's percentage × how many more (or fewer) goals this goalie lets
    // in than the league's: (1 − sv%) / league shooting %.
    let p = sk(s, shooter).shPct * gf[d] * GOAL_CAL;
    if (pp) p *= PP_SH_BOOST * ppF[s];
    if (regOt()) p *= OT_SH_BOOST;
    if (pulled[s]) p *= 1.08;
    if (rng.chance(Math.min(0.5, p))) return goal(s, shooter, pp, sh, false);
    if (log.on && flavor.chance(0.45)) {
      const verb = [
        "Shot",
        "Wrist shot",
        "Snap shot",
        "Slap shot",
        "Backhand",
        "Tip-in attempt",
        "One-timer",
      ][flavor.int(0, 6)];
      ev(s, `${verb} by ${name(s, shooter)} saved by ${g?.short ?? "the goalie"}`);
    }
  };

  const penalty = (s: number) => {
    const ice = onIce(s);
    if (!ice.length) return;
    const who = ice[rng.pick(ice.map((i) => sk(s, i).pim60 + 0.05))];
    box.add(s, who, NHL.PIM, 2);
    box_[s].push({ left: 120, who });
    ppOpp[1 - s]++;
    if (log.on) {
      const kind = [
        "Tripping",
        "Hooking",
        "Holding",
        "Slashing",
        "Interference",
        "High-sticking",
        "Roughing",
        "Cross-checking",
        "Delay of game",
      ][flavor.int(0, 8)];
      ev(s, `Penalty ${T[s].team.abbr}: ${name(s, who)}, 2 min for ${kind.toLowerCase()}`);
    }
    pickLines();
    faceoff(null);
  };

  // When each bench pulls its goalie: about two minutes left down one, later
  // down two, decided once per game rather than re-rolled at every whistle.
  // Down three, the goalie goes back in. Pulling earlier down two turned too
  // many two-goal games into three-goal ones against the real distribution.
  const pullAt = [0, 1].map(() => 125 + rng.uniform(-20, 25));
  const pullCheck = () => {
    if (period !== 3 || ot()) return;
    for (let s = 0; s < 2; s++) {
      const down = -lead(s);
      const left = len - t;
      if (!pulled[s] && down >= 1 && down <= 2 && left <= pullAt[s] - 40 * (down - 1)) {
        pulled[s] = true;
        if (log.on) ev(s, `${goalieOf(s)?.short ?? "Goalie"} pulled for an extra attacker`);
      }
      if (pulled[s] && (down <= 0 || down >= 3)) {
        pulled[s] = false;
        if (log.on && down >= 3) ev(s, `${goalieOf(s)?.short ?? "Goalie"} back in net`);
      }
    }
  };

  // TOI accounting: every skater on the ice accumulates the elapsed time.
  const advance = (dt: number) => {
    for (let s = 0; s < 2; s++) {
      for (const i of onIce(s)) box.add(s, i, NHL.SEC, dt);
      const g = goalieOf(s);
      if (g && !pulled[s]) box.add(s, gIdx(s, T[s].goalie), NHL.SEC, dt);
      for (const pen of box_[s]) pen.left -= dt;
    }
    t += dt;
  };

  const startPeriod = () => {
    t = 0;
    periodScore[0] = 0;
    periodScore[1] = 0;
    curLine = [3, 3];
    curPair = [2, 2];
    pickLines();
    if (!regOt()) {
      onF = [T[0].lines[0], T[1].lines[0]];
      onD = [T[0].pairs[0], T[1].pairs[0]];
      curLine = [0, 0];
      curPair = [0, 0];
    }
    shiftLeft = rng.uniform(35, 55);
    if (log.on)
      ev(
        null,
        ot()
          ? prep.playoff
            ? `Overtime ${period - 3} — sudden death`
            : "Overtime — 3-on-3, sudden death"
          : `Start of ${["1st", "2nd", "3rd"][period - 1]} period`,
      );
    faceoff(log.on ? "Opening draw" : null);
  };

  let shootout = false;

  for (;;) {
    len = period <= 3 ? PERIOD : prep.playoff ? PLAYOFF_OT : REG_OT;
    startPeriod();
    let guard = 0;
    while (t < len && guard++ < 5000) {
      pullCheck();
      const rates = [shotRate(0), shotRate(1), penRate(0), penRate(1)];
      if (regOt()) {
        rates[2] *= 0.4;
        rates[3] *= 0.4;
      }
      if (pulled[0] || pulled[1]) {
        rates[2] *= 0.5;
        rates[3] *= 0.5;
      }
      const R = rates[0] + rates[1] + rates[2] + rates[3];
      const dt = R > 0 ? rng.exp(1 / R) : Infinity;
      // The next boundary: shift change, a penalty expiring, the period end.
      let bound = Math.min(shiftLeft, len - t);
      for (let s = 0; s < 2; s++)
        for (const p of box_[s]) bound = Math.min(bound, Math.max(0, p.left));
      if (dt >= bound) {
        advance(bound);
        shiftLeft -= bound;
        let changed = false;
        for (let s = 0; s < 2; s++) {
          const before = box_[s].length;
          box_[s] = box_[s].filter((p) => p.left > 0.001);
          if (box_[s].length < before) {
            changed = true;
            if (log.on) ev(s, `${T[s].team.abbr} back to full strength`);
          }
        }
        if (shiftLeft <= 0.001 || changed) {
          pickLines();
          shiftLeft = rng.uniform(32, 52);
          if (!changed && rng.chance(0.6)) faceoff(null);
        }
        continue;
      }
      advance(dt);
      shiftLeft -= dt;
      const k = rng.pick(rates);
      if (k < 2) {
        shot(k);
        if (ot() && score[0] !== score[1]) break;
      } else penalty(k - 2);
    }
    periods.home.push(periodScore[0]);
    periods.away.push(periodScore[1]);
    if (log.on)
      ev(
        null,
        `End of ${period <= 3 ? ["1st", "2nd", "3rd"][period - 1] + " period" : "overtime"}`,
      );
    if (period >= 3 && score[0] !== score[1]) break;
    if (period >= 4 && !prep.playoff) {
      shootout = true;
      break;
    }
    if (period > 10) break;
    period++;
    box_[0] = box_[0].filter((p) => p.left > 0);
    box_[1] = box_[1].filter((p) => p.left > 0);
  }

  let soWinner = -1;
  if (shootout) {
    // The shootout gets its own column in the line score.
    period = 5;
    // Each side's six best finishers by shooting percentage, in order.
    const order = [0, 1].map((s) =>
      T[s].lines
        .flat()
        .slice(0, 9)
        .sort((a, b) => sk(s, b).shPct - sk(s, a).shPct),
    );
    const made = [0, 0];
    if (log.on) ev(null, "Shootout");
    for (let round = 0; round < 20; round++) {
      for (let s = 0; s < 2; s++) {
        const shooter = order[s][round % order[s].length];
        const g = goalieOf(1 - s);
        const p = Math.min(
          0.6,
          0.31 *
            Math.sqrt(sk(s, shooter).shPct / lgSh) *
            Math.sqrt(gf[1 - s] / ((1 - env.svPct) / lgSh)),
        );
        const scored = rng.chance(p);
        if (scored) made[s]++;
        if (log.on)
          ev(
            s,
            `Shootout: ${name(s, shooter)} ${scored ? "scores" : `stopped by ${g?.short ?? "the goalie"}`}`,
            { scoring: scored },
          );
      }
      if (round >= 2 && made[0] !== made[1]) break;
      if (round < 2) {
        const left = 2 - round;
        if (made[0] > made[1] + left || made[1] > made[0] + left) break;
      }
    }
    soWinner = made[0] > made[1] ? 0 : made[1] > made[0] ? 1 : rng.chance(0.5) ? 0 : 1;
    score[soWinner]++;
  }

  const winner = score[0] > score[1] ? 0 : 1;
  const extra = ot();
  for (let s = 0; s < 2; s++) {
    const g = goalieOf(s);
    if (!g) continue;
    box.add(s, gIdx(s, T[s].goalie), NHL.DEC, s === winner ? 1 : extra ? 3 : 2);
  }
  if (log.on)
    ev(
      winner,
      `Final${shootout ? " (shootout)" : extra ? " (overtime)" : ""}: ${T[winner].team.name} win`,
    );

  return finish(score[0], score[1], periods, box, log, {
    ot: extra,
    so: shootout,
    tie: false,
    team: {
      home: { SOG: shots[0], PPG: ppGoals[0], PPO: ppOpp[0], ENG: enGoals[0] },
      away: { SOG: shots[1], PPG: ppGoals[1], PPO: ppOpp[1], ENG: enGoals[1] },
    },
    status: shootout
      ? "Final/SO"
      : extra
        ? period - 3 > 1
          ? `Final/${period - 3}OT`
          : "Final/OT"
        : "Final",
  });
}

export function simulateNhl(
  m: NhlMatchup,
  o: SimOverrides,
  seed: number,
  record: boolean,
): GameResult {
  return playNhl(prepareNhl(m, o), seed, record);
}
