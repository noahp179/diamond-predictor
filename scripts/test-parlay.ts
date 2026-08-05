#!/usr/bin/env node
/**
 * Checks the parlay leg-selection rules in src/lib/mlb-parlay.ts — the ladder
 * dominance ("confident in 6+ K, so 5+ K is not a second leg"), the cross-market
 * implications a home run carries, and the fact that price never filters a leg.
 *
 * Run:  npx esbuild scripts/test-parlay.ts --bundle --platform=node --format=esm \
 *         --outfile=/tmp/t.mjs && node /tmp/t.mjs
 */
import { buildParlay, implies, type ParlayCandidate } from "../src/lib/mlb-parlay";

const c = (subjectId: string, market: string, label: string, prob: number, gameId = 1): ParlayCandidate => ({
  subjectId, subject: subjectId, market, label, prob, gameId, matchup: "AAA @ BBB",
  team: "AAA", kind: market.startsWith("k") || market === "outs16" ? "pitcher" : "batter",
});

let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n   got ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};

// implication closure
check("hr1 implies tb2 (transitive)", implies("hr1", "tb2"), true);
check("hr1 implies r1", implies("hr1", "r1"), true);
check("k7 implies k5 (transitive)", implies("k7", "k5"), true);
check("k5 does not imply k7", implies("k5", "k7"), false);
check("h1 does not imply tb2", implies("h1", "tb2"), false);
check("sb1 implies nothing", implies("sb1", "h1"), false);

// the user's example: confident in 6+, so 4/5+ is not a separate leg
const pitcher = [c("p1", "k5", "5+ strikeouts", 0.82), c("p1", "k6", "6+ strikeouts", 0.73), c("p1", "k7", "7+ strikeouts", 0.60)];
const at65 = buildParlay(pitcher, 0.65);
check("K ladder at 65%: one leg", at65.legs.length, 1);
check("K ladder at 65%: keeps the harder rung", at65.legs[0].market, "k6");
check("K ladder at 65%: 5+ absorbed", at65.legs[0].absorbed.map((a) => a.market), ["k5"]);
check("K ladder at 65%: one dropped", at65.droppedForOverlap, 1);

const at55 = buildParlay(pitcher, 0.55);
check("K ladder at 55%: takes 7+", at55.legs[0].market, "k7");
check("K ladder at 55%: absorbs both", at55.legs[0].absorbed.map((a) => a.market).sort(), ["k5", "k6"]);

const at78 = buildParlay(pitcher, 0.78);
check("K ladder at 78%: only 5+ clears", at78.legs.map((l) => l.market), ["k5"]);

// batter: harder rung wins when it clears, easier survives alone when it doesn't
const b1 = buildParlay([c("b1", "h1", "1+ hits", 0.78), c("b1", "tb2", "2+ total bases", 0.72)], 0.7);
check("batter: tb2 swallows h1", b1.legs.map((l) => l.market), ["tb2"]);
const b2 = buildParlay([c("b1", "h1", "1+ hits", 0.78), c("b1", "tb2", "2+ total bases", 0.55)], 0.7);
check("batter: h1 alone when tb2 misses bar", b2.legs.map((l) => l.market), ["h1"]);

// a home run swallows the whole batter line
const hr = buildParlay(["h1,1+ hits,0.9", "tb2,2+ TB,0.85", "tb4,4+ TB,0.8", "rbi1,1+ RBI,0.8", "r1,1+ run,0.78", "hr1,1+ HR,0.76"]
  .map((s) => { const [m, l, p] = s.split(","); return c("b9", m, l, Number(p)); }), 0.75);
check("HR swallows the batter's other legs", hr.legs.map((l) => l.market), ["hr1"]);
check("HR absorbed five", hr.legs[0].absorbed.length, 5);

// unrelated markets for one player both survive
const mixed = buildParlay([c("b2", "h1", "1+ hits", 0.8), c("b2", "sb1", "1+ stolen base", 0.78)], 0.75);
check("hit + steal are not overlap", mixed.legs.map((l) => l.market).sort(), ["h1", "sb1"]);

// different players never dedup against each other
const two = buildParlay([c("b3", "h1", "1+ hits", 0.8), c("b4", "tb2", "2+ TB", 0.78)], 0.75);
check("cross-player legs both kept", two.legs.length, 2);

// price is irrelevant: a 0.95 leg (about -1900) is included
const heavy = buildParlay([c("b5", "h1", "1+ hits", 0.95), c("b6", "h1", "1+ hits", 0.76)], 0.75);
check("heavy favorite included", heavy.legs.length, 2);
check("combined = product", Math.round(heavy.combinedProb * 1e6) / 1e6, Math.round(0.95 * 0.76 * 1e6) / 1e6);
check("fair price is negative for a likely slip", heavy.fairPrice < 0, true);

// same-game correlation is reported, not silently dropped
const sg = buildParlay([c("b7", "h1", "1+ hits", 0.8, 7), c("b8", "h1", "1+ hits", 0.79, 7)], 0.75);
check("same-game flagged", sg.correlatedGames[0].legs, 2);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
