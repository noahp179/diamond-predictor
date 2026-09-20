/**
 * Invariants of the parlay ledger, checked against live ESPN.
 *
 * THE FAILURE THIS EXISTS FOR IS SILENT. A slip settles by looking each leg up
 * in player_predictions on (event_id, player_id). If the parlay builder draws
 * from a wider cut of the board than the pick ledger records — say the ledger
 * keeps the top three NFL names and the slip takes a fourth — that leg is
 * never found, the slip never settles, and the page shows a growing "pending"
 * column with no error anywhere. Nothing throws. Nothing logs. The record just
 * quietly never fills.
 *
 * So the check is: every leg of every slip must be a pick the ledger writes.
 *
 *   bun scripts/test-parlay-ledger.ts [YYYY-MM-DD]
 */
import { readParlayLedger, canTrackParlays, PARLAY_MARKET } from "../src/lib/parlay-ledger.server";
import { buildTdParlays, PARLAY_SIZES, DEFAULT_MAX_PER_GAME } from "../src/lib/td-parlay";
import type { ParlayCandidate } from "../src/lib/td-parlay";
import { nextPlayableDate } from "../src/lib/espn.server";
import { todayET } from "../src/lib/date";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

const asked = process.argv[2] ?? todayET();

for (const sport of ["cfb", "nfl"] as const) {
  const want = Math.ceil(Math.max(...PARLAY_SIZES) / DEFAULT_MAX_PER_GAME);
  const { date } = await nextPlayableDate(sport, asked, want);

  // Exactly the two cuts the two writers use. If these ever drift apart the
  // slips stop settling, so they are built here side by side on purpose.
  const cands: ParlayCandidate[] = [];
  const ledgerKeys = new Set<string>();
  if (sport === "cfb") {
    const { cfbTdSlate } = await import("../src/lib/cfb-td.server");
    const { games } = await cfbTdSlate(date);
    for (const g of games) {
      if (g.started) continue;
      for (const p of g.picks) {
        ledgerKeys.add(`${g.gameId}:${p.playerId}`); // snapshotTdPicks writes all
        cands.push({
          playerId: p.playerId, player: p.player, position: p.position, team: p.team,
          gameId: g.gameId, matchup: g.matchup, prob: p.prob, tier: p.tier,
          tierHit: p.tierHit, reasons: p.reasons, against: p.against,
        });
      }
    }
  } else {
    const { tdScorersSlate } = await import("../src/lib/nfl-td.server");
    const { games } = await tdScorersSlate(date);
    for (const g of games) {
      if (g.started) continue;
      for (const p of g.picks.slice(0, 3)) {
        ledgerKeys.add(`${g.gameId}:${p.playerId}`); // snapshotTdPicks writes the top 3
        cands.push({
          playerId: p.playerId, player: p.player, position: null, team: p.team,
          gameId: g.gameId, matchup: g.matchup, prob: p.prob, tier: null,
          tierHit: null, reasons: p.reasons, against: p.against,
        });
      }
    }
  }

  console.log(`\n=== ${sport.toUpperCase()} ${date} — ${cands.length} candidates ===`);
  if (cands.length === 0) {
    console.log("  (no slate to build from; skipping)");
    continue;
  }

  const slips = buildTdParlays(cands, PARLAY_SIZES, DEFAULT_MAX_PER_GAME, sport);
  let orphan = 0;
  for (const p of slips) {
    if (p.legs.length === 0) continue;
    for (const l of p.legs) if (!ledgerKeys.has(`${l.gameId}:${l.playerId}`)) orphan++;
    console.log(
      `  ${String(p.size).padStart(2)} legs: ${p.legs.length} filled  ` +
        `1 in ${p.oneIn.toLocaleString()}  corr ${p.correlationFactor.toFixed(3)}`,
    );
  }
  check(orphan === 0, `every slip leg is a pick the ledger records (${orphan} orphaned)`);

  const written = slips.filter((p) => p.legs.length > 0);
  check(written.length > 0, "at least one slip is recordable");
  check(
    written.every((p) => p.adjustedProb > 0 && p.adjustedProb <= 1),
    "every stated probability is a probability",
  );
  check(
    written.every((p) => p.adjustedProb <= p.combinedProb + 1e-12),
    "the correlation correction never flatters a slip",
  );
  // The unique key is (model_version, slate_date, market, size, max_per_game),
  // so two slips of the same size on one slate would collide and the second
  // would be silently dropped by ignoreDuplicates.
  check(
    new Set(written.map((p) => p.size)).size === written.length,
    "one slip per size, so nothing collides on the unique key",
  );
}

// --- the read path without a database
console.log("\n=== no-database read ===");
const view = await readParlayLedger("cfb");
check(!canTrackParlays(), "writes are disabled without a service-role key");
check(
  view.status === "ok" || view.status === "not-provisioned" || view.status === "unreadable",
  `the read reports a known status (got "${view.status}")`,
);
check(view.totals.slips === 0, "an unreadable/empty ledger claims no settled slips");
check(PARLAY_MARKET === "anytime_td", "the recorded market is the anytime board");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
if (failures) process.exitCode = 1;
