#!/usr/bin/env node
/**
 * The tracking settler's result lookups, against live ESPN.
 *
 * Settlement reads each date's scoreboard rather than rebuilding the model's
 * slate (see resultsFor in tracking.server.ts). This checks that every sport's
 * lookup still finds finished events on a date that certainly had them, and
 * that the outcome codes are the ledger's ("a" = home / player A, "b" = away /
 * player B, "draw").
 *
 * Run:  npx tsx scripts/test-settle.ts
 */
import { resultsFor } from "../src/lib/tracking.server";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const cases: [string, string, string, number][] = [
  ["soccer", "epl", "2026-09-13", 1],
  ["soccer", "ucl", "2026-09-09", 6],
  ["tennis", "wta", "2026-09-28", 5],
  ["tennis", "atp", "2026-09-30", 5],
  ["nfl", "nfl", "2026-10-04", 10],
  ["cfb", "cfb", "2026-10-03", 30],
];

for (const [sport, division, date, atLeast] of cases) {
  try {
    const t0 = Date.now();
    const r = await resultsFor(sport, division, date);
    const codes = new Set([...r.values()].map((o) => o.result));
    const valid = [...codes].every((c) => c === "a" || c === "b" || c === "draw");
    check(
      `${sport}/${division} ${date}: ${r.size} finished events in ${Date.now() - t0}ms`,
      r.size >= atLeast && valid && (sport === "soccer" || !codes.has("draw")),
      `codes ${[...codes].join(",")}`,
    );
  } catch (err) {
    check(`${sport}/${division} ${date}`, false, String(err));
  }
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
