#!/usr/bin/env node
/**
 * Checks the Player Props board rules in src/lib/props-board.ts — the
 * one-row-per-player collapse on Top picks, the fact that per-market tabs are
 * exempt from it, and that "Strong only" filters before the collapse rather
 * than after.
 *
 * One module now serves both boards: MLB keys players by number and ESPN's
 * soccer feed by string, so the last block exercises the string path too. If
 * the id type is ever narrowed back to `number`, that block stops compiling —
 * which is the point.
 *
 * Run:  npx tsx scripts/test-props-board.ts
 */
import { bestRungPerPlayer, boardPicks, PER_GAME } from "../src/lib/props-board";

type P = { playerId: number; market: string; edge: number; tier: string | null };
const p = (playerId: number, market: string, edge: number, tier: string | null = "Solid"): P => ({
  playerId,
  market,
  edge,
  tier,
});

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`,
  );
}

// ---- the complaint that started this: one starter, three strikeout rungs
const ladder = [p(1, "k5", 0.09), p(1, "k6", 0.17), p(1, "k7", 0.12)];
check("a pitcher appears once, not at 5+/6+/7+", bestRungPerPlayer(ladder).length, 1);
check("and it is the biggest-edge rung", bestRungPerPlayer(ladder)[0].market, "k6");

// ---- same for a batter quoted across the hits / total-bases ladders
const batter = [p(2, "h1", 0.05), p(2, "h2", 0.11), p(2, "tb2", 0.08), p(2, "r1", 0.03)];
check("a batter appears once across markets", bestRungPerPlayer(batter).length, 1);
check("at their biggest edge", bestRungPerPlayer(batter)[0].market, "h2");

// ---- distinct players are never collapsed together
const many = [p(1, "k6", 0.2), p(2, "h2", 0.15), p(3, "hr1", 0.1)];
check("distinct players all survive", bestRungPerPlayer(many).length, 3);
check(
  "ordered by edge, best first",
  bestRungPerPlayer(many).map((x) => x.playerId),
  [1, 2, 3],
);

// ---- Top picks: collapsed, then capped at PER_GAME
const slate = [
  ...ladder,
  ...batter,
  ...Array.from({ length: 8 }, (_, i) => p(10 + i, "h1", 0.2 - i * 0.01)),
];
const top = boardPicks(slate, "all", false);
check("Top picks caps at PER_GAME", top.length, PER_GAME);
check("Top picks has no repeated player", new Set(top.map((x) => x.playerId)).size, top.length);

// ---- a selected market is exempt: every pitcher at that exact number shows
const k6Board = boardPicks(
  [p(1, "k6", 0.17), p(2, "k6", 0.14), p(3, "k6", 0.11), p(1, "k5", 0.09)],
  "k6",
  false,
);
check("market tab lists every player at that rung", k6Board.length, 3);
check("market tab shows only that market", new Set(k6Board.map((x) => x.market)).size, 1);

// ---- Strong only filters BEFORE the collapse, so a Strong rung is not lost
// behind a bigger-edge Lean rung for the same player.
const mixed = [p(1, "k5", 0.2, "Lean"), p(1, "k6", 0.12, "Strong")];
check("Strong only keeps the Strong rung", boardPicks(mixed, "all", true)[0].market, "k6");
check("without the filter the biggest edge wins", boardPicks(mixed, "all", false)[0].market, "k5");
check(
  "a player with no Strong rung drops out",
  boardPicks([p(9, "h1", 0.3, "Lean")], "all", true).length,
  0,
);

// ---- empty input is not a crash
check("empty board is empty", boardPicks([], "all", false).length, 0);

// ---- the same rule over ESPN's string player ids (the soccer board)
const s1 = { playerId: "150225", market: "sh1", edge: 0.09, tier: "Solid" };
const s2 = { playerId: "150225", market: "sh2", edge: 0.21, tier: "Solid" };
const s3 = { playerId: "45843", market: "goal1", edge: 0.14, tier: "Strong" };
const soccer = boardPicks([s1, s2, s3], "all", false);
check("string ids collapse per player too", soccer.length, 2);
check("and keep the biggest-edge rung", soccer[0].market, "sh2");
check(
  "string ids are not coerced or collided",
  soccer.map((x) => x.playerId),
  ["150225", "45843"],
);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
