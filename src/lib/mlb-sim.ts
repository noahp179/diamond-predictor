// mlb-sim.ts — Model "sim-elo-v2"
// Monte Carlo game simulation + multi-season Elo, blended in logit space.
//
// Unlike the baseline models (hand-tuned log-odds blends over season
// aggregates), this simulates each game plate appearance by plate appearance:
// team batting event rates vs. the opposing starter (then the staff line as
// bullpen), a base-out state machine, a times-through-order penalty once the
// starter has faced 18 batters, an early hook when he's allowed 5 runs, park
// effects, home-field batting boost, extra innings with the ghost-runner rule,
// and walk-offs. The win probability is the fraction of N simulated games the
// home team wins.
//
// v2 protocol: every knob was tuned on a 622-game dev set (May 1 – Jul 1 2026,
// excluding the test window), then scored once, frozen, on the 187 settled DB
// games (2026-05-31 → 2026-06-15):
//   sim-elo-v2 ensemble  Brier 0.2471  log-loss 0.6873   ← shipped
//   home-always-54       Brier 0.2488
//   baseline-v0.4        Brier 0.2509  (stored predictions)
// Ablations (dev): a bullpen line reconstructed as staff-minus-rotation HURT
// accuracy (too noisy) — the full-staff line stays; damping the pitcher
// multiplier helped the sim alone but hurt the ensemble; a fitted stacker did
// not beat this equal logit-mean. Multi-season Elo (2 prior seasons, carry
// 0.75 toward the mean, K=6) beat single-season Elo by ~0.004 log-loss.
// Calibration constants (OFFENSE_CAL, HOME_BOOST) reproduce the 2026 league
// environment on a neutral matchup: 4.47 runs/team/game, 53.1% home win.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { parkFactor } from "./park-factors";

export const MODEL_VERSION_SIM = "sim-elo-v2";

const OFFENSE_CAL = 1.032; // calibrates sim run environment to league R/G
const HOME_BOOST = 1.028; // home on-base boost → ~53.1% neutral home win
const ELO_K = 6.0;
const ELO_HOME = 24.0;
const ELO_CARRY = 0.75; // between seasons, ratings regress 25% toward 1500
const TTO_BF = 18; // starter faces this many → times-through-order penalty
const TTO_MULT = 1.06; // on-base boost against a starter seen twice already
const HOOK_RUNS = 5; // starter pulled once he has allowed this many runs

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-PA batting event probabilities (bb includes HBP). */
export interface BattingRates {
  pa: number;
  bb: number;
  so: number;
  b1: number;
  b2: number;
  b3: number;
  hr: number;
}

/** Per-BF rates allowed by a pitcher or staff. */
export interface PitchingLine {
  so: number;
  bb: number;
  hr: number;
  b1: number;
  b2: number;
  b3: number;
}

export interface StarterInfo {
  line: PitchingLine;
  expectedOuts: number; // regressed outs per start
}

export interface SimGamePrediction {
  gameId: number;
  date: string;
  venue: string;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  simProb: number; // home win prob from Monte Carlo
  eloProb: number; // home win prob from Elo
  ensembleProb: number; // logit-average of the two (the headline number)
  homeElo: number;
  awayElo: number;
  nSims: number;
  rationale: string[];
}

// ─── Seeded RNG (mulberry32) so predictions are reproducible per game ────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Elo from season results ──────────────────────────────────────────────────

export interface SeasonGameResult {
  date: string;
  home: number;
  away: number;
  homeScore: number;
  awayScore: number;
}

/** All final regular-season results before `beforeDate` (exclusive). */
export async function fetchSeasonResults(
  season: number,
  beforeDate: string,
): Promise<SeasonGameResult[]> {
  const end = new Date(new Date(beforeDate + "T00:00:00Z").getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&startDate=${season}-03-01&endDate=${end}`;
  const res = await fetchWithTimeout(url, 30_000);
  if (!res.ok) return [];
  const json: any = await res.json();
  const out: SeasonGameResult[] = [];
  for (const d of json?.dates ?? []) {
    for (const g of d?.games ?? []) {
      const status: string = g?.status?.detailedState ?? "";
      if (!/final|game over|completed/i.test(status)) continue;
      const hs = g?.teams?.home?.score;
      const as = g?.teams?.away?.score;
      if (typeof hs !== "number" || typeof as !== "number" || hs === as) continue;
      out.push({
        date: d.date,
        home: g.teams.home.team.id,
        away: g.teams.away.team.id,
        homeScore: hs,
        awayScore: as,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * Replay seasons chronologically → current rating per team (start 1500).
 * Pass seasons oldest-first; between seasons every rating regresses
 * ELO_CARRY of the way back toward 1500 (roster churn).
 */
export function computeElo(seasonLogs: SeasonGameResult[][]): Map<number, number> {
  const elo = new Map<number, number>();
  const get = (id: number) => elo.get(id) ?? 1500;
  seasonLogs.forEach((results, idx) => {
    if (idx > 0) {
      for (const [id, r] of elo) elo.set(id, 1500 + ELO_CARRY * (r - 1500));
    }
    for (const r of results) {
      const rh = get(r.home);
      const ra = get(r.away);
      const homeWon = r.homeScore > r.awayScore ? 1 : 0;
      const expected = 1 / (1 + Math.pow(10, -(rh + ELO_HOME - ra) / 400));
      const margin = Math.abs(r.homeScore - r.awayScore);
      // FiveThirtyEight-style margin-of-victory multiplier
      const eloDiff = (rh + ELO_HOME - ra) * (homeWon ? 1 : -1);
      const mov = Math.pow(margin + 1, 0.7) / (7.5 + 0.006 * eloDiff);
      const delta = ELO_K * mov * (homeWon - expected);
      elo.set(r.home, rh + delta);
      elo.set(r.away, ra - delta);
    }
  });
  return elo;
}

export function eloWinProb(homeElo: number, awayElo: number): number {
  return 1 / (1 + Math.pow(10, -(homeElo + ELO_HOME - awayElo) / 400));
}

// ─── Team + pitcher rates from the Stats API ─────────────────────────────────

export interface TeamRates {
  batting: BattingRates | null;
  staff: PitchingLine | null; // full-staff per-BF rates (bullpen proxy)
}

/** Season counting stats → per-PA batting rates and per-BF staff rates. */
export async function fetchAllTeamRates(season: number): Promise<Map<number, TeamRates>> {
  const base = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=season`;
  const [hitRes, pitRes] = await Promise.all([
    fetchWithTimeout(`${base}&group=hitting`),
    fetchWithTimeout(`${base}&group=pitching`),
  ]);
  const map = new Map<number, TeamRates>();
  const init = (id: number) => {
    let r = map.get(id);
    if (!r) {
      r = { batting: null, staff: null };
      map.set(id, r);
    }
    return r;
  };
  if (hitRes.ok) {
    const j: any = await hitRes.json();
    for (const s of j?.stats?.[0]?.splits ?? []) {
      const id = s?.team?.id;
      const st = s?.stat;
      if (!id || !st) continue;
      const pa = st.plateAppearances ?? 0;
      if (pa < 100) continue;
      const h = st.hits ?? 0;
      const d2 = st.doubles ?? 0;
      const d3 = st.triples ?? 0;
      const hr = st.homeRuns ?? 0;
      init(id).batting = {
        pa,
        bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / pa,
        so: (st.strikeOuts ?? 0) / pa,
        b1: (h - d2 - d3 - hr) / pa,
        b2: d2 / pa,
        b3: d3 / pa,
        hr: hr / pa,
      };
    }
  }
  if (pitRes.ok) {
    const j: any = await pitRes.json();
    for (const s of j?.stats?.[0]?.splits ?? []) {
      const id = s?.team?.id;
      const st = s?.stat;
      if (!id || !st) continue;
      const bf = st.battersFaced ?? 0;
      if (bf < 100) continue;
      const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
      // League single/double/triple shape is applied later via leagueRates.
      init(id).staff = {
        so: (st.strikeOuts ?? 0) / bf,
        bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / bf,
        hr: (st.homeRuns ?? 0) / bf,
        b1: hNonHr / bf, // temporarily holds total non-HR hit rate; reshaped below
        b2: 0,
        b3: 0,
      };
    }
  }
  return map;
}

/** PA-weighted league batting rates (= league pitching-allowed rates). */
export function leagueRates(teams: Map<number, TeamRates>): BattingRates {
  let pa = 0;
  const tot = { bb: 0, so: 0, b1: 0, b2: 0, b3: 0, hr: 0 };
  for (const t of teams.values()) {
    if (!t.batting) continue;
    pa += t.batting.pa;
    tot.bb += t.batting.bb * t.batting.pa;
    tot.so += t.batting.so * t.batting.pa;
    tot.b1 += t.batting.b1 * t.batting.pa;
    tot.b2 += t.batting.b2 * t.batting.pa;
    tot.b3 += t.batting.b3 * t.batting.pa;
    tot.hr += t.batting.hr * t.batting.pa;
  }
  if (pa === 0) {
    // 2026 league averages as a last-resort fallback
    return { pa: 1, bb: 0.089, so: 0.222, b1: 0.14, b2: 0.043, b3: 0.004, hr: 0.031 };
  }
  return {
    pa,
    bb: tot.bb / pa,
    so: tot.so / pa,
    b1: tot.b1 / pa,
    b2: tot.b2 / pa,
    b3: tot.b3 / pa,
    hr: tot.hr / pa,
  };
}

/** Reshape a staff line's non-HR hits into 1B/2B/3B using league shape. */
export function reshapeStaff(staff: PitchingLine | null, lg: BattingRates): PitchingLine | null {
  if (!staff) return null;
  const lgHits = lg.b1 + lg.b2 + lg.b3;
  const hRate = staff.b1; // total non-HR hit rate stored by fetchAllTeamRates
  return {
    so: staff.so,
    bb: staff.bb,
    hr: staff.hr,
    b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
    b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
    b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
  };
}

/** Starter season counting stats → regressed per-BF line + expected outs. */
export async function fetchStarterInfo(
  personId: number,
  season: number,
  lg: BattingRates,
): Promise<StarterInfo | null> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json: any = await res.json();
    const st = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!st) return null;
    const bf = st.battersFaced ?? 0;
    const PRIOR_BF = 70; // regress small samples toward league average
    const reg = (count: number, lgRate: number) => (count + lgRate * PRIOR_BF) / (bf + PRIOR_BF);
    const lgHits = lg.b1 + lg.b2 + lg.b3;
    const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
    const hRate = reg(hNonHr, lgHits);
    const line: PitchingLine = {
      so: reg(st.strikeOuts ?? 0, lg.so),
      bb: reg((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0), lg.bb),
      hr: reg(st.homeRuns ?? 0, lg.hr),
      b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
      b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
      b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
    };
    const starts = st.gamesStarted ?? 0;
    const ipStr: string = st.inningsPitched ?? "0.0";
    const parts = ipStr.split(".");
    const outs = (parseInt(parts[0], 10) || 0) * 3 + (parts[1] ? parseInt(parts[1], 10) : 0);
    const expectedOuts =
      starts > 0 ? Math.min(21, Math.max(9, (outs + 15.5 * 3) / (starts + 3))) : 15.5;
    return { line, expectedOuts };
  } catch {
    return null;
  }
}

// ─── The simulation engine ────────────────────────────────────────────────────

type Cum = number[]; // cumulative thresholds over EVENTS order
const EVENTS = ["bb", "hr", "b1", "b2", "b3", "so", "out"] as const;

/** Batting-team event probs vs a pitching line, odds-multiplied vs league. */
function paProbs(
  bat: BattingRates,
  pit: PitchingLine | null,
  lg: BattingRates,
  parkMult: number,
  homeBoost: number,
): Cum {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const p: Record<string, number> = {};
  for (const ev of ["bb", "hr", "b1", "b2", "b3", "so"] as const) {
    const lgRate = lg[ev];
    const mult = pit && lgRate > 0 ? clamp(pit[ev] / lgRate, 0.5, 2.0) : 1.0;
    let v = bat[ev] * mult;
    if (ev === "b1" || ev === "b2" || ev === "b3") v *= parkMult;
    if (ev === "hr") v *= Math.pow(parkMult, 1.5);
    if (ev !== "so") v *= homeBoost * OFFENSE_CAL;
    p[ev] = v;
  }
  let s = p.bb + p.hr + p.b1 + p.b2 + p.b3 + p.so;
  if (s > 0.95) {
    for (const ev of ["bb", "hr", "b1", "b2", "b3", "so"]) p[ev] *= 0.95 / s;
    s = 0.95;
  }
  p.out = 1 - s;
  const cum: number[] = [];
  let acc = 0;
  for (const ev of EVENTS) {
    acc += p[ev];
    cum.push(acc);
  }
  return cum;
}

function pickEvent(cum: Cum, rnd: () => number): (typeof EVENTS)[number] {
  const x = rnd();
  for (let i = 0; i < cum.length; i++) {
    if (x < cum[i]) return EVENTS[i];
  }
  return "out";
}

/** Mutable starter state threaded across half-innings: [outsLeft, battersFaced, runsAllowed]. */
type StarterState = [number, number, number];

function simHalf(
  cumVsStarter: Cum,
  cumVsStarterTto: Cum,
  cumVsBullpen: Cum,
  sp: StarterState,
  rnd: () => number,
  ghost: boolean,
  walkoffTarget: number | null,
): number {
  let outs = 0;
  let runs = 0;
  let b1 = false;
  let b2 = ghost; // extra-innings ghost runner starts on 2nd
  let b3 = false;
  while (outs < 3) {
    const spIn = sp[0] > 0 && sp[2] < HOOK_RUNS;
    let cum: Cum;
    if (spIn) {
      cum = sp[1] >= TTO_BF ? cumVsStarterTto : cumVsStarter;
      sp[1]++;
    } else {
      cum = cumVsBullpen;
    }
    const ev = pickEvent(cum, rnd);
    if (ev === "so" || ev === "out") {
      outs++;
      if (spIn) sp[0]--;
      if (ev === "out" && outs < 3) {
        const r = rnd();
        if (b1 && r < 0.09) {
          outs++; // double play
          if (spIn) sp[0]--;
          b1 = false;
        } else if (r < 0.4) {
          if (b3) {
            runs++;
            if (spIn) sp[2]++;
            b3 = false;
          } // productive out
          if (b2) {
            b3 = true;
            b2 = false;
          }
          if (b1) {
            b2 = true;
            b1 = false;
          }
        }
      }
    } else {
      let scored = 0;
      if (ev === "bb") {
        if (b1 && b2 && b3) scored++;
        else if (b1 && b2) b3 = true;
        else if (b1) b2 = true;
        b1 = true;
      } else if (ev === "b1") {
        if (b3) {
          scored++;
          b3 = false;
        }
        if (b2) {
          if (rnd() < 0.6) scored++;
          else b3 = true;
          b2 = false;
        }
        if (b1) {
          if (rnd() < 0.25 && !b3) b3 = true;
          else b2 = true;
          b1 = false;
        }
        b1 = true;
      } else if (ev === "b2") {
        if (b3) {
          scored++;
          b3 = false;
        }
        if (b2) {
          scored++;
          b2 = false;
        }
        if (b1) {
          if (rnd() < 0.4) scored++;
          else b3 = true;
          b1 = false;
        }
        b2 = true;
      } else if (ev === "b3") {
        scored += (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
        b1 = b2 = false;
        b3 = true;
      } else if (ev === "hr") {
        scored += 1 + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
        b1 = b2 = b3 = false;
      }
      runs += scored;
      if (spIn) sp[2] += scored;
    }
    if (walkoffTarget !== null && runs > walkoffTarget) {
      return runs;
    }
  }
  return runs;
}

/**
 * A tiered bullpen: three per-BF lines deployed by game state instead of one
 * blended pen line. `closer` covers the 9th+ of close games (save/tie), `setup`
 * the 7th–8th of close games, `middle` everything else (early relief, blowouts).
 * When a matchup carries these (sim-recent-v2), the sim picks the tier by inning
 * and score; when it doesn't, the sim uses the single `homeStaff`/`awayStaff`
 * line exactly as before (sim-elo-v2 / sim-recent-v1 are unaffected).
 */
export interface BullpenTiers {
  closer: PitchingLine;
  setup: PitchingLine;
  middle: PitchingLine;
}

export interface MatchupInputs {
  homeBatting: BattingRates;
  awayBatting: BattingRates;
  homeStarter: StarterInfo | null;
  awayStarter: StarterInfo | null;
  homeStaff: PitchingLine | null; // single-line bullpen proxy (fallback / non-tiered)
  awayStaff: PitchingLine | null;
  homePenTiers?: BullpenTiers | null; // optional leverage-tiered pen (sim-recent-v2)
  awayPenTiers?: BullpenTiers | null;
  league: BattingRates;
  venue: string | null;
}

/**
 * Which bullpen tier a team deploys, from the pitching team's lead at the start
 * of the half-inning. Closer in the 9th+ protecting a lead of 1–3 (or a tie);
 * setup in the 7th–8th (and the trailing-close 9th) of one-score games; middle
 * otherwise. This is the "explicit closer + role tiers" deployment.
 */
function selectTier(inning: number, lead: number): keyof BullpenTiers {
  if (inning >= 9) {
    if (lead >= 0 && lead <= 3) return "closer";
    if (lead >= -3) return "setup";
    return "middle";
  }
  if (inning >= 7) return Math.abs(lead) <= 3 ? "setup" : "middle";
  return "middle";
}

/** Simulate one game; returns 1 if home wins. Gaussian via Box-Muller. */
function gauss(rnd: () => number): number {
  const u = Math.max(1e-12, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function simulateMatchup(m: MatchupInputs, nSims = 3000, seed = 12345): number {
  const rnd = mulberry32(seed);
  const parkMult = Math.sqrt(parkFactor(m.venue) / 100);
  const lg = m.league;
  const homeVsSp = paProbs(m.homeBatting, m.awayStarter?.line ?? null, lg, parkMult, HOME_BOOST);
  const homeVsSpTto = paProbs(
    m.homeBatting,
    m.awayStarter?.line ?? null,
    lg,
    parkMult,
    HOME_BOOST * TTO_MULT,
  );
  const homeVsBp = paProbs(m.homeBatting, m.awayStaff, lg, parkMult, HOME_BOOST);
  const awayVsSp = paProbs(m.awayBatting, m.homeStarter?.line ?? null, lg, parkMult, 1.0);
  const awayVsSpTto = paProbs(m.awayBatting, m.homeStarter?.line ?? null, lg, parkMult, TTO_MULT);
  const awayVsBp = paProbs(m.awayBatting, m.homeStaff, lg, parkMult, 1.0);
  const hExpOuts = m.homeStarter?.expectedOuts ?? 15.5;
  const aExpOuts = m.awayStarter?.expectedOuts ?? 15.5;

  // Optional leverage tiers → batting-vs-each-tier cums. When absent, the pen
  // selectors below just return the single-line cum, so the non-tiered path is
  // byte-identical to before (same cum arrays, same RNG draw sequence).
  const tierCums = (batting: BattingRates, boost: number, pen: BullpenTiers | null | undefined) =>
    pen
      ? {
          closer: paProbs(batting, pen.closer, lg, parkMult, boost),
          setup: paProbs(batting, pen.setup, lg, parkMult, boost),
          middle: paProbs(batting, pen.middle, lg, parkMult, boost),
        }
      : null;
  const awayVsHomePen = tierCums(m.awayBatting, 1.0, m.homePenTiers); // away batters vs home pen
  const homeVsAwayPen = tierCums(m.homeBatting, HOME_BOOST, m.awayPenTiers); // home batters vs away pen
  const homePenCum = (inning: number, lead: number): Cum =>
    awayVsHomePen ? awayVsHomePen[selectTier(inning, lead)] : awayVsBp;
  const awayPenCum = (inning: number, lead: number): Cum =>
    homeVsAwayPen ? homeVsAwayPen[selectTier(inning, lead)] : homeVsBp;

  let wins = 0;
  for (let s = 0; s < nSims; s++) {
    // [outsLeft, battersFaced, runsAllowed]
    const hSp: StarterState = [Math.max(3, Math.round(hExpOuts + gauss(rnd) * 4)), 0, 0];
    const aSp: StarterState = [Math.max(3, Math.round(aExpOuts + gauss(rnd) * 4)), 0, 0];
    let hs = 0;
    let as = 0;
    let inning = 1;
    for (;;) {
      const ghost = inning > 9;
      // Away batting (home team pitching): pick the home pen tier by home's lead.
      as += simHalf(awayVsSp, awayVsSpTto, homePenCum(inning, hs - as), hSp, rnd, ghost, null);
      if (inning >= 9 && hs > as) {
        wins++;
        break;
      }
      const target = inning >= 9 ? as - hs : null;
      // Home batting (away team pitching): pick the away pen tier by away's lead.
      hs += simHalf(homeVsSp, homeVsSpTto, awayPenCum(inning, as - hs), aSp, rnd, ghost, target);
      if (inning >= 9) {
        if (hs > as) {
          wins++;
          break;
        }
        if (as > hs) break;
      }
      inning++;
      if (inning > 30) {
        if (rnd() < 0.5) wins++;
        break;
      }
    }
  }
  return wins / nSims;
}

// ─── Full date pipeline ───────────────────────────────────────────────────────

const logitFn = (p: number) => Math.log(p / (1 - p));
const sigmoidFn = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Simulate every game on `date`. One schedule call, one season-results call
 * (for Elo), two team-stats calls, then one call per probable starter.
 */
export async function buildSimPredictionsForDate(
  date: string,
  nSims = 3000,
): Promise<SimGamePrediction[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue&startDate=${date}&endDate=${date}`;
  const [scheduleRes, prev2Results, prev1Results, seasonResults, teamRates] = await Promise.all([
    fetchWithTimeout(scheduleUrl),
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
    fetchSeasonResults(season, date),
    fetchAllTeamRates(season),
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];

  const elo = computeElo([prev2Results, prev1Results, seasonResults]);
  const lg = leagueRates(teamRates);

  const pitcherIds = new Set<number>();
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }
  const starters = new Map<number, StarterInfo | null>();
  await batchedAll(
    Array.from(pitcherIds).map((id) => async () => {
      starters.set(id, await fetchStarterInfo(id, season, lg));
    }),
    8,
  );

  return games.map((g: any): SimGamePrediction => {
    const homeTeam = g.teams.home.team;
    const awayTeam = g.teams.away.team;
    const rates = (id: number): TeamRates => teamRates.get(id) ?? { batting: null, staff: null };
    const hRates = rates(homeTeam.id);
    const aRates = rates(awayTeam.id);
    const hp = g.teams.home.probablePitcher?.id;
    const ap = g.teams.away.probablePitcher?.id;
    const venue: string | null = g.venue?.name ?? null;

    const simProb = simulateMatchup(
      {
        homeBatting: hRates.batting ?? lg,
        awayBatting: aRates.batting ?? lg,
        homeStarter: (hp && starters.get(hp)) || null,
        awayStarter: (ap && starters.get(ap)) || null,
        homeStaff: reshapeStaff(hRates.staff, lg),
        awayStaff: reshapeStaff(aRates.staff, lg),
        league: lg,
        venue,
      },
      nSims,
      1000 + g.gamePk, // per-game deterministic seed
    );

    const homeElo = elo.get(homeTeam.id) ?? 1500;
    const awayElo = elo.get(awayTeam.id) ?? 1500;
    const eloProb = eloWinProb(homeElo, awayElo);
    const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
    const ensembleProb = sigmoidFn((logitFn(clamp01(simProb)) + logitFn(clamp01(eloProb))) / 2);

    return {
      gameId: g.gamePk,
      date: g.gameDate,
      venue: venue ?? "—",
      homeId: homeTeam.id,
      awayId: awayTeam.id,
      homeName: homeTeam.name,
      awayName: awayTeam.name,
      simProb,
      eloProb,
      ensembleProb,
      homeElo,
      awayElo,
      nSims,
      rationale: [
        `Monte Carlo (${nSims} sims): home wins ${(simProb * 100).toFixed(1)}%`,
        `Elo ${homeElo.toFixed(0)} vs ${awayElo.toFixed(0)} (+${ELO_HOME} home) → ${(eloProb * 100).toFixed(1)}%`,
        `Ensemble (logit mean) → ${(ensembleProb * 100).toFixed(1)}%`,
      ],
    };
  });
}
