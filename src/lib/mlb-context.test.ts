// Unit tests for the game-context layer. Run with `bun test`.

import { describe, expect, test } from "bun:test";
import {
  computeTeamContext,
  contextLogitDelta,
  CONTEXT_DISABLED,
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from "./mlb-context";
import { venueDistanceKm, venueTzShift } from "./stadium-geo";
import type { SeasonGame } from "./mlb-sos";

function g(
  date: string,
  home: number,
  away: number,
  homeScore: number,
  awayScore: number,
  venue: string | null = "Nationals Park",
  innings = 9,
): SeasonGame {
  return { date, home, away, homeScore, awayScore, venue, innings };
}

const AS_OF = "2026-06-10";

describe("stadium-geo", () => {
  test("LA → Boston is a cross-country flight, 3 zones eastward", () => {
    const km = venueDistanceKm("Dodger Stadium", "Fenway Park")!;
    expect(km).toBeGreaterThan(4000);
    expect(km).toBeLessThan(4400);
    expect(venueTzShift("Dodger Stadium", "Fenway Park")).toBe(3);
    expect(venueTzShift("Fenway Park", "Dodger Stadium")).toBe(-3);
  });

  test("same park is zero travel", () => {
    expect(venueDistanceKm("Fenway Park", "Fenway Park")).toBe(0);
    expect(venueTzShift("Fenway Park", "Fenway Park")).toBe(0);
  });

  test("unknown venues yield null, not garbage", () => {
    expect(venueDistanceKm("Narnia Dome", "Fenway Park")).toBeNull();
    expect(venueTzShift(null, "Fenway Park")).toBeNull();
  });
});

describe("computeTeamContext", () => {
  test("signed streak from the tail of the schedule", () => {
    const games = [
      g("2026-06-05", 1, 2, 2, 5), // L
      g("2026-06-06", 1, 2, 4, 1), // W
      g("2026-06-07", 2, 1, 3, 6), // W (away win)
      g("2026-06-08", 1, 2, 7, 0), // W
    ];
    expect(computeTeamContext(1, games, AS_OF).streak).toBe(3);
    expect(computeTeamContext(2, games, AS_OF).streak).toBe(-3);
  });

  test("losing streak is negative and no games is zero", () => {
    const games = [g("2026-06-07", 1, 2, 1, 4), g("2026-06-08", 1, 2, 2, 3)];
    expect(computeTeamContext(1, games, AS_OF).streak).toBe(-2);
    expect(computeTeamContext(3, games, AS_OF).streak).toBe(0);
  });

  test("rest days: played yesterday → 0; three days ago → 2; never → default 3", () => {
    expect(computeTeamContext(1, [g("2026-06-09", 1, 2, 4, 3)], AS_OF).restDays).toBe(0);
    expect(computeTeamContext(1, [g("2026-06-07", 1, 2, 4, 3)], AS_OF).restDays).toBe(2);
    expect(computeTeamContext(1, [], AS_OF).restDays).toBe(3);
  });

  test("gamesLast7 counts a doubleheader twice", () => {
    const games = [
      g("2026-06-04", 1, 2, 4, 3),
      g("2026-06-07", 1, 2, 1, 2),
      g("2026-06-07", 1, 2, 5, 2), // DH game 2
      g("2026-06-09", 1, 2, 2, 0),
    ];
    expect(computeTeamContext(1, games, AS_OF).gamesLast7).toBe(4);
  });

  test("recent run diff windows on formDays and subtracts nothing it shouldn't", () => {
    const games = [
      g("2026-04-01", 1, 2, 0, 10), // ancient blowout loss — outside 14d window
      g("2026-06-01", 1, 2, 6, 2),
      g("2026-06-05", 1, 2, 5, 1),
    ];
    const ctx = computeTeamContext(1, games, AS_OF);
    expect(ctx.recentRunDiff).toBeCloseTo((6 - 2 + (5 - 1)) / 2, 12);
    expect(ctx.seasonRunDiff).toBeCloseTo((0 - 10 + 4 + 4) / 3, 12);
  });

  test("pen stress: extras yesterday 1.0, blowout allowed yesterday +0.5, day-before halves", () => {
    const games = [
      g("2026-06-08", 1, 2, 3, 4, "Nationals Park", 11), // extras two days ago → 0.5
      g("2026-06-09", 1, 2, 5, 9, "Nationals Park", 9), // allowed 9 yesterday → 0.5
    ];
    expect(computeTeamContext(1, games, AS_OF).penStress).toBeCloseTo(1.0, 12);
    const extrasYesterday = [g("2026-06-09", 1, 2, 3, 4, "Nationals Park", 12)];
    expect(computeTeamContext(1, extrasYesterday, AS_OF).penStress).toBeCloseTo(1.0, 12);
  });

  test("no lookahead: games on/after the date are ignored", () => {
    const past = [g("2026-06-08", 1, 2, 4, 3)];
    const withFuture = [...past, g("2026-06-10", 1, 2, 0, 9), g("2026-06-12", 1, 2, 0, 9)];
    expect(computeTeamContext(1, withFuture, AS_OF)).toEqual(computeTeamContext(1, past, AS_OF));
  });
});

describe("contextLogitDelta", () => {
  const mkCtx = (teamId: number, games: SeasonGame[]) => computeTeamContext(teamId, games, AS_OF);

  test("all features disabled produce exactly zero", () => {
    const games = [g("2026-06-09", 1, 2, 9, 0, "Coors Field", 12)];
    const d = contextLogitDelta(
      mkCtx(1, games),
      mkCtx(2, games),
      "Fenway Park",
      AS_OF,
      CONTEXT_DISABLED,
    );
    expect(d.total).toBe(0);
    expect(d.terms).toEqual([]);
  });

  test("identical contexts cancel to zero", () => {
    const games = [g("2026-06-09", 1, 2, 4, 3), g("2026-06-09", 3, 4, 4, 3)];
    const d = contextLogitDelta(mkCtx(1, games), mkCtx(3, games), "Nationals Park", AS_OF);
    // team 1 won, team 3 won, same venue/rest/density → only streak parity matters
    expect(d.total).toBeCloseTo(0, 12);
  });

  test("hot rested home team vs road-weary cold away team is positive", () => {
    const games: SeasonGame[] = [];
    // Home team 1: three straight wins at home, rested two days.
    for (let i = 0; i < 3; i++) games.push(g(`2026-06-0${5 + i}`, 1, 9, 5, 1, "Fenway Park"));
    // Away team 2: three straight losses, played last night in LA (flies to Boston).
    for (let i = 0; i < 3; i++) games.push(g(`2026-06-0${7 + i}`, 8, 2, 6, 2, "Dodger Stadium"));
    const d = contextLogitDelta(mkCtx(1, games), mkCtx(2, games), "Fenway Park", AS_OF);
    expect(d.total).toBeGreaterThan(0.02);
    const names = d.terms.map((t) => t.name);
    expect(names).toContain("streak");
    expect(names).toContain("travel");
    expect(names).toContain("tz");
  });

  test("travel is ignored after two full rest days (absorbed)", () => {
    const games = [
      g("2026-06-06", 8, 1, 2, 4, "Dodger Stadium"), // team 1 played in LA 4 days before
      g("2026-06-09", 9, 2, 2, 4, "Fenway Park"), // team 2 played in Boston yesterday
    ];
    const d = contextLogitDelta(mkCtx(1, games), mkCtx(2, games), "Fenway Park", AS_OF);
    expect(d.terms.find((t) => t.name === "travel")).toBeUndefined();
  });

  test("the summed delta is hard-capped", () => {
    const loud: ContextConfig = {
      ...DEFAULT_CONTEXT_CONFIG,
      streakCoef: 1,
      restCoef: 1,
      travelCoef: 1,
      tzCoef: 1,
    };
    const games: SeasonGame[] = [];
    for (let i = 0; i < 8; i++)
      games.push(g(`2026-06-0${1 + i}`.slice(0, 10), 1, 9, 5, 1, "Fenway Park"));
    games.push(g("2026-06-09", 8, 2, 9, 1, "Dodger Stadium", 13));
    const d = contextLogitDelta(mkCtx(1, games), mkCtx(2, games), "Fenway Park", AS_OF, loud);
    expect(Math.abs(d.total)).toBeLessThanOrEqual(loud.totalCap + 1e-12);
    expect(Math.abs(d.total)).toBeCloseTo(loud.totalCap, 12);
  });

  test("eastward time-zone crossings cost more than westward", () => {
    const eastGames = [
      g("2026-06-09", 8, 1, 2, 4, "Dodger Stadium"), // team 1: LA → Boston (east +3)
      g("2026-06-09", 9, 2, 2, 4, "Fenway Park"), // team 2: already in Boston
    ];
    const westGames = [
      g("2026-06-09", 8, 1, 2, 4, "Fenway Park"), // team 1: Boston → LA (west −3)
      g("2026-06-09", 9, 2, 2, 4, "Dodger Stadium"), // team 2: already in LA
    ];
    const east = contextLogitDelta(mkCtx(1, eastGames), mkCtx(2, eastGames), "Fenway Park", AS_OF);
    const west = contextLogitDelta(
      mkCtx(1, westGames),
      mkCtx(2, westGames),
      "Dodger Stadium",
      AS_OF,
    );
    const tzEast = east.terms.find((t) => t.name === "tz")!.value;
    const tzWest = west.terms.find((t) => t.name === "tz")!.value;
    expect(tzEast).toBeLessThan(0); // home team 1 flew east → penalized
    expect(tzWest).toBeLessThan(0);
    expect(Math.abs(tzEast)).toBeGreaterThan(Math.abs(tzWest));
  });
});
