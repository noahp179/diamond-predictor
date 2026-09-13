/**
 * Invariants of the forward ledgers, checked against live ESPN.
 *
 * These are the failures that do not announce themselves. A ledger that
 * records nothing looks exactly like a sport with no games on; a ledger that
 * records a finished game looks exactly like a good prediction. Both have
 * already happened here — see the `state` comment in espn.server.ts — so they
 * get a test rather than a code comment.
 *
 *   bun scripts/test-td-ledger.ts
 *
 * No database required: the write paths no-op without a service-role key, and
 * that is itself one of the things checked.
 */
import { predictSlate } from "../src/lib/espn.server";
import { cfbTdSlate } from "../src/lib/cfb-td.server";
import { readTdLedger, canTrackTd, TD_CLAIM } from "../src/lib/td-ledger.server";

const PAST = "2026-09-12"; // a played Saturday
const UPCOMING = "2026-09-19"; // a scheduled one

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

// --- the game-outcome ledger's eligibility filter
const past = await predictSlate("cfb", PAST);
const upcoming = await predictSlate("cfb", UPCOMING);
const pastPre = past.games.filter((g) => g.state === "pre").length;
const upcomingPre = upcoming.games.filter((g) => g.state === "pre").length;
console.log(
  `game ledger — ${PAST}: ${pastPre}/${past.games.length} recordable; ` +
    `${UPCOMING}: ${upcomingPre}/${upcoming.games.length} recordable`,
);
check(pastPre === 0, "a finished slate contributes no game predictions");
check(upcomingPre === upcoming.games.length, "an upcoming slate is fully recordable");
check(
  past.games.every((g) => g.homeScore != null),
  "finished games carry a score",
);
check(
  upcoming.games.every((g) => g.homeScore == null),
  "scheduled games carry no score (ESPN's placeholder '0' is not one)",
);

// --- the touchdown ledger's eligibility filter
const tdPast = await cfbTdSlate(PAST);
const tdUpcoming = await cfbTdSlate(UPCOMING);
const eligible = tdUpcoming.games.filter((g) => !g.started);
const picks = eligible.reduce((n, g) => n + g.picks.length, 0);
console.log(
  `\ntd ledger — ${PAST}: ${tdPast.games.filter((g) => !g.started).length} recordable; ` +
    `${UPCOMING}: ${eligible.length} games / ${picks} picks recordable`,
);
check(
  tdPast.games.every((g) => g.started),
  "a finished slate contributes no touchdown picks",
);
check(eligible.length > 0 && picks > 0, "an upcoming slate yields picks to record");
check(
  eligible.every((g) => g.picks.length >= 1 && g.picks.length <= 2),
  "each recorded game carries one or two picks",
);
check(
  eligible.every((g) => g.picks.every((p) => p.playerId && /^\d+$/.test(p.playerId))),
  "every pick carries a numeric ESPN athlete id to settle on",
);

// --- degrading without a database
const led = await readTdLedger("cfb");
console.log(`\nno-database read — status "${led.status}", ${led.summary.n} settled`);
check(canTrackTd() === false, "writes are disabled without a service-role key");
check(led.summary.n === 0 && led.recent.length === 0, "the read degrades to an empty record");
check(led.claim.anyHit === TD_CLAIM.cfb.anyHit, "the backtest claim still travels with it");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
