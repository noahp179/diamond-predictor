// Tests for the sim-elo-v3 wiring. The load-bearing one is the regression
// guarantee: with every adjustment disabled, sim-elo-v3 must be bit-identical
// to sim-elo-v2 on the same inputs. Run with `bun test`.

import { describe, expect, test } from "bun:test";
import {
  eloWinProb,
  simulateMatchup,
  type BattingRates,
  type PitchingLine,
  type StarterInfo,
} from "./mlb-sim";
import {
  DEFAULT_SOS_TUNING,
  type SeasonGame,
  type StarterLogEntry,
  type TeamLines,
} from "./mlb-sos";
import {
  DEFAULT_V3_CONFIG,
  predictV3Game,
  V3_AS_V2_CONFIG,
  type V3Config,
  type V3Env,
  type V3GameInput,
} from "./mlb-v3";

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

const scaleLine = (line: PitchingLine, k: Partial<Record<keyof PitchingLine, number>>) => {
  const out = { ...line };
  for (const [ev, mult] of Object.entries(k)) {
    (out as Record<string, number>)[ev] *= mult as number;
  }
  return out;
};

const scaleBatting = (k: Partial<Record<"bb" | "so" | "hr" | "b1" | "b2" | "b3", number>>) => {
  const out: BattingRates = { ...LG, pa: 5000 };
  for (const [ev, mult] of Object.entries(k)) {
    (out as unknown as Record<string, number>)[ev] *= mult as number;
  }
  return out;
};

function mkGame(date: string, home: number, away: number, venue = "Nationals Park"): SeasonGame {
  return { date, home, away, homeScore: 4, awayScore: 3, venue, innings: 9 };
}

const GAME: V3GameInput = {
  gameId: 777001,
  date: "2026-06-10",
  gameDate: "2026-06-10T23:05:00Z",
  venue: "Nationals Park",
  homeId: 1,
  awayId: 2,
  homeName: "Home Club",
  awayName: "Away Club",
  homePitcherId: null,
  awayPitcherId: null,
};

function mkEnv(overrides: Partial<V3Env> = {}): V3Env {
  const teamLines = new Map<number, TeamLines>();
  for (let id = 1; id <= 6; id++) {
    teamLines.set(id, { batting: { ...LG, pa: 5000 }, staff: lgStaff() });
  }
  return {
    seasonGames: [],
    teamLines,
    league: LG,
    elo: new Map([
      [1, 1520],
      [2, 1490],
    ]),
    starterInfo: new Map(),
    starterLogs: new Map(),
    homeVenueOf: (id) => (id === 1 ? "Nationals Park" : id === 2 ? "Fenway Park" : null),
    nSims: 1500,
    ...overrides,
  };
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

describe("regression guarantee: V3_AS_V2_CONFIG reproduces sim-elo-v2 exactly", () => {
  test("finalProb equals the v2 ensemble computed directly from mlb-sim", () => {
    const seasonGames = [
      mkGame("2026-06-01", 1, 3, "Coors Field"),
      mkGame("2026-06-02", 2, 4, "Petco Park"),
      mkGame("2026-06-08", 1, 2, "Fenway Park"),
    ];
    const starterInfo = new Map<number, StarterInfo | null>([
      [10, { line: scaleLine(lgStaff(), { so: 1.15, hr: 0.9 }), expectedOuts: 17 }],
      [20, { line: scaleLine(lgStaff(), { bb: 1.2 }), expectedOuts: 15 }],
    ]);
    const starterLogs = new Map<number, StarterLogEntry[]>([
      [10, [{ date: "2026-06-01", opponentTeamId: 3, isHome: true, battersFaced: 25 }]],
      [20, [{ date: "2026-06-02", opponentTeamId: 4, isHome: false, battersFaced: 22 }]],
    ]);
    const env = mkEnv({ seasonGames, starterInfo, starterLogs, config: V3_AS_V2_CONFIG });
    const game = { ...GAME, homePitcherId: 10, awayPitcherId: 20 };
    const pred = predictV3Game(game, env);

    // sim-elo-v2, computed by hand from the frozen engine with raw inputs.
    const simProb = simulateMatchup(
      {
        homeBatting: env.teamLines.get(1)!.batting!,
        awayBatting: env.teamLines.get(2)!.batting!,
        homeStarter: starterInfo.get(10)!,
        awayStarter: starterInfo.get(20)!,
        homeStaff: env.teamLines.get(1)!.staff,
        awayStaff: env.teamLines.get(2)!.staff,
        league: LG,
        venue: game.venue,
      },
      1500,
      1000 + game.gameId,
    );
    const eloProb = eloWinProb(1520, 1490);
    const ensemble = sigmoid((logit(clamp01(simProb)) + logit(clamp01(eloProb))) / 2);

    expect(pred.simProb).toBe(simProb); // bit-identical, not approximately
    expect(pred.eloProb).toBe(eloProb);
    expect(pred.ensembleProb).toBe(ensemble);
    expect(pred.finalProb).toBe(ensemble);
    expect(pred.contextDelta.total).toBe(0);
  });

  test("with no season history the default config also degrades to v2", () => {
    // Nothing to compute SOS or context from — sim-elo-v3 must not invent signal.
    const env = mkEnv({ config: DEFAULT_V3_CONFIG });
    const envV2 = mkEnv({ config: V3_AS_V2_CONFIG });
    const a = predictV3Game(GAME, env);
    const b = predictV3Game(GAME, envV2);
    expect(a.simProb).toBe(b.simProb);
    // rest defaults tie (3 vs 3) and every other context input is empty.
    expect(a.finalProb).toBe(b.finalProb);
  });
});

describe("strength-of-schedule effects point the right way", () => {
  test("a batting line deflated by tough opposing staffs gets credited back", () => {
    // Team 1 (home) spent 20 games against a stifling staff; team 2 faced
    // league-average pitching. Both raw lines look identical.
    const seasonGames: SeasonGame[] = [];
    for (let i = 0; i < 20; i++) {
      seasonGames.push(mkGame(`2026-05-${String(i + 1).padStart(2, "0")}`, 1, 5));
      seasonGames.push(mkGame(`2026-05-${String(i + 1).padStart(2, "0")}`, 2, 6));
    }
    const teamLines = new Map<number, TeamLines>([
      [1, { batting: { ...LG, pa: 5000 }, staff: lgStaff() }],
      [2, { batting: { ...LG, pa: 5000 }, staff: lgStaff() }],
      // Team 5: ace staff (fewer walks/hits/homers allowed, more strikeouts).
      [
        5,
        {
          batting: { ...LG, pa: 5000 },
          staff: scaleLine(lgStaff(), { bb: 0.8, b1: 0.8, b2: 0.8, b3: 0.8, hr: 0.8, so: 1.2 }),
        },
      ],
      // Team 6: exactly league average.
      [6, { batting: { ...LG, pa: 5000 }, staff: lgStaff() }],
    ]);
    const sosOnly: V3Config = {
      ...DEFAULT_V3_CONFIG,
      sos: {
        adjustBatting: true,
        adjustPitching: false,
        adjustParks: false,
        starterLevel: false,
        tuning: DEFAULT_SOS_TUNING,
      },
      context: V3_AS_V2_CONFIG.context,
    };
    const on = predictV3Game(GAME, mkEnv({ seasonGames, teamLines, config: sosOnly }));
    const off = predictV3Game(GAME, mkEnv({ seasonGames, teamLines, config: V3_AS_V2_CONFIG }));
    expect(on.simProb).toBeGreaterThan(off.simProb + 0.015);
  });

  test("park deconvolution deflates a Coors-inflated batting line", () => {
    const seasonGames: SeasonGame[] = [];
    for (let i = 0; i < 20; i++) {
      seasonGames.push(mkGame(`2026-05-${String(i + 1).padStart(2, "0")}`, 1, 5, "Coors Field"));
      seasonGames.push(mkGame(`2026-05-${String(i + 1).padStart(2, "0")}`, 2, 6, "Nationals Park"));
    }
    const parksOnly: V3Config = {
      ...DEFAULT_V3_CONFIG,
      sos: {
        adjustBatting: false,
        adjustPitching: false,
        adjustParks: true,
        starterLevel: false,
        tuning: DEFAULT_SOS_TUNING,
      },
      context: V3_AS_V2_CONFIG.context,
    };
    const on = predictV3Game(GAME, mkEnv({ seasonGames, config: parksOnly }));
    const off = predictV3Game(GAME, mkEnv({ seasonGames, config: V3_AS_V2_CONFIG }));
    // Team 1's raw offense was earned at altitude, and its staff was *hurt*
    // by altitude. De-parking cuts the offense credit and repairs the staff;
    // net effect on win prob must move it, and the batting side dominates
    // here because both effects push the same direction for the home side
    // (weaker true bats, better true arms than raw for the visitor's staff…)
    // — direction checked empirically against hand math: offense deflation
    // outweighs staff repair for equal scalings, so home prob drops.
    expect(on.simProb).toBeLessThan(off.simProb - 0.005);
  });

  test("a starter's line is corrected for the batting schedule he faced", () => {
    // Home starter 10 has faced murderers' rows (hot batting schedules);
    // away starter 20 faced league average. Identical raw lines.
    const seasonGames = [mkGame("2026-05-01", 1, 5), mkGame("2026-05-02", 2, 6)];
    const teamLines = mkEnv().teamLines;
    teamLines.set(5, {
      batting: scaleBatting({ bb: 1.25, b1: 1.25, b2: 1.25, b3: 1.25, hr: 1.25, so: 0.8 }),
      staff: lgStaff(),
    });
    const starterInfo = new Map<number, StarterInfo | null>([
      [10, { line: lgStaff(), expectedOuts: 16 }],
      [20, { line: lgStaff(), expectedOuts: 16 }],
    ]);
    const starterLogs = new Map<number, StarterLogEntry[]>([
      [
        10,
        Array.from({ length: 6 }, (_, i) => ({
          date: `2026-05-${String(i + 1).padStart(2, "0")}`,
          opponentTeamId: 5,
          isHome: true,
          battersFaced: 26,
        })),
      ],
      [
        20,
        Array.from({ length: 6 }, (_, i) => ({
          date: `2026-05-${String(i + 1).padStart(2, "0")}`,
          opponentTeamId: 6,
          isHome: true,
          battersFaced: 26,
        })),
      ],
    ]);
    const cfg: V3Config = {
      ...DEFAULT_V3_CONFIG,
      sos: {
        adjustBatting: false,
        adjustPitching: true,
        adjustParks: false,
        starterLevel: true,
        tuning: DEFAULT_SOS_TUNING,
      },
      context: V3_AS_V2_CONFIG.context,
    };
    const game = { ...GAME, homePitcherId: 10, awayPitcherId: 20 };
    const on = predictV3Game(
      game,
      mkEnv({ seasonGames, teamLines, starterInfo, starterLogs, config: cfg }),
    );
    const off = predictV3Game(
      game,
      mkEnv({ seasonGames, teamLines, starterInfo, starterLogs, config: V3_AS_V2_CONFIG }),
    );
    expect(on.simProb).toBeGreaterThan(off.simProb + 0.01);
  });
});

describe("context and calibration wiring", () => {
  test("a hot rested home side lifts finalProb above the ensemble", () => {
    const seasonGames: SeasonGame[] = [];
    for (let i = 0; i < 5; i++) {
      seasonGames.push(mkGame(`2026-06-0${i + 3}`, 1, 5)); // home wins, home park
      seasonGames.push({
        ...mkGame(`2026-06-0${i + 3}`, 6, 2, "Dodger Stadium"),
        homeScore: 8,
        awayScore: 1,
      }); // away team losing out west
    }
    const pred = predictV3Game(GAME, mkEnv({ seasonGames, config: DEFAULT_V3_CONFIG }));
    expect(pred.contextDelta.total).toBeGreaterThan(0.02);
    expect(pred.finalProb).toBeGreaterThan(pred.ensembleProb);
    expect(pred.rationale.some((r) => r.startsWith("Context Δ"))).toBe(true);
  });

  test("calScale 0 collapses to a coin flip; scale <1 shrinks toward 0.5", () => {
    const seasonGames = [mkGame("2026-06-01", 1, 2)];
    const zero = predictV3Game(
      GAME,
      mkEnv({ seasonGames, config: { ...DEFAULT_V3_CONFIG, calScale: 0 } }),
    );
    expect(zero.finalProb).toBe(0.5);
    const full = predictV3Game(GAME, mkEnv({ seasonGames, config: DEFAULT_V3_CONFIG }));
    const shrunk = predictV3Game(
      GAME,
      mkEnv({ seasonGames, config: { ...DEFAULT_V3_CONFIG, calScale: 0.7 } }),
    );
    expect(Math.abs(shrunk.finalProb - 0.5)).toBeLessThan(Math.abs(full.finalProb - 0.5));
  });

  test("no lookahead: future games and future starts cannot change the prediction", () => {
    const past: SeasonGame[] = [
      mkGame("2026-06-01", 1, 5, "Coors Field"),
      mkGame("2026-06-05", 2, 6, "Petco Park"),
    ];
    const future: SeasonGame[] = [
      mkGame("2026-06-10", 1, 2), // same day — must be invisible
      mkGame("2026-06-20", 1, 6, "Coors Field"),
    ];
    const starterInfo = new Map<number, StarterInfo | null>([
      [10, { line: lgStaff(), expectedOuts: 16 }],
    ]);
    const logsPast = new Map<number, StarterLogEntry[]>([
      [10, [{ date: "2026-06-01", opponentTeamId: 5, isHome: true, battersFaced: 26 }]],
    ]);
    const logsWithFuture = new Map<number, StarterLogEntry[]>([
      [
        10,
        [
          { date: "2026-06-01", opponentTeamId: 5, isHome: true, battersFaced: 26 },
          { date: "2026-06-15", opponentTeamId: 6, isHome: false, battersFaced: 30 },
        ],
      ],
    ]);
    const game = { ...GAME, homePitcherId: 10 };
    const a = predictV3Game(game, mkEnv({ seasonGames: past, starterInfo, starterLogs: logsPast }));
    const b = predictV3Game(
      game,
      mkEnv({ seasonGames: [...past, ...future], starterInfo, starterLogs: logsWithFuture }),
    );
    expect(b.simProb).toBe(a.simProb);
    expect(b.finalProb).toBe(a.finalProb);
  });
});
