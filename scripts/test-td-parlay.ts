/**
 * Slip invariants, against live ESPN, at every per-game setting.
 *
 * The one that matters most: the quoted probability must be the product of the
 * slip's own legs times the measured correlation correction, and never more.
 * Stacking a game is allowed — that is the point — so the test runs 1, 2, 3 and
 * unrestricted legs per game and checks the correction is actually applied
 * rather than the product being quoted unchanged.
 *
 *   bun scripts/test-td-parlay.ts [cfb|nfl] [YYYY-MM-DD]
 */
import { buildTdParlays, PAIR_FACTOR, PARLAY_SIZES, SIZE_EVIDENCE } from "../src/lib/td-parlay";
import type { ParlayCandidate, TdParlay } from "../src/lib/td-parlay";

const sport = (process.argv[2] ?? "cfb") as "cfb" | "nfl";
const date = process.argv[3] ?? (sport === "cfb" ? "2026-09-19" : "2026-09-20");

const candidates: ParlayCandidate[] = [];
if (sport === "cfb") {
  const { cfbTdSlate } = await import("../src/lib/cfb-td.server");
  const s = await cfbTdSlate(date);
  for (const g of s.games) {
    if (g.started) continue;
    for (const p of g.picks)
      candidates.push({
        playerId: p.playerId,
        player: p.player,
        position: p.position,
        team: p.team,
        gameId: g.gameId,
        matchup: g.matchup,
        prob: p.prob,
        tier: p.tier,
        tierHit: p.tierHit,
        reasons: p.reasons,
        against: p.against,
      });
  }
} else {
  const { tdScorersSlate } = await import("../src/lib/nfl-td.server");
  const s = await tdScorersSlate(date);
  for (const g of s.games) {
    if (g.started) continue;
    for (const p of g.picks.slice(0, 3))
      candidates.push({
        playerId: p.playerId,
        player: p.player,
        position: null,
        team: p.team,
        gameId: g.gameId,
        matchup: g.matchup,
        prob: p.prob,
        tier: null,
        tierHit: null,
        reasons: p.reasons,
        against: p.against,
      });
  }
}

const gamesAvailable = new Set(candidates.map((c) => c.gameId)).size;
console.log(
  `${sport.toUpperCase()} ${date}: ${candidates.length} candidates across ${gamesAvailable} games`,
);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

function runChecks(p: TdParlay, cap: number, label: string) {
  const ev = SIZE_EVIDENCE[sport]?.[p.size];
  console.log(`\n  === ${p.size} legs${p.short ? ` — SHORT, only ${p.legs.length}` : ""}`);
  if (p.legs.length === 0) {
    console.log("    (no slip)");
    return;
  }
  console.log(
    `    quoted ${(p.adjustedProb * 100).toFixed(3)}% (1 in ${p.oneIn.toLocaleString()}); ` +
      `product ${(p.combinedProb * 100).toFixed(3)}%; correction x${p.correlationFactor.toFixed(2)}` +
      `${p.extrapolated ? " [EXTRAPOLATED]" : ""}`,
  );
  console.log(
    `    stacked: ${p.stackedPairs.sameTeam} same-team, ${p.stackedPairs.opposed} opposed; ` +
      `mean leg ${(p.meanLeg * 100).toFixed(1)}%; doubled-up ${p.doubledUp}; below floor ${p.belowFloor}`,
  );
  if (ev) console.log(`    backtest at 1/game: ${(ev.stated * 100).toFixed(3)}% — ${ev.observed}`);

  const ids = p.legs.map((l) => l.playerId);
  check(new Set(ids).size === ids.length, "no player appears twice");

  const perGame = new Map<number, number>();
  for (const l of p.legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  const maxSeen = Math.max(...perGame.values());
  // The cap may only be exceeded when the slate cannot fill the slip within it.
  check(
    maxSeen <= cap || p.size > gamesAvailable * cap,
    `respects the ${label} cap unless the slate cannot fill it (saw ${maxSeen}/game)`,
  );
  check(
    !Number.isFinite(cap) || maxSeen <= cap + 1,
    `never exceeds the cap by more than one (saw ${maxSeen}/game)`,
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
    PAIR_FACTOR.sameTeam ** p.stackedPairs.sameTeam *
    PAIR_FACTOR.opposed ** p.stackedPairs.opposed;
  check(
    Math.abs(expected - p.adjustedProb) < 1e-12,
    "adjustedProb applies the measured per-pair correction",
  );
  check(p.adjustedProb <= p.combinedProb + 1e-12, "the correction never flatters the slip");
  check(
    sameGame === 0 ? p.correlationFactor === 1 : p.correlationFactor < 1,
    "a slip with stacked legs is corrected; one without is not",
  );
  check(
    p.belowFloor === 0 || p.legs.length === p.size,
    `reaching below the ${p.floor} floor only happens to fill the slip (${p.belowFloor} did)`,
  );
  check(
    p.legs.every((l) => l.reasons.length > 0),
    "every leg carries at least one reason",
  );
}

for (const { cap, label } of [
  { cap: 1, label: "1/game" },
  { cap: 2, label: "2/game" },
  { cap: 3, label: "3/game" },
  { cap: Infinity, label: "any" },
]) {
  console.log(`\n########## legs from one game: ${label} ##########`);
  for (const p of buildTdParlays(candidates, PARLAY_SIZES, cap)) runChecks(p, cap, label);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
