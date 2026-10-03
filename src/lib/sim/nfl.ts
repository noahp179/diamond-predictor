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
 *
 * College football (league "cfb") plays the same game under its own rules:
 * overtime is alternating possessions from the opponent's 25 — a two-point try
 * is required from the second period, and from the third each period is one
 * two-point play a side — so there are no ties; the clock stops on first downs
 * in the last two minutes of each half; pass interference is 15 yards at most;
 * kickoffs that are fair-caught or downed come out to the 25; a sack is a
 * quarterback rush in the box score, as college counts it. FCS teams play at
 * a discount against FBS ones, and the kicking, tempo, home field and
 * game-to-game spread are college's own.
 */

import { available, Box, clock, finish, Log, ordinal, Rng } from "./core";
import { NFL } from "./columns";
import coaching from "./nfl-coaching.json";
import type {
  FootballLeague,
  GameResult,
  NflEnv,
  NflPlayer,
  NflTeam,
  SimMatchup,
  SimOverrides,
  Side,
} from "./types";

type NflMatchup = Extract<SimMatchup, { league: FootballLeague }>;

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
const PASS_YDS = 1.068;
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
/** Accepted penalties per scrimmage snap (2025: 6.4 a team-game for 51 yards,
 *  about 5.4 of them on scrimmage plays, 57% on the offense). */
const PENALTY_RATE = 0.088;
/** Sacks per dropback against the quarterbacks' own rates (2025: 2.4 a team). */
const SACK_CAL = 0.9;
/** Breakaway shares: runs that go 9+ yards beyond the pile, catches that go
 *  20+ (2025: 3.5 plays of 20+ yards per team per game). */
const RUN_TAIL = 0.026;
const CATCH_TAIL = 0.033;
/** On third and fourth down quarterbacks throw to the sticks: the share of
 *  completions that would have come up short which are instead caught past
 *  the line to gain (sets conversion by distance to 2025's). */
const STICKS = 0.3;
/** Share of a quarterback's non-kneel carries that are scrambles on called
 *  passes rather than designed runs (2025: ~2.1 scrambles a team-game). */
const SCRAMBLE_SHARE = 0.66;
/** Starting quarterback knocked out of the game, per snap (≈5% of games). */
const QB_INJURY = 0.0007;
/** Roof effects on passing: completion odds and yards per catch. */
const INDOOR_CMP = 1.045;
const INDOOR_YDS = 1.022;
const OUTDOOR_CMP = 0.982;
const OUTDOOR_YDS = 0.992;

// ------------------------------------------------------------ college
// Calibrated against every FBS game of 2025 (SIMULATOR.md, realism benchmark).

/** Seconds between snaps with the clock running: college runs more plays
 *  (2025: 66 offensive plays a team-game, the NFL's ~60). */
const CFB_RUNOFF = 31;
const CFB_HOME_EDGE = 0.022;
const CFB_FORM_SD = 0.09;
/** Kickoffs fair-caught or downed in the end zone, out to the 25. */
const CFB_TOUCHBACK = 0.55;
const CFB_KR_TD = 0.005;
/** An FCS team against an FBS one: its offense's efficiency, and how much
 *  more its defense gives up, than its numbers (made against FCS) say. */
const FCS_OFF = 0.84;
const FCS_DEF = 1.16;
/** How much a team's schedule-adjusted rating (points better than an average
 *  FBS team) lifts its offense and holds down the offense across from it, per
 *  point, in log efficiency — half to each side of the ball. Season statistics
 *  alone put teams about half as far apart as results do. */
export const CFB_STRENGTH = 0.0175;
/** Fourth-down go odds against the NFL's table from the same spots (2025:
 *  2.1 tries a team-game). */
const CFB_GO = 3.2;
/** Interceptions against the passers' own rates (2025: 0.79 a team-game). */
const CFB_INT = 0.86;
/** Share of college penalties that are 15-yard personal fouls beyond the NFL
 *  mix — targeting, unsportsmanlike conduct (2025: 8.3 yards a penalty). */
const CFB_PERSONAL = 0.06;
/** Third-and-short: college quarterbacks carry it themselves more often. */
const CFB_SNEAK = 0.5;
/** Runs: breakaway share, and the shape and offset of the rest (NFL: 0.026,
 *  2.5, 2). */
const CFB_RUN_SHAPE: [number, number, number] = [0.027, 1.8, 3];
/** Throws to the sticks on third and fourth down (NFL: STICKS). */
const CFB_STICKS = 0.24;
/** Catches that go 20+ (NFL: CATCH_TAIL). */
const CFB_CATCH_TAIL = 0.027;
/** Tackles: concentration on the regulars, and the share that are shared. */
const CFB_DEF_POW = 1.6;
const CFB_ASSISTED_TKL = 0.38;
/** Accepted penalties per snap (2025: 6.0 a team-game for 53 yards). */
const CFB_PENALTY_RATE = 0.083;
/** Completion odds, sack odds and run yardage against the NFL calibration
 *  (2025: 61.9% completions, 2.0 sacks and 154 rushing yards a team-game). */
const CFB_CMP = 1.15;
const CFB_SACK_CAL = 0.79;
const CFB_RUN_YDS = 1.0;
/** Usage concentration: college depth charts run deeper on paper (backups'
 *  garbage-time games) than they play in a close game (2025: 7.3 players catch
 *  a pass a team-game; the top rusher gains 84 yards). */
const CFB_TARGET_POW = 1.5;
const CFB_RUSH_POW = 1.6;
/** Kickoff returns that are not fair-caught: where the drive starts. */
const CFB_RET_MEAN = 24;
/** Share of touchdowns followed by a two-point try beyond the chart, and how
 *  often a try succeeds. */
const CFB_TWO = 0.07;
const CFB_TWO_OK = 0.46;
/** College field-goal make rate by distance (2025: 92% from 20–29, 85% from
 *  30–39, 67% from 40–49, 51% from 50+). */
function cfbFgCurve(dist: number): number {
  return 1 / (1 + Math.exp(-(4.5 - 0.084 * dist)));
}

interface TeamPrep {
  team: NflTeam;
  qb: number;
  backupQb: number;
  rushers: number[];
  rushW: number[];
  /** The starter's yards per designed run (his season line less kneels). */
  qbYpc: number;
  /** Per quarterback (player index): chance a called pass becomes a scramble. */
  scramble: Record<number, number>;
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
  /** Odds multiplier on going for it on fourth down: the head coach's lean. */
  goOdds: number;
  maxFg: number;
}

export interface NflPrep {
  m: NflMatchup;
  t: [TeamPrep, TeamPrep];
  env: NflEnv;
  playoff: boolean;
  /** College rules (see the header). */
  college: boolean;
  /** Passing under a roof versus outdoors: [completion odds, yards]. */
  roof: [number, number];
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
  const college = m.league === "cfb";
  const opp = side === "home" ? m.away : m.home;
  // An FCS defense's numbers came against FCS offenses.
  // College: the defense's half of the team's rating, and the FCS discount.
  const soft =
    (college && team.fcs && !opp.fcs ? FCS_DEF : 1) *
    (college ? Math.exp((-CFB_STRENGTH * (team.rating ?? 0)) / 2) : 1);
  const vs = {
    cmpOdds: (oddsRatio("defCmp") ?? Math.pow(fallback, 0.8)) * soft,
    ypc: (ratio("defYpc") ?? fallback) * soft,
    sackOdds:
      (Math.pow(oddsRatio("defSack") ?? 1 / Math.sqrt(fallback), 0.75) * Math.pow(rushF, 0.25)) /
      soft,
    int:
      (Math.pow(ratio("defInt") ?? Math.pow(fallback, -0.7), 0.75) * Math.pow(coverF, 0.25)) / soft,
    rush: (ratio("defYpcRush") ?? fallback) * soft,
  };
  const edge = college ? CFB_HOME_EDGE : HOME_EDGE;
  const pace = t.pace;
  const tempo = pace ? Math.max(0.85, Math.min(1.15, pace.league / Math.max(1, pace.value))) : 1;
  const k = kicker >= 0 ? P[kicker] : null;
  return {
    team,
    qb,
    backupQb,
    rushers,
    // Raised to a power as in nba.ts: per-game roles from other depth charts
    // overlap, and the starters get the ball (2025: 7.1 players catch a pass
    // a team-game).
    rushW: rushers.map((i) =>
      i === qb
        ? qbRuns * (1 - SCRAMBLE_SHARE)
        : college
          ? Math.pow(P[i].carries, CFB_RUSH_POW) / Math.pow(8, CFB_RUSH_POW - 1)
          : Math.pow(P[i].carries, 1.15),
    ),
    qbYpc,
    scramble: Object.fromEntries(
      [qb, backupQb].map((i) => {
        const p = P[i];
        const runs = i === qb ? qbRuns : (p?.carries ?? 0);
        return [
          i,
          p ? Math.min(0.15, (SCRAMBLE_SHARE * runs) / Math.max(10, p.passAtt + 2.5)) : 0.03,
        ];
      }),
    ),
    targets,
    targetW: targets.map((i) => Math.pow(P[i].targets, college ? CFB_TARGET_POW : 1.2)),
    kicker,
    punter,
    def,
    // Raised to a power for the same reason as usage in nba.ts: per-game
    // lines from deeper or different depth charts overlap, and the starters
    // make the plays.
    // College rosters carry twice the defenders who play, so the regulars'
    // share is weighted by how much they have played (2025 FBS: 21 players
    // make a tackle a team-game, the leader 9.4 of 66).
    tackleW: def.map((i) =>
      college
        ? Math.pow(P[i].tackles, CFB_DEF_POW) * Math.min(1, P[i].sample / 4)
        : Math.pow(P[i].tackles, DEF_POW),
    ),
    sackW: def.map((i) =>
      college
        ? Math.pow(P[i].sacks + 0.01, CFB_DEF_POW) * Math.min(1, P[i].sample / 4)
        : Math.pow(P[i].sacks + 0.01, DEF_POW),
    ),
    intW: def.map((i) => P[i].ints + 0.005),
    off:
      (neutral ? 1 : side === "home" ? 1 + edge : 1 - edge) *
      (college && team.fcs && !opp.fcs ? FCS_OFF : 1) *
      (college ? Math.exp((CFB_STRENGTH * (team.rating ?? 0)) / 2) : 1),
    vs,
    tempo,
    goOdds: college
      ? CFB_GO
      : odds(Math.max(0.02, Math.min(0.98, GO_LEAGUE + (team.goAggr ?? 0)))) / odds(GO_LEAGUE),
    // College kickers have less range (2025: 11% of attempts from 50+).
    maxFg: college
      ? k
        ? Math.max(46, Math.min(58, 51 + 25 * (k.fgSkill - 1) + (k.longFg >= 52 ? 3 : 0)))
        : 47
      : k
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
    college: m.league === "cfb",
    // Domes score ~2.2 more points a game than open air (2010–25), almost all
    // of it through the air; the league average sits between the two. College
    // plays almost everything outdoors, and is calibrated as it is.
    roof:
      m.league === "cfb"
        ? [1, 1]
        : m.ctx.indoor
          ? [INDOOR_CMP, INDOOR_YDS]
          : [OUTDOOR_CMP, OUTDOOR_YDS],
  };
}

// ------------------------------------------------------------- helpers

const odds = (p: number) => p / Math.max(1e-6, 1 - p);
/** The league's fourth-down go rate by yards to go and distance from the goal
 *  line in tens — the last two seasons of play-by-play, from
 *  scripts/build-nfl-coaching.ts — and its rate where coaches are compared. */
const GO_TABLE = coaching.league.goTable as Record<string, number>;
const GO_LEAGUE = coaching.league.fourthGo;
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
  const college = prep.college;
  const formSd = college ? CFB_FORM_SD : FORM_SD;
  const form = [0, 1].map(() => Math.max(0.75, Math.min(1.25, 1 + rng.normal(0, formSd))));

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
  // College overtime: untimed possessions from the 25 (collegeOvertime).
  let cfbOt = false;
  let driveOver = false;
  let otPeriod = 0;
  let otOffense = 0;
  let otSecond = 1;
  // College stops the clock on a first down in the last two minutes of a
  // half, until the chains are set.
  let chainStop = false;

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

  /** Log a play. `sit` overrides the down-and-distance shown with it: the
   *  situation before a penalty, or none for kickoffs and tries. */
  const ev = (
    side: number | null,
    text: string,
    extra: { scoring?: boolean; big?: boolean; sit?: string } = {},
  ) =>
    log.push({
      period: quarter,
      clock: cfbOt ? "" : clock(clk),
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
    if (cfbOt) return true;
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

  // Tied late, an NFL team plays for the win too: in 2025 only 12% of games
  // tied at the two-minute warning reached overtime. College coaches are
  // content to take it to overtime (2025: 5.5% of FBS games).
  const hurry = (s: number) =>
    !cfbOt &&
    ((quarter === 2 && clk <= 120) ||
      (quarter === 4 && diff(s) < 0 && clk <= 300) ||
      (quarter === 4 && diff(s) === 0 && clk <= 150 && !college) ||
      (quarter === 4 && diff(s) < -8 && clk <= 600) ||
      (ot() && (diff(s) < 0 || (diff(s) === 0 && clk <= 150))));
  const milk = (s: number) => quarter === 4 && diff(s) > 0 && clk <= 420;

  /** Time between the end of one play and the next snap. */
  const betweenPlays = () => {
    if (stopped || cfbOt) {
      stopped = false;
      chainStop = false;
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
    if (timeouts[s] > 0 && hurry(s) && clk <= 60 && (quarter === 2 || diff(s) <= 0)) {
      timeouts[s]--;
      if (log.on) ev(s, `Timeout ${T[s].team.abbr} (${timeouts[s]} left)`);
      return 0;
    }
    if (chainStop) {
      chainStop = false;
      return rng.uniform(5, 9);
    }
    if (hurry(s)) return rng.uniform(10, 17);
    if (milk(s)) return rng.uniform(36, 40);
    if (ot()) return rng.uniform(18, 28);
    return Math.max(10, rng.normal((college ? CFB_RUNOFF : RUNOFF) * T[s].tempo, 4));
  };

  // ------------------------------------------------------- possession

  const changePossession = (newYl: number) => {
    if (cfbOt) driveOver = true;
    if (ot() && !college) otPossessions[poss]++;
    poss = 1 - poss;
    yl = Math.max(1, Math.min(99, Math.round(newYl)));
    down = 1;
    toGo = Math.min(10, 100 - yl);
    stopped = true;
    checkOtEnd();
  };

  const checkOtEnd = () => {
    if (!ot() || college) return;
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
          ev(kicking, `Onside kick — RECOVERED by ${T[kicking].team.abbr}!`, {
            big: true,
            sit: "",
          });
      } else {
        yl = 55;
        if (log.on) ev(recv, `Onside kick recovered by ${T[recv].team.abbr}`, { sit: "" });
      }
      down = 1;
      toGo = 10;
      return;
    }
    if (rng.chance(college ? CFB_KR_TD : 0.004)) {
      // Returned all the way.
      yl = 75;
      down = 1;
      toGo = 10;
      if (log.on)
        ev(recv, `Kickoff returned for a TOUCHDOWN!`, { scoring: true, big: true, sit: "" });
      touchdown(recv, -1, "kick return");
      return;
    }
    if (rng.chance(college ? CFB_TOUCHBACK : 0.38)) {
      // NFL 2025: touchbacks to the 35. College: touchbacks and fair catches
      // inside the 25 come out to the 25.
      yl = college ? 25 : 35;
      burn(0);
      if (log.on)
        ev(
          recv,
          college && flavor.chance(0.2)
            ? `Kickoff, fair catch — ball at the ${T[recv].team.abbr} 25`
            : `Kickoff, touchback`,
          { sit: "" },
        );
    } else {
      yl = Math.round(
        Math.max(college ? 5 : 8, Math.min(60, rng.normal(college ? CFB_RET_MEAN : 29, 7))),
      );
      burn(rng.uniform(5, 8));
      if (log.on) ev(recv, `Kickoff returned to the ${spot()}`, { sit: "" });
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
    const p = prob(odds(college ? cfbFgCurve(dist) : fgCurve(dist)) * Math.pow(skill, 4));
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
    if (cfbOt) {
      driveOver = true;
      return;
    }
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

  const twoPointTry = (s: number, play = false) => {
    const ok = rng.chance(college ? CFB_TWO_OK : 0.48);
    if (ok) {
      addScore(s, 2);
      const who = rng.chance(0.55) ? pickTarget(s, true) : pickRusher(s, true);
      if (who >= 0) box.add(s, who, NFL.TWOPT, 1);
    }
    if (log.on)
      ev(s, `${play ? "Two-point play" : "Two-point try"} ${ok ? "is GOOD" : "fails"}`, {
        scoring: ok,
        big: play,
        sit: "",
      });
  };

  const extraPoint = (s: number) => {
    const ki = T[s].kicker;
    const p = ki >= 0 ? P(s, ki).xpPct : 0.94;
    const ok = rng.chance(p);
    if (ki >= 0) {
      box.add(s, ki, NFL.XPA, 1);
      if (ok) box.add(s, ki, NFL.XPM, 1);
    }
    if (ok) addScore(s, 1);
    if (log.on)
      ev(s, `${nm(s, ki)} extra point ${ok ? "is good" : "is NO GOOD"}`, {
        scoring: ok,
        sit: "",
      });
  };

  const touchdown = (s: number, scorer: number, how: string) => {
    addScore(s, 6);
    void how;
    void scorer;
    if (cfbOt) {
      // A defensive score ends it; so does the side with the ball second
      // going ahead. From the second period the try must be for two.
      if (s !== otOffense || (s === otSecond && diff(s) > 0)) {
        gameOver = true;
        driveOver = true;
        return;
      }
      if (otPeriod >= 2 || diff(s) === -2) twoPointTry(s);
      else extraPoint(s);
      afterScore(s);
      return;
    }
    // Extra point or two?
    const d = diff(s); // after the six
    const late = quarter >= 4;
    const goFor2 = late && [-2, -5, -9, -10, -12, 1, 5].includes(d) && !(ot() && otSudden);
    if (ot() && otSudden) {
      gameOver = true;
      return;
    }
    // Beyond the chart, coaches go for two after ~16% of touchdowns, which
    // with it comes to 2025's 9–10%.
    if (goFor2 || rng.chance(college ? CFB_TWO : 0.16)) twoPointTry(s);
    else extraPoint(s);
    afterScore(s);
  };

  const safety = (s: number) => {
    // `s` is the defense scoring two.
    addScore(s, 2);
    if (log.on) ev(s, `SAFETY — ${T[s].team.abbr} score two`, { scoring: true, big: true });
    if (cfbOt) {
      driveOver = true;
      return;
    }
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
    if (rng.chance(college ? CFB_ASSISTED_TKL : ASSISTED_TKL)) {
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
    let p = T[s].team.passRate - (college ? 0.055 : 0.04);
    const dist = 100 - yl;
    // College runs more on third- and fourth-and-short.
    if (down === 3) p = toGo >= 5 ? 0.9 : toGo >= 3 ? 0.72 : college ? 0.32 : 0.45;
    else if (down === 4) p = toGo >= 3 ? 0.85 : college ? 0.38 : 0.5;
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
    if (cfbOt) {
      // Going second, the side knows what it needs; going first, three
      // points are worth taking unless the goal line is a step away.
      if (s === otSecond) return d < -3 || !inRange ? "go" : "fg";
      if (!inRange) return "go";
      return toGo <= 1 && dist <= 3 && rng.chance(0.4) ? "go" : "fg";
    }
    const late = quarter === 4 || ot();
    const timeLeft = clk;
    // Late and needing a touchdown: there is no punting.
    if (late && d < -3 && timeLeft <= 300) return "go";
    if (late && d < 0 && timeLeft <= 120 && !inRange) return "go";
    if (late && d >= -3 && d <= 0 && inRange && (timeLeft <= 120 || toGo > 3)) return "fg";
    if (ot() && otPossessions[1 - s] >= 1 && d < 0 && !inRange) return "go";
    // Otherwise what the league's coaches actually did from this spot,
    // leaning the way this head coach leans; kick if not going.
    const key = `${Math.min(10, Math.max(1, toGo))}:${Math.min(9, Math.floor(dist / 10))}`;
    const base = Math.min(0.99, GO_TABLE[key] ?? 0);
    if (base > 0 && rng.chance(prob(odds(base) * T[s].goOdds))) return "go";
    return inRange ? "fg" : "punt";
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
      if (college && (quarter === 2 || quarter === 4) && clk <= 120) chainStop = true;
      return true;
    }
    toGo -= yards;
    down++;
    if (down > 4) {
      if (log.on) ev(1 - poss, `Turnover on downs`, { sit: "" });
      changePossession(100 - yl);
      return false;
    }
    return true;
  };

  /** The field shrinks near the goal line: less room, tighter coverage
   *  (2025: 5.9 yards a play outside the 20, 4.1 from the 20 to the 11). */
  const squeeze = (dist: number) => (dist >= 20 ? 1 : 0.72 + 0.014 * dist);

  // College gains are more boom-or-bust than the NFL's: more runs stopped
  // behind the line and more that break (2025 FBS: 20.1 first downs and 4.4
  // plays of 20+ yards on 376 yards a team-game).
  // Short yardage is a power run either way.
  const runYards = (mean: number): number => {
    const [runTail, runShape, runOff] =
      college && !(down >= 3 && toGo <= 3) ? CFB_RUN_SHAPE : [RUN_TAIL, 2.5, 2];
    // Most runs bunch around three yards; about one in thirty breaks loose.
    if (rng.chance(runTail)) return Math.round(9 + rng.exp(11));
    const mb = (mean - runTail * 20) / (1 - runTail);
    return Math.round(rng.gamma(runShape, (mb + runOff) / runShape) - runOff);
  };

  const catchYards = (mean: number): number => {
    const tail = college ? CFB_CATCH_TAIL : CATCH_TAIL;
    if (rng.chance(tail)) return Math.round(20 + rng.exp(14));
    const mb = (mean - tail * 34) / (1 - tail);
    return Math.round(rng.gamma(1.8, (Math.max(2, mb) + 1.5) / 1.8) - 1.5);
  };

  const runPlay = () => {
    const s = poss;
    const d = 1 - s;
    const dist = 100 - yl;
    // Third or fourth and a yard: a third of the time the quarterback sneaks
    // (2025: 36% of those runs), which almost always works.
    if (down >= 3 && toGo <= 1 && dist > 1 && rng.chance(college ? CFB_SNEAK : 0.36)) {
      const q = qb[s];
      const y = rng.chance(college ? 0.88 : 0.86) ? (rng.chance(0.2) ? 2 : 1) : 0;
      team[s].PLAYS++;
      box.add(s, q, NFL.CAR, 1);
      box.add(s, q, NFL.RYD, y);
      gain(s, y, true);
      const t = tackle(d);
      burn(rng.uniform(4, 6));
      if (log.on)
        ev(
          s,
          `${nm(s, q)} quarterback sneak for ${y} yard${y === 1 ? "" : "s"}${t >= 0 ? ` (${nm(d, t)})` : ""}`,
        );
      spotBall(y);
      return;
    }
    const r = pickRusher(s, dist <= 20);
    const pl = P(s, r);
    const ypc = r === T[s].qb ? T[s].qbYpc : pl.ypc_r;
    const runCal = college ? CFB_RUN_YDS : RUN_YDS;
    // College short yardage is a power run behind a push (2025: 73% of
    // third-and-ones converted).
    const push = college && down >= 3 && toGo <= 2 ? 0.8 : 0;
    const mean = ypc * runCal * T[d].vs.rush * T[s].off * form[s] * squeeze(dist) + push;
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
    const pSack = Math.min(
      0.2,
      prob(odds(qp.sackRate) * T[d].vs.sackOdds * (college ? CFB_SACK_CAL : SACK_CAL)),
    );
    if (rng.chance(pSack)) {
      const loss = Math.max(1, Math.round(rng.normal(7, 2.5)));
      const sacker = T[d].def.length ? T[d].def[rng.pick(T[d].sackW)] : -1;
      box.add(s, q, NFL.SK, 1);
      box.add(s, q, NFL.SKY, loss);
      // College counts a sack as a quarterback rush for the loss.
      if (college) {
        box.add(s, q, NFL.CAR, 1);
        box.add(s, q, NFL.RYD, -loss);
      }
      if (sacker >= 0) box.add(d, sacker, NFL.DSK, 1);
      team[s].SACKS++;
      gain(s, -loss, college);
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
    // Scramble: the pass breaks down and the quarterback runs. Called passes,
    // so the quarterback's designed runs are fewer to match (prepTeam).
    if (rng.chance(T[s].scramble[q] ?? 0.03)) {
      const ypc = q === T[s].qb ? T[s].qbYpc : qp.ypc_r;
      // Scrambles gain more than designed runs: ~7 yards a time in 2025.
      const mean = Math.max(4, ypc * 1.35) * RUN_YDS * T[s].off * form[s];
      const y = Math.min(dist, runYards(mean));
      box.add(s, q, NFL.CAR, 1);
      box.add(s, q, NFL.RYD, y);
      box.max(s, q, NFL.RLNG, y);
      gain(s, y, true);
      if (y >= dist) {
        box.add(s, q, NFL.RTD, 1);
        burn(rng.uniform(4, 7));
        if (log.on) ev(s, `TOUCHDOWN — ${nm(s, q)} ${dist}-yard run`, { scoring: true, big: true });
        yl = 100;
        touchdown(s, q, "run");
        return;
      }
      const t = tackle(d);
      burn(rng.uniform(4, 7));
      if (log.on)
        ev(
          s,
          `${nm(s, q)} scrambles for ${y} yard${Math.abs(y) === 1 ? "" : "s"}${t >= 0 ? ` (${nm(d, t)})` : ""}`,
          { big: y >= 20 },
        );
      spotBall(y);
      return;
    }
    const tgt = pickTarget(s, dist <= 20);
    box.add(s, q, NFL.ATT, 1);
    if (tgt >= 0) box.add(s, tgt, NFL.TGT, 1);
    // Interception?
    const pInt = Math.min(0.12, qp.intRate * T[d].vs.int * (college ? CFB_INT : 1));
    // Words only (flavor stream): which side, and "deep" for throws that
    // travel — 18% of 2025's attempts, 12% of its completions.
    const lane = ["left", "middle", "right"][flavor.int(0, 2)];
    const where = (deep: boolean) => `${deep ? "deep" : "short"} ${lane}`;
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
            `${nm(s, q)} pass ${where(air >= 15)} INTERCEPTED by ${nm(d, picker)} and returned for a TOUCHDOWN`,
            { scoring: true, big: true },
          );
        if (picker >= 0) box.add(d, picker, NFL.DTD, 1);
        changePossession(99);
        yl = 100;
        touchdown(poss, picker, "interception return");
        return;
      }
      if (log.on)
        ev(s, `${nm(s, q)} pass ${where(air >= 15)} INTERCEPTED by ${nm(d, picker)}`, {
          big: true,
        });
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
        (college ? CFB_CMP : CMP_CAL) *
        T[s].off *
        form[s] *
        T[d].vs.cmpOdds *
        prep.roof[0] *
        (dist < 20 ? 0.75 + 0.0125 * dist : 1),
    );
    if (!rng.chance(Math.min(0.92, pCmp))) {
      burn(rng.uniform(4, 7));
      stopped = true;
      if (log.on)
        ev(
          s,
          `${nm(s, q)} pass incomplete ${where(flavor.chance(0.3))} intended for ${nm(s, tgt)}`,
        );
      spotBall(0);
      return;
    }
    const mean =
      rp.ypr *
      Math.pow(qp.ypc / env.ypc, 0.6) *
      PASS_YDS *
      T[d].vs.ypc *
      T[s].off *
      form[s] *
      prep.roof[1] *
      squeeze(dist);
    let y = catchYards(mean);
    // Third and fourth down: the throw goes to the sticks.
    // Long yardage is harder to reach (2025: 17% of 3rd-and-11+ converted).
    if (
      down >= 3 &&
      y < toGo &&
      rng.chance((college ? CFB_STICKS : STICKS) * Math.min(1, (college ? 5 : 8) / toGo))
    )
      y = toGo + Math.round(rng.exp(2.5));
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
          `${nm(s, q)} pass ${where(y >= 22)} to ${nm(s, tgt)} for ${y}, FUMBLE — ${T[d].team.abbr} recover`,
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
        `${nm(s, q)} pass ${where(y >= 22)} to ${nm(s, tgt)} for ${y} yard${Math.abs(y) === 1 ? "" : "s"}${t >= 0 ? ` (${nm(d, t)})` : ""}`,
        { big: y >= 25 },
      );
    spotBall(y);
  };

  /**
   * Accepted penalties in the 2025 mix: false starts, holding and pre-snap
   * fouls at 5–10 yards; pass interference at the spot; roughing, face masks
   * and unnecessary roughness at 15. Defensive holding, illegal contact and
   * the personal fouls carry an automatic first down. Half the distance near
   * the goal line.
   */
  const penalty = (): boolean => {
    if (!rng.chance(college ? CFB_PENALTY_RATE : PENALTY_RATE)) return false;
    const s = poss;
    const before = sit();
    if (college && rng.chance(CFB_PERSONAL)) {
      // A college personal foul on the defense: 15 yards and a first down.
      const d = 1 - s;
      const what = ["targeting", "unsportsmanlike conduct", "personal foul"][flavor.int(0, 2)];
      const yds = Math.max(1, Math.min(15, Math.floor((100 - yl) / 2)));
      team[d].PEN++;
      team[d].PENY += yds;
      yl += yds;
      down = 1;
      toGo = Math.min(10, 100 - yl);
      team[s].FD++;
      if (log.on)
        ev(d, `PENALTY ${T[d].team.abbr}: ${what}, ${yds} yards, automatic first down`, {
          sit: before,
        });
      burn(6);
      stopped = true;
      return true;
    }
    if (rng.chance(0.56)) {
      const r = rng.next();
      const [what, yds, live] =
        r < 0.3
          ? (["false start", 5, false] as const)
          : r < 0.62
            ? (["offensive holding", 10, true] as const)
            : r < 0.74
              ? (["illegal formation", 5, false] as const)
              : r < 0.84
                ? (["delay of game", 5, false] as const)
                : r < 0.92
                  ? (["offensive pass interference", 10, true] as const)
                  : (["unnecessary roughness", 15, true] as const);
      const loss = Math.min(yds, Math.floor((yl - 1) / 2) || 1);
      yl -= loss;
      toGo += loss;
      team[s].PEN++;
      team[s].PENY += loss;
      if (log.on) ev(s, `PENALTY ${T[s].team.abbr}: ${what}, ${loss} yards`, { sit: before });
      stopped = !live;
      if (live) burn(6);
      return true;
    }
    const d = 1 - s;
    const r = rng.next();
    const [what, auto, live] =
      r < 0.22
        ? (["pass interference", true, true] as const)
        : r < 0.5
          ? ([flavor.chance(0.5) ? "offside" : "neutral zone infraction", false, false] as const)
          : r < 0.68
            ? (["defensive holding", true, true] as const)
            : r < 0.76
              ? (["illegal contact", true, true] as const)
              : r < 0.84
                ? (["roughing the passer", true, true] as const)
                : r < 0.94
                  ? (["unnecessary roughness", true, true] as const)
                  : (["face mask", true, true] as const);
    let yds =
      what === "pass interference"
        ? Math.max(5, Math.round(rng.gamma(2, 6.5)))
        : r >= 0.76
          ? 15
          : 5;
    // College pass interference is 15 yards, or the spot if that is shorter.
    if (college && what === "pass interference") yds = Math.min(15, yds);
    // Pass interference is a spot foul (to the 1 at most); the rest stop at
    // half the distance to the goal.
    const half = Math.max(1, Math.floor((100 - yl) / 2));
    yds = Math.max(1, what === "pass interference" ? Math.min(yds, 99 - yl) : Math.min(yds, half));
    team[d].PEN++;
    team[d].PENY += yds;
    yl += yds;
    if (auto || yds >= toGo) {
      down = 1;
      toGo = Math.min(10, 100 - yl);
      team[s].FD++;
    } else toGo -= yds;
    if (log.on)
      ev(
        d,
        `PENALTY ${T[d].team.abbr}: ${what}, ${yds} yards${auto ? ", automatic first down" : ""}`,
        { sit: before },
      );
    if (live) burn(6);
    stopped = true;
    return true;
  };

  const kneel = (): boolean => {
    const s = poss;
    const d = 1 - s;
    if (quarter === 4 && diff(s) > 0) {
      // Kneels left before fourth down, ~40 seconds each, less what the
      // other side's timeouts can stop.
      const kneels = 4 - down;
      const canBurn = kneels * 40 + 5 - timeouts[d] * 38;
      if (clk <= Math.min(canBurn, 125) && clk > 0) return true;
    }
    // Run out the half from deep in their own end rather than risk a turnover.
    if (quarter === 2 && clk <= (college ? 10 : 20) && yl < 25 && diff(s) >= -3 && !stopped)
      return true;
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
    if (rng.chance(QB_INJURY) && T[s].backupQb !== qb[s]) {
      qb[s] = T[s].backupQb;
      if (log.on)
        ev(s, `${nm(s, T[s].qb)} is injured — ${nm(s, qb[s])} takes over at quarterback`, {
          big: true,
        });
    }
  };

  /**
   * College overtime. Each side gets the ball at the other's 25 with no
   * clock, the side going second knowing what it needs; the order alternates
   * each period. From the third period a side's turn is one two-point play.
   * Periods continue until one side leads after both have had theirs.
   */
  const collegeOvertime = () => {
    cfbOt = true;
    clk = QUARTER;
    // The toss winner takes the ball second.
    let first = rng.chance(0.5) ? 0 : 1;
    for (otPeriod = 1; otPeriod <= 30; otPeriod++) {
      quarter = 4 + otPeriod;
      otSecond = 1 - first;
      if (log.on)
        ev(
          null,
          otPeriod === 1
            ? `Overtime: ${T[first].team.name} have the ball first`
            : otPeriod === 3
              ? `Overtime period 3: two-point plays from here, ${T[first].team.abbr} first`
              : `Overtime period ${otPeriod}: ${T[first].team.abbr} first`,
          { sit: "" },
        );
      for (const s of [first, 1 - first]) {
        otOffense = s;
        poss = s;
        down = 1;
        stopped = true;
        if (otPeriod >= 3) {
          yl = 97;
          toGo = 3;
          twoPointTry(s, true);
        } else {
          yl = 75;
          toGo = 10;
          driveOver = false;
          for (let n = 0; n < 40 && !driveOver && !gameOver; n++) snap();
        }
        if (gameOver) return;
      }
      if (score[0] !== score[1]) return;
      first = 1 - first;
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
    if (college) {
      collegeOvertime();
      break;
    }
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
  // Both line scores carry the overtime column, scored in or not.
  if (wentOt) for (const arr of [periods.home, periods.away]) while (arr.length < 5) arr.push(0);
  const otTag = college && quarter > 5 ? `${quarter - 4}OT` : "OT";
  if (log.on)
    ev(
      null,
      tie
        ? `Final: tie, ${score[0]}–${score[1]}`
        : `Final${wentOt ? ` (${otTag})` : ""}: ${T[score[0] > score[1] ? 0 : 1].team.name} win`,
    );
  return finish(score[0], score[1], periods, box, log, {
    ot: wentOt,
    tie,
    team: { home: team[0], away: team[1] },
    status: wentOt ? (tie ? "Final/OT (tie)" : `Final/${otTag}`) : "Final",
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
