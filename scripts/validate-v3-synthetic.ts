#!/usr/bin/env bun
/**
 * Synthetic-league ground-truth validation of Algorithm V2 (sim-elo-v3).
 *
 *   bun scripts/validate-v3-synthetic.ts [--seeds N] [--out results.json]
 *
 * Real-data backtests can say *whether* a change helped; they can never say
 * whether the machinery is computing what it claims, because true talent is
 * unobservable. This script builds a league where truth is known:
 *
 *   1. Invent 20 teams with known per-event batting/pitching talent, assign
 *      parks (some extreme), and play an UNBALANCED first half (division-
 *      heavy, like MLB) with a PA-level generator that composes matchup
 *      probabilities the same multiplicative way the simulator does.
 *   2. Hand the models only what they'd see in real life: observed season
 *      aggregates, the game list, and the schedule. No talent, no labels.
 *   3. Score on a held-out slate against (a) the generator's true win
 *      probability per matchup and (b) sampled outcomes.
 *
 * What is validated:
 *   · SOS deconvolution recovers true talent (rate MAE shrinks vs raw).
 *   · sim-elo-v3 (SOS on, context off) beats the sim-elo-v2 configuration on
 *     a schedule with real imbalance — because the generator has no fatigue
 *     or momentum effects, context stays OFF here; enabling it would only
 *     add noise the generator cannot reward.
 *   · A balanced league in neutral parks leaves every multiplier at exactly
 *     1 and reproduces sim-elo-v2 bit-for-bit (the no-regression property).
 *
 * Read-only, no network, fully deterministic per seed.
 */

import {
  computeElo,
  eloWinProb,
  simulateMatchup,
  type BattingRates,
  type PitchingLine,
  type SeasonGameResult,
} from "../src/lib/mlb-sim";
import { PARK_FACTORS } from "../src/lib/park-factors";
import {
  computeAllTeamSos,
  adjustBattingRates,
  adjustPitchingLine,
  combineMultipliers,
  DEFAULT_SOS_TUNING,
  type SeasonGame,
  type SosTuning,
  type TeamLines,
} from "../src/lib/mlb-sos";
import { predictV3Game, V3_AS_V2_CONFIG, type V3Config, type V3Env } from "../src/lib/mlb-v3";

// ─── Deterministic RNG (same construction as the simulator) ──────────────────

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

const gauss = (rnd: () => number) => {
  const u = Math.max(1e-12, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ─── League construction ──────────────────────────────────────────────────────

// League anchor ≈ 2026 MLB.
const LG: BattingRates = {
  pa: 1,
  bb: 0.089,
  so: 0.222,
  b1: 0.14,
  b2: 0.043,
  b3: 0.004,
  hr: 0.031,
};
const EVENTS = ["bb", "so", "b1", "b2", "b3", "hr"] as const;
type Ev = (typeof EVENTS)[number];

// Realistic between-team talent spread (SD of the multiplicative factor).
const TALENT_SD: Record<Ev, number> = {
  bb: 0.08,
  so: 0.08,
  b1: 0.05,
  b2: 0.08,
  b3: 0.2,
  hr: 0.14,
};

interface TrueTeam {
  id: number;
  division: number;
  venue: string; // key into PARK_FACTORS (drives both generator and model)
  bat: Record<Ev, number>;
  pit: Record<Ev, number>; // rates allowed vs a league-average lineup
}

// A spread of real park names so both generator and model use the public table.
const PARK_POOL = [
  "Coors Field", // 112
  "Fenway Park", // 106
  "Great American Ball Park", // 105
  "Globe Life Field", // 104
  "Yankee Stadium", // 103
  "Wrigley Field", // 102
  "Chase Field", // 102
  "Truist Park", // 101
  "Kauffman Stadium", // 101
  "Nationals Park", // 100
  "Target Field", // 100
  "Minute Maid Park", // 100
  "American Family Field", // 100
  "Citi Field", // 99
  "Progressive Field", // 99
  "Comerica Park", // 98
  "Angel Stadium", // 98
  "Busch Stadium", // 97
  "Oracle Park", // 95
  "Petco Park", // 95
];

function makeLeague(rnd: () => number, neutral = false): TrueTeam[] {
  const teams: TrueTeam[] = [];
  for (let i = 0; i < 20; i++) {
    const bat = {} as Record<Ev, number>;
    const pit = {} as Record<Ev, number>;
    for (const ev of EVENTS) {
      const bz = neutral ? 0 : gauss(rnd) * TALENT_SD[ev];
      const pz = neutral ? 0 : gauss(rnd) * TALENT_SD[ev];
      // Good hitters draw more walks / strike out less; good pitchers reverse.
      bat[ev] = LG[ev] * Math.exp(ev === "so" ? -Math.abs(0) + bz * -1 : bz);
      pit[ev] = LG[ev] * Math.exp(ev === "so" ? pz : pz);
    }
    teams.push({
      id: 100 + i,
      division: Math.floor(i / 5),
      venue: neutral ? "Nationals Park" : PARK_POOL[i % PARK_POOL.length],
      bat,
      pit,
    });
  }
  return teams;
}

// ─── The generator (PA-level, mirrors the sim's multiplicative composition) ──

const OFFENSE_CAL = 1.032; // same constants the engine calibrates with
const HOME_BOOST = 1.028;

function matchupProbs(
  bat: Record<Ev, number>,
  pit: Record<Ev, number>,
  venue: string,
  home: boolean,
): number[] {
  const rel = (PARK_FACTORS[venue] ?? 100) / 100;
  const parkHit = Math.sqrt(rel);
  const parkHr = Math.pow(rel, 0.75);
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const p: Record<Ev, number> = {} as Record<Ev, number>;
  for (const ev of EVENTS) {
    const mult = clamp(pit[ev] / LG[ev], 0.5, 2.0);
    let v = bat[ev] * mult;
    if (ev === "b1" || ev === "b2" || ev === "b3") v *= parkHit;
    if (ev === "hr") v *= parkHr;
    if (ev !== "so") v *= (home ? HOME_BOOST : 1) * OFFENSE_CAL;
    p[ev] = v;
  }
  let s = EVENTS.reduce((a, ev) => a + p[ev], 0);
  if (s > 0.95) {
    for (const ev of EVENTS) p[ev] *= 0.95 / s;
    s = 0.95;
  }
  // order: bb, so, b1, b2, b3, hr, out
  return [p.bb, p.so, p.b1, p.b2, p.b3, p.hr, 1 - s];
}

interface Tally {
  pa: number;
  ev: Record<Ev, number>;
  bf: number;
  allowed: Record<Ev, number>;
}

function newTally(): Tally {
  const z = () => ({ bb: 0, so: 0, b1: 0, b2: 0, b3: 0, hr: 0 });
  return { pa: 0, ev: z(), bf: 0, allowed: z() };
}

/** Play one half-inning; returns runs. Simplified but plausible advancement. */
function genHalf(
  probs: number[],
  rnd: () => number,
  batTally: Tally | null,
  pitTally: Tally | null,
  ghost: boolean,
  walkoffTarget: number | null,
): number {
  let outs = 0;
  let runs = 0;
  let b1 = false;
  let b2 = ghost;
  let b3 = false;
  const record = (ev: Ev | null) => {
    if (batTally) {
      batTally.pa++;
      if (ev) batTally.ev[ev]++;
    }
    if (pitTally) {
      pitTally.bf++;
      if (ev) pitTally.allowed[ev]++;
    }
  };
  while (outs < 3) {
    const x = rnd();
    let idx = 0;
    let acc = 0;
    for (; idx < probs.length; idx++) {
      acc += probs[idx];
      if (x < acc) break;
    }
    const ev = (["bb", "so", "b1", "b2", "b3", "hr", "out"] as const)[Math.min(idx, 6)];
    if (ev === "so" || ev === "out") {
      record(ev === "so" ? "so" : null);
      outs++;
      if (ev === "out" && outs < 3 && rnd() < 0.35) {
        if (b3) {
          runs++;
          b3 = false;
        }
        if (b2) {
          b3 = true;
          b2 = false;
        }
        if (b1) {
          b2 = true;
          b1 = false;
        }
      }
    } else {
      record(ev);
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
          b2 = true;
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
    }
    if (walkoffTarget !== null && runs > walkoffTarget) return runs;
  }
  return runs;
}

interface GenResult {
  homeScore: number;
  awayScore: number;
  innings: number;
}

function genGame(
  home: TrueTeam,
  away: TrueTeam,
  rnd: () => number,
  tallies: Map<number, Tally> | null,
): GenResult {
  const homeP = matchupProbs(home.bat, away.pit, home.venue, true);
  const awayP = matchupProbs(away.bat, home.pit, home.venue, false);
  const hT = tallies?.get(home.id) ?? null;
  const aT = tallies?.get(away.id) ?? null;
  let hs = 0;
  let as = 0;
  let inning = 1;
  for (;;) {
    const ghost = inning > 9;
    as += genHalf(awayP, rnd, aT, hT, ghost, null);
    if (inning >= 9 && hs > as) break;
    const target = inning >= 9 ? as - hs : null;
    hs += genHalf(homeP, rnd, hT, aT, ghost, target);
    if (inning >= 9 && hs !== as) break;
    inning++;
    if (inning > 25) {
      hs = as + (rnd() < 0.5 ? 1 : -1); // pathological guard
      break;
    }
  }
  return { homeScore: hs, awayScore: as, innings: Math.max(9, inning) };
}

// ─── Schedule builders ────────────────────────────────────────────────────────

interface Pairing {
  home: TrueTeam;
  away: TrueTeam;
}

/** Division-heavy, like MLB: ~55% of games inside the 5-team division. */
function unbalancedSchedule(teams: TrueTeam[], gamesPerTeam: number, rnd: () => number): Pairing[] {
  const pairings: Pairing[] = [];
  const target = teams.length * gamesPerTeam;
  const count = new Map<number, number>(teams.map((t) => [t.id, 0]));
  let guard = 0;
  while (pairings.length * 2 < target && guard++ < 1_000_000) {
    const a = teams[Math.floor(rnd() * teams.length)];
    const sameDiv = rnd() < 0.55;
    const pool = teams.filter(
      (t) => t.id !== a.id && (sameDiv ? t.division === a.division : t.division !== a.division),
    );
    const b = pool[Math.floor(rnd() * pool.length)];
    if ((count.get(a.id) ?? 0) >= gamesPerTeam || (count.get(b.id) ?? 0) >= gamesPerTeam) continue;
    const homeFirst = rnd() < 0.5;
    pairings.push(homeFirst ? { home: a, away: b } : { home: b, away: a });
    count.set(a.id, (count.get(a.id) ?? 0) + 1);
    count.set(b.id, (count.get(b.id) ?? 0) + 1);
  }
  return pairings;
}

function toDate(dayIdx: number): string {
  const d = new Date(Date.UTC(2026, 3, 1 + dayIdx)); // Apr 1 + n
  return d.toISOString().slice(0, 10);
}

// ─── Model-side helpers ───────────────────────────────────────────────────────

function talliesToLines(tallies: Map<number, Tally>): Map<number, TeamLines> {
  const out = new Map<number, TeamLines>();
  for (const [id, t] of tallies) {
    const bat: BattingRates | null =
      t.pa >= 100
        ? {
            pa: t.pa,
            bb: t.ev.bb / t.pa,
            so: t.ev.so / t.pa,
            b1: t.ev.b1 / t.pa,
            b2: t.ev.b2 / t.pa,
            b3: t.ev.b3 / t.pa,
            hr: t.ev.hr / t.pa,
          }
        : null;
    const staff: PitchingLine | null =
      t.bf >= 100
        ? {
            so: t.allowed.so / t.bf,
            bb: t.allowed.bb / t.bf,
            hr: t.allowed.hr / t.bf,
            b1: t.allowed.b1 / t.bf,
            b2: t.allowed.b2 / t.bf,
            b3: t.allowed.b3 / t.bf,
          }
        : null;
    out.set(id, { batting: bat, staff });
  }
  return out;
}

function leagueFromLines(lines: Map<number, TeamLines>): BattingRates {
  let pa = 0;
  const tot: Record<Ev, number> = { bb: 0, so: 0, b1: 0, b2: 0, b3: 0, hr: 0 };
  for (const l of lines.values()) {
    if (!l.batting) continue;
    pa += l.batting.pa;
    for (const ev of EVENTS) tot[ev] += l.batting[ev] * l.batting.pa;
  }
  const out = { pa } as BattingRates;
  for (const ev of EVENTS) (out as unknown as Record<string, number>)[ev] = tot[ev] / pa;
  return out;
}

const sosOnly = (tuning: SosTuning): V3Config => ({
  sos: {
    adjustBatting: true,
    adjustPitching: true,
    adjustParks: true,
    starterLevel: false,
    tuning,
  },
  context: V3_AS_V2_CONFIG.context,
  calScale: 1.0,
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Cross-sectional talent recovery. The generator bakes OFFENSE_CAL and the
 * home boost into every observed rate as a league-wide constant, which no
 * schedule adjustment should (or could) remove — so each estimate set is
 * mean-normalized per event before the MAE, leaving only the between-team
 * error that actually matters for predictions.
 */
function rateMae(
  teams: TrueTeam[],
  adjusted: (id: number) => { bat: Record<Ev, number> | null; pit: Record<Ev, number> | null },
): { batMae: number; pitMae: number } {
  const collect = (side: "bat" | "pit") => {
    const errs: number[] = [];
    for (const ev of EVENTS) {
      const rows: Array<{ est: number; truth: number }> = [];
      for (const t of teams) {
        const a = adjusted(t.id)[side];
        if (a) rows.push({ est: a[ev], truth: side === "bat" ? t.bat[ev] : t.pit[ev] });
      }
      if (rows.length === 0) continue;
      const norm = mean(rows.map((r) => r.truth)) / mean(rows.map((r) => r.est));
      for (const r of rows) errs.push(Math.abs(r.est * norm - r.truth) / LG[ev]);
    }
    return mean(errs);
  };
  return { batMae: collect("bat"), pitMae: collect("pit") };
}

// ─── One full experiment ──────────────────────────────────────────────────────

export interface ConfigSpec {
  name: string;
  tuning: SosTuning | null; // null = the sim-elo-v2 configuration (raw rates)
}

interface ConfigResult {
  name: string;
  rateMaeBat: number;
  rateMaePit: number;
  rmseTrueSim: number; // sim component only — the SOS signal undiluted by Elo
  rmseTrueEns: number; // full ensemble
  brier: number;
  acc: number;
}

interface SeedResult {
  seed: number;
  nHoldout: number;
  brierTrueFloor: number;
  configs: ConfigResult[];
}

function runSeed(
  seed: number,
  holdoutGames: number,
  specs: ConfigSpec[],
  log: (s: string) => void,
): SeedResult {
  const rnd = mulberry32(seed);
  const teams = makeLeague(rnd);
  const byId = new Map(teams.map((t) => [t.id, t]));

  // 1. Play the unbalanced first half and accumulate observed aggregates.
  const pairings = unbalancedSchedule(teams, 60, rnd);
  const tallies = new Map<number, Tally>(teams.map((t) => [t.id, newTally()]));
  const seasonGames: SeasonGame[] = [];
  pairings.forEach((p, i) => {
    const r = genGame(p.home, p.away, rnd, tallies);
    if (r.homeScore === r.awayScore) return;
    seasonGames.push({
      date: toDate(Math.floor(i / 10)),
      home: p.home.id,
      away: p.away.id,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      venue: p.home.venue,
      innings: r.innings,
    });
  });
  const asOf = toDate(Math.floor(pairings.length / 10) + 1);

  // 2. What the model is allowed to see.
  const lines = talliesToLines(tallies);
  const lg = leagueFromLines(lines);
  const elo = computeElo([seasonGames as SeasonGameResult[]]);

  // 3. Held-out slate with generator truth, computed ONCE and reused by
  //    every configuration.
  const holdout = unbalancedSchedule(
    teams,
    Math.ceil((holdoutGames * 2) / teams.length),
    rnd,
  ).slice(0, holdoutGames);
  const truths = holdout.map((p, i) => {
    const truthRnd = mulberry32(seed * 7919 + i * 13);
    let wins = 0;
    const N = 2000;
    for (let k = 0; k < N; k++) {
      const r = genGame(p.home, p.away, truthRnd, null);
      if (r.homeScore > r.awayScore) wins++;
    }
    const outcome = genGame(p.home, p.away, truthRnd, null);
    if ((i + 1) % 200 === 0) log(`    truth ${i + 1}/${holdout.length}`);
    return { pTrue: wins / N, y: outcome.homeScore > outcome.awayScore ? 1 : 0 };
  });

  // 4. Evaluate each configuration on identical inputs.
  const mkEnv = (config: V3Config): V3Env => ({
    seasonGames,
    teamLines: lines,
    league: lg,
    elo,
    starterInfo: new Map(),
    starterLogs: new Map(),
    homeVenueOf: (id) => byId.get(id)?.venue ?? null,
    nSims: 3000,
    config,
  });

  const configs: ConfigResult[] = specs.map((spec) => {
    const cfg = spec.tuning ? sosOnly(spec.tuning) : V3_AS_V2_CONFIG;
    const env = mkEnv(cfg);

    // Talent recovery for this tuning (v2 = raw lines).
    const sos = spec.tuning ? computeAllTeamSos(seasonGames, lines, lg, asOf, spec.tuning) : null;
    const mae = rateMae(teams, (id) => {
      const l = lines.get(id);
      if (!l) return { bat: null, pit: null };
      if (!sos) return { bat: l.batting as Record<Ev, number> | null, pit: l.staff };
      const s = sos.get(id);
      if (!s) return { bat: l.batting as Record<Ev, number> | null, pit: l.staff };
      return {
        bat: l.batting
          ? (adjustBattingRates(l.batting, combineMultipliers(s.oppPitching, s.park)) as Record<
              Ev,
              number
            >)
          : null,
        pit: l.staff ? adjustPitchingLine(l.staff, combineMultipliers(s.oppBatting, s.park)) : null,
      };
    });

    const sqSim: number[] = [];
    const sqEns: number[] = [];
    const brier: number[] = [];
    let hits = 0;
    holdout.forEach((p, i) => {
      const pred = predictV3Game(
        {
          gameId: 900000 + i,
          date: asOf,
          gameDate: asOf,
          venue: p.home.venue,
          homeId: p.home.id,
          awayId: p.away.id,
          homeName: `T${p.home.id}`,
          awayName: `T${p.away.id}`,
          homePitcherId: null,
          awayPitcherId: null,
        },
        env,
      );
      const { pTrue, y } = truths[i];
      sqSim.push((pred.simProb - pTrue) ** 2);
      sqEns.push((pred.finalProb - pTrue) ** 2);
      brier.push((pred.finalProb - y) ** 2);
      if ((pred.finalProb >= 0.5 ? 1 : 0) === y) hits++;
    });

    return {
      name: spec.name,
      rateMaeBat: mae.batMae,
      rateMaePit: mae.pitMae,
      rmseTrueSim: Math.sqrt(mean(sqSim)),
      rmseTrueEns: Math.sqrt(mean(sqEns)),
      brier: mean(brier),
      acc: hits / holdout.length,
    };
  });

  return {
    seed,
    nHoldout: holdout.length,
    brierTrueFloor: mean(truths.map((t) => (t.pTrue - t.y) ** 2)),
    configs,
  };
}

// ─── Balanced-league invariance check ─────────────────────────────────────────

function invarianceCheck(): { maxMultDrift: number; probsEqual: boolean } {
  const rnd = mulberry32(4242);
  const teams = makeLeague(rnd, /* neutral */ true);
  // Perfectly balanced round-robin at one neutral park, league-average talent.
  const seasonGames: SeasonGame[] = [];
  let day = 0;
  for (const a of teams) {
    for (const b of teams) {
      if (a.id >= b.id) continue;
      const r = genGame(a, b, rnd, null);
      if (r.homeScore === r.awayScore) continue;
      seasonGames.push({
        date: toDate(day++ % 60),
        home: a.id,
        away: b.id,
        homeScore: r.homeScore,
        awayScore: r.awayScore,
        venue: "Nationals Park",
        innings: r.innings,
      });
    }
  }
  // Hand the model *identical league-average lines* for every team, so any
  // multiplier drift can only come from the SOS machinery itself.
  const lines = new Map<number, TeamLines>(
    teams.map((t) => [
      t.id,
      {
        batting: { pa: 5000, ...Object.fromEntries(EVENTS.map((e) => [e, LG[e]])) } as BattingRates,
        staff: Object.fromEntries(EVENTS.map((e) => [e, LG[e]])) as unknown as PitchingLine,
      },
    ]),
  );
  const sos = computeAllTeamSos(seasonGames, lines, LG, toDate(365));
  let maxDrift = 0;
  for (const s of sos.values()) {
    for (const m of [s.oppPitching, s.oppBatting, s.park]) {
      for (const ev of EVENTS) maxDrift = Math.max(maxDrift, Math.abs(m[ev] - 1));
    }
  }

  const elo = computeElo([seasonGames as SeasonGameResult[]]);
  const mkEnv = (config: V3Config): V3Env => ({
    seasonGames,
    teamLines: lines,
    league: LG,
    elo,
    starterInfo: new Map(),
    starterLogs: new Map(),
    homeVenueOf: () => "Nationals Park",
    nSims: 3000,
    config,
  });
  const game = {
    gameId: 424242,
    date: toDate(80),
    gameDate: toDate(80),
    venue: "Nationals Park",
    homeId: teams[0].id,
    awayId: teams[1].id,
    homeName: "A",
    awayName: "B",
    homePitcherId: null,
    awayPitcherId: null,
  };
  const pV2 = predictV3Game(game, mkEnv(V3_AS_V2_CONFIG));
  const pV3 = predictV3Game(game, mkEnv(sosOnly(DEFAULT_SOS_TUNING)));
  return {
    maxMultDrift: maxDrift,
    probsEqual: pV3.simProb === pV2.simProb && pV3.ensembleProb === pV2.ensembleProb,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const seedsIdx = args.indexOf("--seeds");
  const nSeeds = seedsIdx >= 0 ? parseInt(args[seedsIdx + 1], 10) : 3;
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const grid = args.includes("--grid");

  console.log("═══ Synthetic-league ground-truth validation of sim-elo-v3 ═══\n");

  console.log("Invariance check (balanced neutral league)…");
  const inv = invarianceCheck();
  console.log(
    `  max |multiplier − 1| = ${inv.maxMultDrift.toExponential(2)} (must be 0)  ·  ` +
      `SOS-on == v2 probs: ${inv.probsEqual ? "EXACT" : "MISMATCH ✗"}\n`,
  );

  const specs: ConfigSpec[] = [{ name: "v2 (raw rates)", tuning: null }];
  if (grid) {
    for (const contam of [false, true]) {
      for (const lambda of [0.25, 0.5, 0.75, 1.0]) {
        specs.push({
          name: `λ=${lambda.toFixed(2)} contam=${contam ? "on " : "off"} prior=15`,
          tuning: { priorGames: 15, lambda, contamCorrection: contam },
        });
      }
    }
    specs.push({
      name: "λ=0.75 contam=on  prior=30",
      tuning: { priorGames: 30, lambda: 0.75, contamCorrection: true },
    });
  } else {
    specs.push({
      name: `shipped (λ=${DEFAULT_SOS_TUNING.lambda}, contam=${DEFAULT_SOS_TUNING.contamCorrection ? "on" : "off"}, prior=${DEFAULT_SOS_TUNING.priorGames})`,
      tuning: DEFAULT_SOS_TUNING,
    });
  }

  const results: SeedResult[] = [];
  for (let s = 0; s < nSeeds; s++) {
    const seed = 20260712 + s * 1000;
    console.log(`Seed ${s + 1}/${nSeeds} (${seed}): unbalanced league, 60 games/team observed…`);
    const t0 = Date.now();
    const r = runSeed(seed, 400, specs, (m) => console.log(m));
    results.push(r);
    console.log(
      `  done in ${((Date.now() - t0) / 1000).toFixed(0)}s (Brier floor ${r.brierTrueFloor.toFixed(4)})`,
    );
  }

  // Aggregate per configuration across seeds.
  console.log(
    `\n═══ Aggregate over ${nSeeds} seed(s), ${results.reduce((a, r) => a + r.nHoldout, 0)} holdout games ═══`,
  );
  console.log(
    "config".padEnd(30) +
      "MAE bat".padStart(9) +
      "MAE pit".padStart(9) +
      "RMSEsim".padStart(9) +
      "RMSEens".padStart(9) +
      "Brier".padStart(9) +
      "acc".padStart(7),
  );
  const aggregates = specs.map((spec, ci) => {
    const rows = results.map((r) => r.configs[ci]);
    const a = {
      name: spec.name,
      rateMaeBat: mean(rows.map((x) => x.rateMaeBat)),
      rateMaePit: mean(rows.map((x) => x.rateMaePit)),
      rmseTrueSim: mean(rows.map((x) => x.rmseTrueSim)),
      rmseTrueEns: mean(rows.map((x) => x.rmseTrueEns)),
      brier: mean(rows.map((x) => x.brier)),
      acc: mean(rows.map((x) => x.acc)),
    };
    console.log(
      a.name.padEnd(30) +
        `${(a.rateMaeBat * 100).toFixed(2)}%`.padStart(9) +
        `${(a.rateMaePit * 100).toFixed(2)}%`.padStart(9) +
        a.rmseTrueSim.toFixed(4).padStart(9) +
        a.rmseTrueEns.toFixed(4).padStart(9) +
        a.brier.toFixed(4).padStart(9) +
        `${(a.acc * 100).toFixed(1)}%`.padStart(7),
    );
    return a;
  });
  console.log(
    `${"".padEnd(30)}${"".padStart(9)}${"".padStart(9)}${"".padStart(9)}${"".padStart(9)}` +
      `${mean(results.map((r) => r.brierTrueFloor))
        .toFixed(4)
        .padStart(9)}` +
      `  ← true-prob Brier floor`,
  );

  if (outPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      outPath,
      JSON.stringify(
        { ranAt: new Date().toISOString(), invariance: inv, aggregates, results },
        null,
        2,
      ),
    );
    console.log(`\nSaved to ${outPath}`);
  }
}

main().catch((err) => {
  console.error("💥 synthetic validation failed:", err);
  process.exit(1);
});
