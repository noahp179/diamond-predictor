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
import { addDays, todayET } from "../src/lib/date";

/**
 * Both dates are DERIVED, not written down.
 *
 * They used to be two hardcoded Saturdays, and the test duly started failing
 * the morning the "upcoming" one became yesterday: 4 of 71 college games still
 * counted as recordable and the scheduled-games-carry-no-score check flipped.
 * That is a fixture rotting, not a regression, and a test that cries wolf on a
 * calendar roll gets ignored exactly when it matters.
 *
 * College plays Saturdays, so the next one is the slate that is reliably still
 * scheduled, and the one a fortnight back is reliably finished.
 */
function nextSaturday(from: string): string {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(from, i);
    const [y, m, day] = d.split("-").map(Number);
    if (new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay() === 6) return d;
  }
  return addDays(from, 7);
}

const UPCOMING = nextSaturday(todayET()); // a scheduled Saturday
const PAST = addDays(UPCOMING, -14); // one that finished a fortnight ago

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
