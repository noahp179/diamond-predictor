#!/usr/bin/env node
/**
 * Slip invariants for the MLB base parlays, against a live slate.
 *
 * This is the football slip test's sibling, and it exists separately because
 * one of that test's invariants is FALSE here. Football corrects a stacked slip
 * downward at every setting, so `adjustedProb <= combinedProb` is a safe check
 * there. Baseball's same-lineup factor is 1.021 — measured, and effectively
 * nothing — so a slip with two hitters from one lineup is corrected very
 * slightly UP, and asserting the football inequality would fail on a correct
 * slip. What both tests really check is the same thing and is checked here in
 * the honest form: the quoted probability is the product of the slip's own legs
 * times the measured per-pair factors, exactly, in whichever direction those
 * factors point.
 *
 * The other thing this has to check that football does not: a leg must come
 * from a game that has not started. The 2+ bases board shows games under way
 * because the projection is still the projection; a slip that did the same
 * would be offering a bet nobody can place.
 *
 *   npx tsx scripts/test-base-parlay.ts [YYYY-MM-DD]
 */
import {
  buildTdParlay,
  buildTdParlays,
  PAIR_FACTOR,
  SIZE_CAP,
  SIZE_EVIDENCE,
  SIZE_FLOOR,
} from "../src/lib/td-parlay";
import type { ParlayCandidate, TdParlay } from "../src/lib/td-parlay";
import { twoBaseParlayCandidates } from "../src/lib/mlb-tb2.server";
import { todayET } from "../src/lib/date";

const SIZES = [5, 10, 15];
const date = process.argv[2] ?? todayET();
const now = Date.now();

// Through the same builder the page, the slip ledger and the pick ledger use,
// so this is testing what ships rather than a second copy of it.
const { slate, candidates } = await twoBaseParlayCandidates(date, now);

const gamesAvailable = new Set(candidates.map((c) => c.gameId)).size;
const startedGames = new Set(slate.picks.map((p) => p.gameId)).size - gamesAvailable;
console.log(
  `MLB ${date}: ${candidates.length} hitters across ${gamesAvailable} games still to start ` +
    `(${startedGames} already under way, left out)`,
);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

// Every leg must be bettable. Checked once against the slate rather than per
// slip, because it is a property of the candidate pool.
//
// Keyed on the GAME, not the hitter. A doubleheader puts the same nine hitters
// on the slate twice, so on a day where the first game has started and the
// second has not, a player id legitimately appears in both the dropped set and
// the kept one. Checking ids would fail a correct pool; the builder de-dupes by
// player id, so the hitter still cannot land on the slip twice — which is what
// the per-slip check below is for.
const startedGameIds = new Set(
  slate.picks.filter((p) => Date.parse(p.startsAt) <= now).map((p) => p.gameId),
);
console.log("\n  === candidate pool");
check(
  candidates.every((c) => !startedGameIds.has(c.gameId)),
  "no candidate comes from a game already under way",
);

function runChecks(p: TdParlay, cap: number, label: string) {
  const ev = SIZE_EVIDENCE.mlb?.[p.size];
  console.log(`\n  === ${p.size} legs${p.short ? ` — SHORT, only ${p.legs.length}` : ""}`);
  if (p.legs.length === 0) {
    console.log("    (no slip)");
    return;
  }
  console.log(
    `    quoted ${(p.adjustedProb * 100).toFixed(4)}% (1 in ${p.oneIn.toLocaleString()}); ` +
      `product ${(p.combinedProb * 100).toFixed(4)}%; correction x${p.correlationFactor.toFixed(3)}`,
  );
  console.log(
    `    stacked: ${p.stackedPairs.sameTeam} same-lineup, ${p.stackedPairs.opposed} opposed; ` +
      `mean leg ${(p.meanLeg * 100).toFixed(1)}%; worst ${(p.worstLeg * 100).toFixed(1)}%; ` +
      `doubled-up ${p.doubledUp}; below floor ${p.belowFloor}`,
  );
  if (ev)
    console.log(
      `    backtest: ${(ev.stated * 100).toFixed(4)}% stated — ${ev.observed}` +
        `${ev.meanLegs != null ? ` — ${ev.meanLegs} legs landed on a typical day` : ""}`,
    );

  const ids = p.legs.map((l) => l.playerId);
  check(new Set(ids).size === ids.length, "no hitter appears twice");

  const perGame = new Map<number, number>();
  for (const l of p.legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  const maxSeen = Math.max(...perGame.values());
  // The binding constraint is how many games carry a hitter clearing THIS
  // size's floor, not how many games are on the slate — see the football test.
  const overFloor = new Set(candidates.filter((c) => c.prob >= p.floor).map((c) => c.gameId)).size;
  check(
    maxSeen <= cap || p.size > overFloor * cap,
    `respects the ${label} cap unless the slate cannot fill it ` +
      `(saw ${maxSeen}/game; ${overFloor} games clear the ${p.floor} floor)`,
  );
  check(
    p.floor === SIZE_FLOOR.mlb[p.size],
    `uses baseball's floor for this size, not football's (${p.floor})`,
  );
  check(
    p.legs.every((l, i) => i === 0 || p.legs[i - 1].prob >= l.prob),
    "legs ordered surest first",
  );

  const product = p.legs.reduce((a, l) => a * l.prob, 1);
  check(Math.abs(product - p.combinedProb) < 1e-12, "combinedProb is the product of its legs");

  let sameGame = 0;
  for (let i = 0; i < p.legs.length; i++)
    for (let j = i + 1; j < p.legs.length; j++)
      if (p.legs[i].gameId === p.legs[j].gameId) sameGame++;
  check(
    sameGame === p.stackedPairs.sameTeam + p.stackedPairs.opposed,
    `every same-game pair is counted (${sameGame} found)`,
  );

  const expected =
    product *
    PAIR_FACTOR.mlb.sameTeam ** p.stackedPairs.sameTeam *
    PAIR_FACTOR.mlb.opposed ** p.stackedPairs.opposed;
  check(
    Math.abs(expected - p.adjustedProb) < 1e-12,
    "adjustedProb applies the measured per-pair correction, in the direction it points",
  );
  check(
    sameGame === 0 ? p.correlationFactor === 1 : p.correlationFactor !== 1,
    "a slip with stacked legs is corrected; one without is left alone",
  );
  // The correction is bounded by its own factors, and that is the only bound
  // worth asserting. An earlier version of this check fixed a 0.5x-2x band and
  // failed a CORRECT slip: fifteen legs unrestricted collects eighteen opposed
  // pairs, and 0.937^18 is 0.30. The band was the wrong idea — the number it
  // caught was arithmetic, not a bug. What is worth checking is that the factor
  // could not be anything else given the pairs on the slip.
  const lo = Math.min(PAIR_FACTOR.mlb.sameTeam, PAIR_FACTOR.mlb.opposed) ** sameGame;
  const hi = Math.max(PAIR_FACTOR.mlb.sameTeam, PAIR_FACTOR.mlb.opposed) ** sameGame;
  check(
    p.correlationFactor >= lo - 1e-12 && p.correlationFactor <= hi + 1e-12,
    `the correction is bounded by its own factors over ${sameGame} pairs ` +
      `(x${p.correlationFactor.toFixed(3)} in [${lo.toFixed(3)}, ${hi.toFixed(3)}])`,
  );
  // A slip carrying more opposed pairs than the correction was measured on must
  // say so, because that is where the approximation stops being one.
  check(
    p.extrapolated === p.stackedPairs.opposed > 3,
    `flags extrapolation exactly when it is extrapolating (${p.stackedPairs.opposed} opposed)`,
  );
  check(
    p.belowFloor === 0 || p.legs.length === p.size,
    `reaching below the ${p.floor} floor only happens to fill the slip (${p.belowFloor} did)`,
  );
  check(
    p.legs.every((l) => l.reasons.length > 0),
    "every leg carries at least one reason",
  );
  check(
    p.legs.every((l) => l.prob > 0 && l.prob < 1),
    "every leg is a real probability",
  );
}

// The default construction: each size gets the cap the sweep chose for it. This
// is what the page serves when the reader has not picked one, so it is the pass
// whose numbers have to line up with the quoted backtest.
console.log(`\n########## legs from one game: as backtested ##########`);
for (const size of SIZES) {
  const cap = SIZE_CAP.mlb[size] ?? Infinity;
  const p = buildTdParlay(candidates, size, cap, "mlb");
  runChecks(p, cap, `backtested (${Number.isFinite(cap) ? cap : "any"}/game)`);
  const ev = SIZE_EVIDENCE.mlb?.[size];
  check(
    ev?.cap === cap,
    `the cap served at ${size} legs is the one the quoted backtest used ` +
      `(serving ${cap}, backtest ${ev?.cap})`,
  );
}

for (const { cap, label } of [
  { cap: Infinity, label: "any" },
  { cap: 1, label: "1/game" },
  { cap: 2, label: "2/game" },
  { cap: 3, label: "3/game" },
]) {
  console.log(`\n########## legs from one game: ${label} ##########`);
  for (const p of buildTdParlays(candidates, SIZES, cap, "mlb")) runChecks(p, cap, label);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
