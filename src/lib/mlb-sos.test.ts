// Unit tests for the strength-of-schedule engine. Run with `bun test`.

import { describe, expect, test } from "bun:test";
import {
  adjustBattingRates,
  adjustPitchingLine,
  combineMultipliers,
  computeAllTeamSos,
  computeStarterSos,
  computeTeamSos,
  parkEventMultipliers,
  regressMultiplier,
  SOS_MULT_MAX,
  SOS_MULT_MIN,
  SOS_PRIOR_GAMES,
  type SeasonGame,
  type SosTuning,
  type StarterLogEntry,
  type TeamLines,
} from "./mlb-sos";
import type { BattingRates, PitchingLine } from "./mlb-sim";

// Exact-value tests pin the estimation knobs explicitly so they keep meaning
// even when the shipped DEFAULT_SOS_TUNING is re-tuned.
const PLAIN: SosTuning = { priorGames: 15, lambda: 1.0, contamCorrection: false };

// 2026-ish league averages used across the tests.
const LG: BattingRates = {
  pa: 100_000,
  bb: 0.089,
  so: 0.222,
  b1: 0.14,
  b2: 0.043,
  b3: 0.004,
  hr: 0.031,
};

const lgStaff = (): PitchingLine => ({
  so: LG.so,
  bb: LG.bb,
  hr: LG.hr,
  b1: LG.b1,
  b2: LG.b2,
  b3: LG.b3,
});

const scaledStaff = (k: Partial<Record<keyof PitchingLine, number>>): PitchingLine => {
  const s = lgStaff();
  for (const [ev, mult] of Object.entries(k)) {
    (s as Record<string, number>)[ev] = (s as Record<string, number>)[ev] * (mult as number);
  }
  return s;
};

const lgBatting = (): BattingRates => ({ ...LG, pa: 5000 });

function game(date: string, home: number, away: number, venue: string | null = null): SeasonGame {
  return { date, home, away, homeScore: 4, awayScore: 3, venue, innings: 9 };
}

describe("parkEventMultipliers", () => {
  test("neutral park is exactly 1 for every event", () => {
    const m = parkEventMultipliers("Nationals Park"); // pf 100
    expect(m).toEqual({ bb: 1, so: 1, hr: 1, b1: 1, b2: 1, b3: 1 });
  });

  test("unknown venue falls back to neutral", () => {
    expect(parkEventMultipliers("Field of Dreams")).toEqual(parkEventMultipliers(null));
    expect(parkEventMultipliers(null).hr).toBe(1);
  });

  test("Coors mirrors the simulator's park application (√pf on hits, pf^0.75 on HR)", () => {
    const m = parkEventMultipliers("Coors Field"); // pf 112
    expect(m.b1).toBeCloseTo(Math.sqrt(1.12), 12);
    expect(m.b2).toBeCloseTo(Math.sqrt(1.12), 12);
    expect(m.hr).toBeCloseTo(Math.pow(1.12, 0.75), 12);
    expect(m.bb).toBe(1);
    expect(m.so).toBe(1);
  });
});

describe("regressMultiplier", () => {
  test("prior halves the signal at PRIOR games", () => {
    expect(regressMultiplier(1.1, SOS_PRIOR_GAMES, PLAIN)).toBeCloseTo(1.05, 12);
  });
  test("zero games returns exactly 1", () => {
    expect(regressMultiplier(1.4, 0, PLAIN)).toBe(1);
  });
  test("clamps to the sane band", () => {
    expect(regressMultiplier(3.0, 100_000, PLAIN)).toBe(SOS_MULT_MAX);
    expect(regressMultiplier(0.1, 100_000, PLAIN)).toBe(SOS_MULT_MIN);
  });
});

describe("adjust helpers", () => {
  test("adjustBattingRates divides each event by its multiplier and keeps PA", () => {
    const bat = lgBatting();
    const mult = { bb: 1.1, so: 0.9, hr: 1.05, b1: 1, b2: 1, b3: 1 };
    const adj = adjustBattingRates(bat, mult);
    expect(adj.bb).toBeCloseTo(bat.bb / 1.1, 12);
    expect(adj.so).toBeCloseTo(bat.so / 0.9, 12);
    expect(adj.hr).toBeCloseTo(bat.hr / 1.05, 12);
    expect(adj.b1).toBe(bat.b1);
    expect(adj.pa).toBe(bat.pa);
  });

  test("adjustPitchingLine round-trips through combineMultipliers", () => {
    const line = scaledStaff({ so: 1.2, hr: 0.8 });
    const a = { bb: 1.02, so: 1.1, hr: 0.95, b1: 1, b2: 1, b3: 1 };
    const b = { bb: 1.01, so: 0.9, hr: 1.05, b1: 1.03, b2: 1, b3: 1 };
    const adj = adjustPitchingLine(line, combineMultipliers(a, b));
    expect(adj.so).toBeCloseTo(line.so / (1.1 * 0.9), 12);
    expect(adj.bb).toBeCloseTo(line.bb / (1.02 * 1.01), 12);
    expect(adj.b1).toBeCloseTo(line.b1 / 1.03, 12);
  });
});

describe("computeTeamSos", () => {
  test("facing one high-strikeout staff yields the exact regressed multiplier", () => {
    const K = 1.2; // opponent staff strikes out 20% more than league
    const G = 20;
    const games: SeasonGame[] = [];
    for (let i = 0; i < G; i++) {
      games.push(game(`2026-04-${String(i + 1).padStart(2, "0")}`, 1, 2, "Nationals Park"));
    }
    const lines = new Map<number, TeamLines>([
      [1, { batting: lgBatting(), staff: lgStaff() }],
      [2, { batting: lgBatting(), staff: scaledStaff({ so: K }) }],
    ]);
    const sos = computeTeamSos(1, games, lines, LG, "2026-06-01", PLAIN);
    const expected = (K * G + SOS_PRIOR_GAMES) / (G + SOS_PRIOR_GAMES);
    expect(sos.games).toBe(G);
    expect(sos.oppPitching.so).toBeCloseTo(expected, 12);
    expect(sos.oppPitching.bb).toBeCloseTo(1, 12); // opponent bb is league-avg
    expect(sos.oppBatting.b1).toBeCloseTo(1, 12); // opponent batting is league-avg
  });

  test("park multipliers average the venues actually played in", () => {
    const games = [
      game("2026-04-01", 1, 2, "Coors Field"), // pf 112
      game("2026-04-02", 1, 2, "Nationals Park"), // pf 100
    ];
    const lines = new Map<number, TeamLines>([
      [1, { batting: lgBatting(), staff: lgStaff() }],
      [2, { batting: lgBatting(), staff: lgStaff() }],
    ]);
    const sos = computeTeamSos(1, games, lines, LG, "2026-06-01", PLAIN);
    const rawMeanHr = (Math.pow(1.12, 0.75) + 1) / 2;
    expect(sos.park.hr).toBeCloseTo((rawMeanHr * 2 + SOS_PRIOR_GAMES) / (2 + SOS_PRIOR_GAMES), 12);
    expect(sos.park.so).toBe(1);
  });

  test("a balanced league-average schedule produces exactly neutral multipliers", () => {
    const games: SeasonGame[] = [];
    let day = 1;
    for (let opp = 2; opp <= 5; opp++) {
      for (let i = 0; i < 5; i++) {
        games.push(game(`2026-04-${String(day++).padStart(2, "0")}`, 1, opp, "Nationals Park"));
      }
    }
    const lines = new Map<number, TeamLines>();
    for (let id = 1; id <= 5; id++) lines.set(id, { batting: lgBatting(), staff: lgStaff() });
    const sos = computeTeamSos(1, games, lines, LG, "2026-06-01", PLAIN);
    for (const m of [sos.oppPitching, sos.oppBatting, sos.park]) {
      for (const v of Object.values(m)) expect(v).toBeCloseTo(1, 12);
    }
  });

  test("no lookahead: games on/after asOf are invisible", () => {
    const past = [game("2026-04-01", 1, 2), game("2026-04-02", 1, 2)];
    const future = [game("2026-06-01", 1, 3), game("2026-07-04", 1, 3)];
    const lines = new Map<number, TeamLines>([
      [1, { batting: lgBatting(), staff: lgStaff() }],
      [2, { batting: lgBatting(), staff: scaledStaff({ hr: 1.3 }) }],
      [3, { batting: lgBatting(), staff: scaledStaff({ hr: 0.4 }) }],
    ]);
    const a = computeTeamSos(1, past, lines, LG, "2026-06-01", PLAIN);
    const b = computeTeamSos(1, [...past, ...future], lines, LG, "2026-06-01", PLAIN);
    expect(b).toEqual(a);
  });

  test("computeAllTeamSos covers every team that played", () => {
    const games = [game("2026-04-01", 1, 2), game("2026-04-02", 3, 4)];
    const lines = new Map<number, TeamLines>();
    for (let id = 1; id <= 4; id++) lines.set(id, { batting: lgBatting(), staff: lgStaff() });
    const all = computeAllTeamSos(games, lines, LG, "2026-06-01");
    expect(Array.from(all.keys()).sort()).toEqual([1, 2, 3, 4]);
  });

  test("self-contamination debias: own deviation is removed with weight h", () => {
    // Team 1 hits 20% more HR than league and played ALL 10 games vs team 2,
    // so the schedule concentration is h = 1. Team 2's staff reads league-
    // average, but that reading includes the damage team 1 did to it — the
    // debias must subtract h·(1.2 − 1) before regressing:
    //   raw 1.0 → debiased 0.8 → regressed (0.8·10 + 15)/25 = 0.92
    const G = 10;
    const games: SeasonGame[] = [];
    for (let i = 0; i < G; i++) {
      games.push(game(`2026-04-${String(i + 1).padStart(2, "0")}`, 1, 2));
    }
    const lines = new Map<number, TeamLines>([
      [1, { batting: { ...lgBatting(), hr: LG.hr * 1.2 }, staff: lgStaff() }],
      [2, { batting: lgBatting(), staff: lgStaff() }],
    ]);
    const tuned: SosTuning = { priorGames: 15, lambda: 1.0, contamCorrection: true };
    const sos = computeTeamSos(1, games, lines, LG, "2026-06-01", tuned);
    expect(sos.oppPitching.hr).toBeCloseTo((0.8 * G + 15) / (G + 15), 12);
    // Events where team 1 is league-average stay exactly neutral.
    expect(sos.oppPitching.bb).toBeCloseTo(1, 12);
    // Without the correction the multiplier would have read a flat 1.
    const plain = computeTeamSos(1, games, lines, LG, "2026-06-01", PLAIN);
    expect(plain.oppPitching.hr).toBeCloseTo(1, 12);
  });

  test("lambda damps the multiplier toward 1", () => {
    const G = 30;
    const games: SeasonGame[] = [];
    for (let i = 0; i < G; i++) {
      games.push(game(`2026-04-${String((i % 28) + 1).padStart(2, "0")}`, 1, 2));
    }
    const lines = new Map<number, TeamLines>([
      [1, { batting: lgBatting(), staff: lgStaff() }],
      // Mild enough that neither the full nor damped value hits the clamp band.
      [2, { batting: lgBatting(), staff: scaledStaff({ so: 1.1 }) }],
    ]);
    const damped: SosTuning = { priorGames: 15, lambda: 0.5, contamCorrection: false };
    const full = computeTeamSos(1, games, lines, LG, "2026-06-01", PLAIN);
    const half = computeTeamSos(1, games, lines, LG, "2026-06-01", damped);
    expect(half.oppPitching.so).toBeCloseTo(Math.sqrt(full.oppPitching.so), 12);
    expect(half.oppPitching.so).toBeGreaterThan(1);
    expect(half.oppPitching.so).toBeLessThan(full.oppPitching.so);
  });

  test("missing opponent lines degrade to neutral, not NaN", () => {
    const games = [game("2026-04-01", 1, 99)];
    const lines = new Map<number, TeamLines>([[1, { batting: lgBatting(), staff: lgStaff() }]]);
    const sos = computeTeamSos(1, games, lines, LG, "2026-06-01", PLAIN);
    expect(sos.oppPitching.so).toBe(1);
    expect(Number.isFinite(sos.park.hr)).toBe(true);
  });
});

describe("computeStarterSos", () => {
  const homeVenueOf = (id: number) =>
    id === 1 ? "Nationals Park" : id === 2 ? "Coors Field" : id === 3 ? "Petco Park" : null;

  test("BF-weights the opposing batting schedules", () => {
    // 30 BF vs a hot-hitting team (HR ×1.5), 10 BF vs league-average.
    const log: StarterLogEntry[] = [
      { date: "2026-05-01", opponentTeamId: 2, isHome: true, battersFaced: 30 },
      { date: "2026-05-06", opponentTeamId: 3, isHome: true, battersFaced: 10 },
    ];
    const lines = new Map<number, TeamLines>([
      [2, { batting: { ...lgBatting(), hr: LG.hr * 1.5 }, staff: lgStaff() }],
      [3, { batting: lgBatting(), staff: lgStaff() }],
    ]);
    const s = computeStarterSos(log, 1, lines, LG, "2026-06-01", homeVenueOf, PLAIN);
    const rawMean = (1.5 * 30 + 1.0 * 10) / 40;
    const expected = (rawMean * 2 + SOS_PRIOR_GAMES) / (2 + SOS_PRIOR_GAMES);
    expect(s.starts).toBe(2);
    expect(s.oppBatting.hr).toBeCloseTo(expected, 12);
    expect(s.oppBatting.so).toBeCloseTo(1, 12);
  });

  test("locates away starts at the opponent's park", () => {
    const log: StarterLogEntry[] = [
      { date: "2026-05-01", opponentTeamId: 2, isHome: false, battersFaced: 25 }, // @ Coors
    ];
    const lines = new Map<number, TeamLines>([[2, { batting: lgBatting(), staff: lgStaff() }]]);
    const s = computeStarterSos(log, 1, lines, LG, "2026-06-01", homeVenueOf, PLAIN);
    const rawHr = Math.pow(1.12, 0.75);
    expect(s.park.hr).toBeCloseTo((rawHr * 1 + SOS_PRIOR_GAMES) / (1 + SOS_PRIOR_GAMES), 12);
  });

  test("empty or all-future logs return neutral", () => {
    const lines = new Map<number, TeamLines>([[2, { batting: lgBatting(), staff: lgStaff() }]]);
    const empty = computeStarterSos([], 1, lines, LG, "2026-06-01", homeVenueOf, PLAIN);
    expect(empty.starts).toBe(0);
    expect(empty.oppBatting.hr).toBe(1);
    const future = computeStarterSos(
      [{ date: "2026-06-15", opponentTeamId: 2, isHome: true, battersFaced: 30 }],
      1,
      lines,
      LG,
      "2026-06-01",
      homeVenueOf,
      PLAIN,
    );
    expect(future.starts).toBe(0);
    expect(future.oppBatting.hr).toBe(1);
  });
});
