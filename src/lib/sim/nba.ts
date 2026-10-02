/**
 * nba.ts — a possession-by-possession basketball engine.
 *
 * Every possession, the clock runs a sampled number of seconds and then one of
 * the five players on the floor "uses" it: a two, a three, a trip to the line
 * or a turnover, chosen in proportion to how often each of those players does
 * each of those things per minute. A miss goes to a rebound battle decided by
 * the offensive rebounding of the five on offense against the defensive
 * rebounding of the five on defense; an offensive board keeps the possession
 * alive and someone uses it again.
 *
 * That one rule — usage in proportion to per-minute rates — is what makes the
 * box scores come out right. A player who takes a fifth of his team's shots in
 * real life takes about a fifth of them here, and when a star sits, the shots
 * flow to whoever replaces him rather than disappearing.
 *
 * Around it: a rotation that tracks each player's minutes against his season
 * average, starters at the start of halves, closers in a close fourth quarter,
 * the bench in a blowout, foul trouble and foul-outs, intentional fouling when
 * trailing late, and overtime until somebody wins.
 */

import { available, Box, clock, finish, Log, ordinal, Rng, sideIdx } from "./core";
import { NBA } from "./columns";
import type {
  GameResult,
  NbaEnv,
  NbaPlayer,
  NbaTeam,
  SimMatchup,
  SimOverrides,
  Side,
} from "./types";

type NbaMatchup = Extract<SimMatchup, { league: "nba" }>;

// Calibration. Tuned so two league-average rosters on a neutral floor score
// the league's points per game at its pace, and an average home team wins
// ~55% (the NBA's rate over the last five seasons). See SIMULATOR.md.
const MAKE_CAL = 0.997;
const PACE_CAL = 0.966;
const HOME_EDGE = 0.0125; // make-probability bump for the home side
/** Used only when a team's season splits are missing: points allowed, regressed. */
const DEF_FALLBACK = 0.8;
const CRUNCH_MARGIN = 10;
/**
 * Score effects: a team ahead plays a little worse and a team behind a little
 * better (rest, effort, the opponent's urgency). Without it the simulated
 * margins spread far wider than real ones — about 16.5 points around the
 * expectation instead of the ~13 the NBA actually shows. Per point of lead,
 * capped at twenty.
 */
const SCORE_EFFECT = 0.0035;
/**
 * Who uses a possession, grabs a rebound or makes the pass, among the five on
 * the floor: each by his own per-minute rate, raised to this power. Season
 * rates were earned next to different teammates, and five of them usually add
 * up to more than one team's possessions; real role players defer to the
 * star rather than every player giving up the same share. 1 would scale
 * everyone down alike and leave stars ~12% short of their season lines;
 * 1.5 keeps points per minute level from the stars to the bench.
 */
const ROLE_POW = 1.5;
/** The same for rebounds, which concentrate less: a big's rate was earned
 *  next to other bigs too. */
const REB_POW = 1.55;
/** Share of defensive rebounds credited to the team, not a player. */
const TEAM_REB = 0.12;
/** Make-probability factor for a team on the second night of a back-to-back. */
const B2B_MAKE = 0.972;
/** Game-to-game swings in a player's minutes and shot volume (log scale). */
const MIN_FORM = 0.15;
const USE_FORM = 0.16;
/** Game-to-game pace swings both teams share. */
const PACE_NOISE = 0.035;

interface TeamPrep {
  side: Side;
  team: NbaTeam;
  /** Indices into team.players of everyone who can play. */
  roster: number[];
  /** Target seconds per player (by roster index into team.players). */
  target: number[];
  starters: number[];
  /**
   * What this defense does to the offense facing it, relative to the league
   * (1 = average), from what opponents did against it over the season: odds
   * multipliers on twos and threes going in, on a shot being a three and on
   * the offense rebounding its miss; rate multipliers on trips to the line
   * and on turnovers.
   */
  vs: { two: number; three: number; threeRate: number; ft: number; tov: number; orebOdds: number };
  makeF: number;
}

export interface NbaPrep {
  m: NbaMatchup;
  teams: [TeamPrep, TeamPrep];
  env: NbaEnv;
  pace: number;
  playoff: boolean;
}

function prepTeam(
  side: Side,
  team: NbaTeam,
  o: SimOverrides,
  m: NbaMatchup,
  neutral: boolean,
): TeamPrep {
  const benched = new Set(o.benched);
  const activated = new Set(o.activated);
  let roster = team.players
    .map((p, i) => (available(p, benched, activated) ? i : -1))
    .filter((i) => i >= 0);
  // Fewer than eight available would make a farce of the rotation; dress
  // whoever is left on the injury report before playing four-on-five.
  if (roster.length < 8) {
    const extra = team.players
      .map((p, i) => i)
      .filter((i) => !roster.includes(i) && !benched.has(team.players[i].id));
    roster = roster.concat(extra.slice(0, 8 - roster.length));
  }
  // A rotation is nine or ten deep. Everyone's season minutes describe the
  // role he had — often on another team, often while someone else was hurt —
  // so the roster is ranked, the top nine keep their minutes, the tenth man
  // half of his, and the end of the bench plays only when a game is decided.
  // The rotation's minutes are then scaled to fill exactly 240, capping anyone
  // at 40 and pouring the excess back over the rest in proportion.
  const target = new Array<number>(team.players.length).fill(0);
  roster.sort((a, b) => team.players[b].mpg - team.players[a].mpg);
  const base = roster.map((i, rank) => {
    const mpg = Math.max(1, team.players[i].mpg);
    return rank < 9 ? mpg : rank === 9 ? mpg * 0.5 : 0;
  });
  let mins = base.slice();
  for (let iter = 0; iter < 8; iter++) {
    const sum = mins.reduce((a, b) => a + b, 0);
    mins = mins.map((x) => (x * 240) / sum);
    const over = mins.some((x) => x > 40.5);
    if (!over) break;
    mins = mins.map((x) => Math.min(40, x));
  }
  roster.forEach((i, k) => (target[i] = mins[k] * 60));
  const starters = roster
    .slice()
    .sort((a, b) => target[b] - target[a])
    .slice(0, 5);
  const t = team.tend ?? {};
  const ratio = (key: string) => (t[key] ? t[key].value / Math.max(1e-9, t[key].league) : null);
  const oddsRatio = (key: string) =>
    t[key] ? odds(t[key].value) / Math.max(1e-9, odds(t[key].league)) : null;
  const fallback = 1 + DEF_FALLBACK * (team.pa / m.env.ppg - 1);
  const dreb = t.defDreb;
  const vs = {
    two: oddsRatio("defOpp2p") ?? Math.pow(fallback, 1.3),
    three: oddsRatio("defOpp3p") ?? Math.pow(fallback, 1.3),
    threeRate: oddsRatio("defOpp3aRate") ?? 1,
    ft: ratio("defOppFtRate") ?? 1,
    tov: ratio("defForcedTov") ?? 1,
    // Offensive rebound odds against this defense: the complement of its
    // defensive-rebound rate, relative to the league's.
    orebOdds: dreb ? odds(1 - dreb.value) / Math.max(1e-9, odds(1 - dreb.league)) : 1,
  };
  const homeEdge = neutral ? 0 : side === "home" ? HOME_EDGE : -HOME_EDGE;
  // Second night of a back-to-back: tired legs, ~2 points (2025-26).
  const tired = m.ctx.b2b?.[side] ? B2B_MAKE : 1;
  return {
    side,
    team,
    roster,
    target,
    starters,
    vs,
    makeF: MAKE_CAL * (1 + homeEdge) * tired,
  };
}

const odds = (p: number) => p / Math.max(1e-9, 1 - p);
const prob = (o: number) => o / (1 + o);

/**
 * Possessions per 48 for this matchup. Both teams' season paces, combined the
 * way pace combines (a fast team against a slow one plays near the league
 * average; two fast teams play faster than either usually does):
 * league × (home / league) × (away / league). Without team splits, the
 * league pace nudged by how possession-hungry each rotation is.
 */
function matchupPace(m: NbaMatchup, teams: [TeamPrep, TeamPrep]): number {
  const env = m.env;
  const ph = m.home.tend?.pace;
  const pa = m.away.tend?.pace;
  if (ph && pa) {
    const rel = (ph.value / ph.league) * (pa.value / pa.league);
    return env.pace * PACE_CAL * Math.max(0.9, Math.min(1.1, rel));
  }
  const lgUse = 5 * (0.32 + 0.12 + 0.264 * 0.44 + 0.1); // rough per-5 usage scale
  const f = teams.map((t) => {
    let use = 0;
    for (const i of t.roster) {
      const p = t.team.players[i];
      use += (t.target[i] / 14400) * 5 * (p.fg2a + p.fg3a + 0.44 * p.fta + p.tov - p.oreb);
    }
    return use / Math.max(0.1, lgUse);
  });
  const rel = (f[0] + f[1]) / 2;
  // Mostly league pace; a quarter of the roster signal, clamped.
  const adj = Math.max(0.94, Math.min(1.06, 1 + 0.25 * (rel - 1)));
  return env.pace * PACE_CAL * adj;
}

export function prepareNba(m: NbaMatchup, o: SimOverrides): NbaPrep {
  const neutral = o.neutral ?? m.ctx.neutral;
  const teams: [TeamPrep, TeamPrep] = [
    prepTeam("home", m.home, o, m, neutral),
    prepTeam("away", m.away, o, m, neutral),
  ];
  return { m, teams, env: m.env, pace: matchupPace(m, teams), playoff: o.playoff ?? m.ctx.playoff };
}

// ------------------------------------------------------------------ game

const REG = 4;
const QUARTER = 720;
const OT_LEN = 300;

export function playNba(prep: NbaPrep, seed: number, record: boolean): GameResult {
  const rng = new Rng(seed);
  // Words only — see nhl.ts. Keeps a recorded game identical to the same seed
  // played silently in a batch.
  const flavor = new Rng(seed ^ 0x5bd1e995);
  const [H, A] = prep.teams;
  const box = new Box(H.team.players.length, A.team.players.length, NBA.N, record);
  const log = new Log(record, box);
  const score = [0, 0];
  const periods = { home: [] as number[], away: [] as number[] };
  const T = prep.teams;
  const played = [new Float64Array(H.team.players.length), new Float64Array(A.team.players.length)];
  const fouls = [new Int8Array(H.team.players.length), new Int8Array(A.team.players.length)];
  // Tonight's roles: everyone's minutes and shot volume swing a little from
  // game to game — a hot hand, a matchup, a coach's whim — around their
  // season averages (2025-26: the busiest player averages 35 minutes and a
  // team's top scorer reaches 30 a third of the time).
  const jitter = (tp: TeamPrep) => {
    const t = tp.target.map((x) => x * Math.exp(rng.normal(0, MIN_FORM)));
    const k =
      tp.target.reduce((a, b) => a + b, 0) /
      Math.max(
        1,
        t.reduce((a, b) => a + b, 0),
      );
    return t.map((x) => Math.min(42 * 60, x * k));
  };
  const tgt = [jitter(H), jitter(A)];
  const usage = [H, A].map((tp) => tp.team.players.map(() => Math.exp(rng.normal(0, USE_FORM))));
  const lineup: number[][] = [H.starters.slice(), A.starters.slice()];
  for (let s = 0; s < 2; s++) for (const p of lineup[s]) box.add(s, p, NBA.START, 1);
  const name = (s: number, p: number) => T[s].team.players[p].short;
  const meanPoss = 2880 / (2 * prep.pace * Math.max(0.85, 1 + rng.normal(0, PACE_NOISE)));

  let period = 1;
  let clk = QUARTER;
  let lastSub = 0;
  let elapsedTotal = 0;
  const tipWinner = rng.chance(0.5) ? 0 : 1;
  let off = tipWinner;

  const periodScore = [0, 0];
  const isOT = () => period > REG;
  const regElapsed = () => Math.min(2880, elapsedTotal);

  const add = (s: number, pts: number) => {
    score[s] += pts;
    periodScore[s] += pts;
    for (const p of lineup[s]) box.add(s, p, NBA.PM, pts);
    for (const p of lineup[1 - s]) box.add(1 - s, p, NBA.PM, -pts);
  };

  const tick = (sec: number) => {
    const t = Math.min(sec, clk);
    clk -= t;
    elapsedTotal += t;
    for (let s = 0; s < 2; s++)
      for (const p of lineup[s]) {
        played[s][p] += t;
        box.add(s, p, NBA.SEC, t);
      }
  };

  const ev = (
    side: number | null,
    text: string,
    extra: { scoring?: boolean; big?: boolean } = {},
  ) =>
    log.push({
      period,
      clock: clock(clk),
      side: side === null ? null : side === 0 ? "home" : "away",
      text,
      home: score[0],
      away: score[1],
      ...extra,
    });

  // ---------------------------------------------------------- rotation

  const fouledOut = (s: number, p: number) => fouls[s][p] >= 6;

  const rotate = (s: number, force: boolean) => {
    const t = T[s];
    const margin = score[s] - score[1 - s];
    const avail = t.roster.filter((p) => !fouledOut(s, p));
    if (avail.length < 5) return;
    const lateQ4 = period === REG && clk < 300;
    if ((lateQ4 && Math.abs(margin) <= CRUNCH_MARGIN) || isOT()) {
      // Closing time: the five who play the most.
      const best = avail
        .slice()
        .sort((a, b) => tgt[s][b] - tgt[s][a])
        .slice(0, 5);
      setLineup(s, best);
      return;
    }
    if (period === REG && clk < 400 && Math.abs(margin) >= 20) {
      const garbage = avail
        .slice()
        .sort((a, b) => tgt[s][a] - tgt[s][b])
        .slice(0, 5);
      setLineup(s, garbage);
      return;
    }
    const frac = Math.min(1, (regElapsed() + 150) / 2880);
    const need = (p: number) => {
      let d = tgt[s][p] * frac - played[s][p];
      // Foul trouble: two in the first, three in the second, and so on.
      if (fouls[s][p] >= Math.min(5, period + 1) && period <= REG) d -= 400;
      return d;
    };
    const cur = lineup[s].slice();
    for (let k = 0; k < (force ? 5 : 2); k++) {
      const bench = avail.filter((p) => !cur.includes(p));
      if (!bench.length) break;
      const out = cur.reduce((a, b) => (need(b) < need(a) ? b : a));
      const inn = bench.reduce((a, b) => (need(b) > need(a) ? b : a));
      if (need(inn) - need(out) > 150 || fouledOut(s, out)) cur[cur.indexOf(out)] = inn;
      else break;
    }
    setLineup(s, cur);
  };

  const setLineup = (s: number, next: number[]) => {
    const cur = lineup[s];
    const outs = cur.filter((p) => !next.includes(p));
    const ins = next.filter((p) => !cur.includes(p));
    if (!outs.length) return;
    lineup[s] = next.slice();
    if (log.on)
      ev(
        s,
        outs.length === 1
          ? `Substitution: ${name(s, ins[0])} in for ${name(s, outs[0])}`
          : `Substitution: ${ins.map((p) => name(s, p)).join(", ")} in`,
      );
  };

  const startPeriod = () => {
    if (period === 1 || period === 3) {
      for (let s = 0; s < 2; s++) {
        const avail = T[s].roster.filter((p) => !fouledOut(s, p));
        const st = T[s].starters.filter((p) => avail.includes(p));
        const fill = avail.filter((p) => !st.includes(p)).sort((a, b) => tgt[s][b] - tgt[s][a]);
        setLineup(s, st.concat(fill).slice(0, 5));
      }
    } else {
      rotate(0, true);
      rotate(1, true);
    }
  };

  // ---------------------------------------------------------- actions

  const pickActor = (
    s: number,
    w: (p: NbaPlayer, i: number) => number,
    pow = 1,
    form?: number[],
  ) => {
    const ps = lineup[s];
    const weights = ps.map((i) => Math.pow(w(T[s].team.players[i], i), pow) * (form ? form[i] : 1));
    return ps[rng.pick(weights)];
  };

  const foul = (d: number, shooting: boolean) => {
    // A player in foul trouble defends more carefully (2025-26: 0.18
    // foul-outs a game).
    const p = pickActor(
      d,
      (x, i) => x.pf * (fouls[d][i] >= 4 ? 0.45 : fouls[d][i] === 3 ? 0.8 : 1),
    );
    fouls[d][p]++;
    box.add(d, p, NBA.PF, 1);
    if (log.on && !shooting) ev(d, `Personal foul: ${name(d, p)}`);
    if (fouledOut(d, p)) {
      if (log.on) ev(d, `${name(d, p)} fouls out`);
      rotate(d, true);
    }
    return p;
  };

  /** Free throws. Returns true if possession changes (last one made, or the
   *  defense rebounds the miss). */
  const freeThrows = (s: number, p: number, n: number): boolean => {
    const pl = T[s].team.players[p];
    let lastMade = false;
    for (let k = 1; k <= n; k++) {
      lastMade = rng.chance(pl.ftp);
      box.add(s, p, NBA.FTA, 1);
      if (lastMade) {
        box.add(s, p, NBA.FTM, 1);
        box.add(s, p, NBA.PTS, 1);
        add(s, 1);
      }
      if (log.on)
        ev(s, `${pl.short} ${lastMade ? "makes" : "misses"} free throw ${k} of ${n}`, {
          scoring: lastMade,
        });
    }
    if (lastMade) return true;
    return !rebound(s, 0.45);
  };

  /** A rebound after a miss. Returns true if the offense keeps it. */
  const rebound = (s: number, scale: number): boolean => {
    let o = 0;
    let d = 0;
    for (const p of lineup[s]) o += T[s].team.players[p].oreb;
    for (const p of lineup[1 - s]) d += T[1 - s].team.players[p].dreb;
    const pOff = prob(odds(scale * (o / Math.max(1e-6, o + d))) * T[1 - s].vs.orebOdds);
    if (rng.chance(pOff)) {
      const r = pickActor(s, (x) => x.oreb, REB_POW);
      box.add(s, r, NBA.OREB, 1);
      if (log.on) ev(s, `${name(s, r)} offensive rebound`);
      return true;
    }
    // Some misses are team rebounds — out of bounds off the shooter, the end
    // of a quarter — and go in no one's box line (2025-26: 32.6 defensive
    // rebounds a team in box scores).
    if (rng.chance(TEAM_REB)) {
      if (log.on) ev(1 - s, `${T[1 - s].team.name} team rebound`);
      return false;
    }
    const r = pickActor(1 - s, (x) => x.dreb, REB_POW);
    box.add(1 - s, r, NBA.DREB, 1);
    if (log.on) ev(1 - s, `${name(1 - s, r)} defensive rebound`);
    return false;
  };

  const shotText = (pl: NbaPlayer, three: boolean): string => {
    if (three) return `${flavor.int(23, 28)}-foot three point jumper`;
    const big = pl.pos.includes("C");
    const r = flavor.next();
    if (r < (big ? 0.28 : 0.12)) return "dunk";
    if (r < (big ? 0.62 : 0.45)) return flavor.chance(0.5) ? "driving layup" : "layup";
    if (r < (big ? 0.75 : 0.6)) return big ? "hook shot" : "floater";
    return `${flavor.int(10, 21)}-foot jumper`;
  };

  /** One player uses the possession. Returns true if it ends. */
  const action = (s: number, buzzer: boolean, heave: boolean): boolean => {
    const d = 1 - s;
    const tp = T[s];
    const dp = T[d];
    // This defense draws fouls and forces turnovers at its own rates.
    const ftW = 0.44 * dp.vs.ft;
    const tovW = dp.vs.tov;
    const p = pickActor(s, (x) => x.fg2a + x.fg3a + ftW * x.fta + tovW * x.tov, ROLE_POW, usage[s]);
    const pl = tp.team.players[p];
    const shots = pl.fg2a + pl.fg3a;
    const total = shots + ftW * pl.fta + tovW * pl.tov;
    let r = rng.next() * total;
    if (!buzzer && r < tovW * pl.tov) {
      box.add(s, p, NBA.TOV, 1);
      let steal = 0;
      for (const q of lineup[d]) steal += dp.team.players[q].stl;
      if (rng.chance(Math.min(0.85, 0.62 * (steal / (5 * prep.env.stl))))) {
        const st = pickActor(d, (x) => x.stl);
        box.add(d, st, NBA.STL, 1);
        if (log.on) ev(s, `${pl.short} bad pass (${name(d, st)} steals)`);
      } else if (log.on)
        ev(s, `${pl.short} ${flavor.chance(0.5) ? "lost ball" : "traveling"} turnover`);
      return true;
    }
    r -= tovW * pl.tov;
    if (!buzzer && r < ftW * pl.fta) {
      const fouler = foul(d, true);
      const n = rng.chance(0.08) ? 3 : 2;
      if (log.on) ev(d, `Shooting foul: ${name(d, fouler)}`);
      return freeThrows(s, p, n);
    }
    // A field-goal attempt.
    // Down three late, nobody shoots a two; down two, most teams play for the
    // tie rather than the win.
    const behind = score[d] - score[s];
    const late = period >= REG && clk < 20;
    const three =
      (late && behind === 3) ||
      (!(late && behind === 2 && rng.chance(0.7)) &&
        rng.chance(prob(odds(pl.fg3a / Math.max(1e-6, shots)) * dp.vs.threeRate)));
    const lead = Math.max(-20, Math.min(20, score[s] - score[d]));
    // The shooter's percentage against this defense, by odds ratio.
    const base = prob(odds(three ? pl.fg3p : pl.fg2p) * (three ? dp.vs.three : dp.vs.two));
    let pMake = base * tp.makeF * (1 - SCORE_EFFECT * lead);
    if (heave) pMake *= 0.25;
    const made = rng.chance(Math.min(0.92, pMake));
    box.add(s, p, NBA.FGA, 1);
    if (three) box.add(s, p, NBA.TPA, 1);
    const what = log.on ? shotText(pl, three) : "";
    if (made) {
      const pts = three ? 3 : 2;
      box.add(s, p, NBA.FGM, 1);
      if (three) box.add(s, p, NBA.TPM, 1);
      box.add(s, p, NBA.PTS, pts);
      add(s, pts);
      // Assisted on ~62% of makes, more for a passing lineup.
      let ast = 0;
      for (const q of lineup[s]) if (q !== p) ast += tp.team.players[q].ast;
      const pAst = Math.min(
        0.85,
        Math.max(0.35, 0.62 * (ast / (4 * prep.env.ast)) * (three ? 1.2 : 0.92)),
      );
      let assister = -1;
      if (rng.chance(pAst)) {
        const mates = lineup[s].filter((q) => q !== p);
        assister = mates[rng.pick(mates.map((q) => Math.pow(tp.team.players[q].ast, ROLE_POW)))];
        box.add(s, assister, NBA.AST, 1);
      }
      if (log.on)
        ev(
          s,
          `${pl.short} makes ${what}${assister >= 0 ? ` (${name(s, assister)} assists)` : ""}`,
          { scoring: true, big: three && Math.abs(score[0] - score[1]) <= 3 && period >= REG },
        );
      // And-one.
      if (!buzzer && rng.chance(three ? 0.004 : 0.035)) {
        const fouler = foul(d, true);
        if (log.on) ev(d, `Shooting foul: ${name(d, fouler)} — and one`);
        return freeThrows(s, p, 1);
      }
      return true;
    }
    // Missed. Blocked?
    let blk = 0;
    for (const q of lineup[d]) blk += dp.team.players[q].blk;
    const pBlk = Math.min(0.3, (blk / (5 * prep.env.blk)) * (three ? 0.04 : 0.175));
    if (rng.chance(pBlk)) {
      const b = pickActor(d, (x) => x.blk);
      box.add(d, b, NBA.BLK, 1);
      if (log.on) ev(s, `${pl.short} misses ${what} (${name(d, b)} blocks)`);
    } else if (log.on) ev(s, `${pl.short} misses ${what}`);
    if (buzzer && clk <= 0) return true;
    return !rebound(s, three ? 1.05 : 0.95);
  };

  // ---------------------------------------------------------- the loop

  const lengthFor = (s: number): number => {
    const lead = score[s] - score[1 - s];
    const late = period >= REG && clk <= 24;
    if (late && lead > 0) return Math.min(clk, rng.uniform(20, 24));
    if (late && lead <= 0) return Math.max(0.5, clk - rng.uniform(1, 4));
    // Trailing late: hurry.
    if (period >= REG && clk < 120 && lead < 0)
      return Math.max(3, rng.gamma(3, (meanPoss * 0.6) / 3));
    return Math.min(24, Math.max(3, 2 + rng.gamma(2.6, (meanPoss - 2) / 2.6)));
  };

  if (log.on) ev(tipWinner, `Jump ball: ${T[tipWinner].team.name} gain possession`);

  for (;;) {
    startPeriod();
    periodScore[0] = 0;
    periodScore[1] = 0;
    while (clk > 0) {
      const s = off;
      const d = 1 - s;
      // Intentional foul: the defense is behind in the last half-minute.
      const deficit = score[s] - score[d];
      if (period >= REG && clk < 32 && deficit >= 1 && deficit <= 6) {
        tick(rng.uniform(1.5, 4));
        const fouler = foul(d, false);
        const target = pickActor(s, (x) => (x.fg2a + x.fg3a + x.fta + 0.05) * x.ftp * x.ftp);
        if (log.on) ev(d, `${name(d, fouler)} fouls ${name(s, target)} intentionally`);
        if (freeThrows(s, target, 2)) off = d;
        continue;
      }
      if (elapsedTotal - lastSub > 100 && clk > 20) {
        rotate(0, false);
        rotate(1, false);
        lastSub = elapsedTotal;
      }
      // Common fouls don't end possessions but they do fill a box score.
      if (rng.chance(0.075)) foul(d, false);
      let len = lengthFor(s);
      let ended = false;
      let guard = 0;
      while (!ended && guard++ < 8) {
        const buzzer = len >= clk;
        const heave = buzzer && clk < 2.5;
        tick(len);
        ended = action(s, buzzer, heave) || clk <= 0;
        len = Math.min(clk, rng.uniform(3, 9));
        if (clk <= 0) break;
      }
      off = d;
    }
    periods.home.push(periodScore[0]);
    periods.away.push(periodScore[1]);
    if (log.on)
      ev(
        null,
        `End of ${period > REG ? (period === REG + 1 ? "OT" : `${period - REG}OT`) : `${ordinal(period)} quarter`}`,
      );
    if (period >= REG && score[0] !== score[1]) break;
    if (period > REG + 6) break; // safety: six overtimes and we call it
    period++;
    clk = period > REG ? OT_LEN : QUARTER;
    // Q2 and Q3 go to the team that lost the tip, Q4 to the one that won it.
    off = period > REG ? (rng.chance(0.5) ? 0 : 1) : period === 4 ? tipWinner : 1 - tipWinner;
  }

  const ot = period > REG;
  return finish(score[0], score[1], periods, box, log, {
    ot,
    tie: false,
    status: ot ? (period === REG + 1 ? "Final/OT" : `Final/${period - REG}OT`) : "Final",
  });
}

export function simulateNba(
  m: NbaMatchup,
  o: SimOverrides,
  seed: number,
  record: boolean,
): GameResult {
  return playNba(prepareNba(m, o), seed, record);
}

/** Map of box index → player, for the UI. */
export function nbaRoster(m: NbaMatchup, side: Side): NbaPlayer[] {
  return m[side].players;
}

export const nbaSide = sideIdx;
