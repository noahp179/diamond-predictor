/**
 * Builds the real slips against live ESPN and checks the invariants that
 * matter: one leg per game unless the slate cannot fill the slip, no player
 * twice, legs ordered surest-first, and a stated probability that matches the
 * product of its own legs.
 *
 *   bun scripts/test-td-parlay.ts [cfb|nfl] [YYYY-MM-DD]
 */
import { buildTdParlays, PARLAY_SIZES, SIZE_EVIDENCE } from "../src/lib/td-parlay";
import type { ParlayCandidate } from "../src/lib/td-parlay";

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
  `${sport.toUpperCase()} ${date}: ${candidates.length} candidates across ${gamesAvailable} games\n`,
);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

for (const p of buildTdParlays(candidates, PARLAY_SIZES)) {
  const ev = SIZE_EVIDENCE[sport]?.[p.size];
  console.log(`\n=== ${p.size} legs ${p.short ? `— SHORT, only ${p.legs.length} available` : ""}`);
  if (p.legs.length === 0) {
    console.log("  (no slip)");
    continue;
  }
  console.log(
    `  stated ${(p.combinedProb * 100).toFixed(3)}% (about 1 in ${p.oneIn}), fair ${p.fairPrice > 0 ? "+" : ""}${p.fairPrice}`,
  );
  console.log(
    `  mean leg ${(p.meanLeg * 100).toFixed(1)}%, weakest ${(p.worstLeg * 100).toFixed(1)}%, ` +
      `doubled-up games ${p.doubledUp}, below floor ${p.belowFloor}`,
  );
  if (ev) console.log(`  backtest says: ${(ev.stated * 100).toFixed(3)}% — ${ev.observed}`);
  for (const l of p.legs.slice(0, 3))
    console.log(
      `   ${l.rank}. ${l.player} (${l.team}) ${(l.prob * 100).toFixed(0)}% — ${l.reasons[0] ?? "—"}`,
    );
  if (p.legs.length > 3) console.log(`   … ${p.legs.length - 3} more`);

  // invariants
  const ids = p.legs.map((l) => l.playerId);
  check(new Set(ids).size === ids.length, "no player appears twice");
  const perGame = new Map<number, number>();
  for (const l of p.legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  const maxPerGame = Math.max(...perGame.values());
  // Doubling up is only legitimate when the slate has fewer games than the
  // slip has legs — that is the NFL's ceiling, not a construction choice.
  check(
    maxPerGame === 1 || p.size > gamesAvailable,
    `one leg per game unless the slate has fewer games than legs (max ${maxPerGame}/game, ${gamesAvailable} games, ${p.size} legs)`,
  );
  check(p.legs.filter((l) => l.belowFloor).length === p.belowFloor, "below-floor legs are counted");
  check(maxPerGame <= 2, "never more than two legs from one game");
  check(
    p.legs.every((l, i) => i === 0 || p.legs[i - 1].prob >= l.prob),
    "legs ordered surest first",
  );
  const product = p.legs.reduce((a, l) => a * l.prob, 1);
  check(
    Math.abs(product - p.combinedProb) < 1e-12,
    "stated probability is the product of its legs",
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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
