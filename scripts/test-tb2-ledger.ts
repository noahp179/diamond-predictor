#!/usr/bin/env node
/**
 * The 2+ bases ledgers, against a live slate.
 *
 * THE CHECK THIS EXISTS FOR is the last one: every leg of every slip the parlay
 * ledger freezes must have a row in the pick ledger. settleParlays scores a
 * slip by joining its legs on (event_id, player_id), so a leg with no pick row
 * is a slip that can never be scored — and it does not fail, it waits, which is
 * the worst way for a record to be wrong. Football gets this for free because
 * its slips draw from the same three names per game the card shows. Baseball's
 * draw from the whole slate, so the pick ledger has to record deeper than the
 * card and this is what proves it does.
 *
 * The first check exists because getting it wrong once already cost ten points
 * of phantom underperformance on the NFL board: the claim a live ledger is
 * measured against must be the CARD's claim, not a stronger selection's.
 *
 *   npx tsx scripts/test-tb2-ledger.ts [YYYY-MM-DD]
 */
import { twoBaseParlayCandidates } from "../src/lib/mlb-tb2.server";
import { buildTdParlay, SIZE_CAP } from "../src/lib/td-parlay";
import {
  TB2_CLAIM,
  TB2_MARKET,
  TB2_MODEL_VERSION,
  readTb2Ledger,
} from "../src/lib/tb2-ledger.server";
import { PARLAY_MARKET_FOR } from "../src/lib/parlay-ledger.server";
import { todayET } from "../src/lib/date";
import model from "../src/lib/mlb-tb2-model.json";
import claim from "../research/mlb-tb2/board_claim_tb2.json";

const SIZES = [5, 10, 15];
const SHOWN_PER_GAME = 3;
const date = process.argv[2] ?? todayET();

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// ---- the claim the live record is measured against
console.log("=== what the board claims");
check(
  "the claim is the card's, measured on the held-out season",
  TB2_CLAIM.leadHit === claim.leadHit &&
    TB2_CLAIM.anyHit === claim.anyHit &&
    TB2_CLAIM.gameHit === claim.gameHit,
  `claim ${JSON.stringify(TB2_CLAIM)} vs ${JSON.stringify(claim)}`,
);
// The model file's top1/top3 are the best one and three hitters on the WHOLE
// SLATE — a far stronger selection than the best three in one game, and the
// numbers differ by ten points. Quoting them as the card's claim would hold the
// ledger to a bar the card never cleared.
check(
  "the claim is NOT the model file's slate-wide top-N",
  Math.abs(TB2_CLAIM.leadHit - model.metrics.top1) > 0.05 &&
    Math.abs(TB2_CLAIM.anyHit - model.metrics.top3) > 0.05,
  `card lead ${TB2_CLAIM.leadHit.toFixed(3)} vs slate top1 ${model.metrics.top1.toFixed(3)}`,
);
check(
  "a card hit rate beats the base rate, and the card beats one name",
  TB2_CLAIM.anyHit > claim.base && TB2_CLAIM.gameHit > TB2_CLAIM.leadHit,
  `any ${TB2_CLAIM.anyHit.toFixed(3)} > base ${claim.base.toFixed(3)}; ` +
    `game ${TB2_CLAIM.gameHit.toFixed(3)} > lead ${TB2_CLAIM.leadHit.toFixed(3)}`,
);
check(
  "the slip ledger records baseball under its own market",
  PARLAY_MARKET_FOR.mlb === TB2_MARKET && PARLAY_MARKET_FOR.nfl !== TB2_MARKET,
  `mlb=${PARLAY_MARKET_FOR.mlb} nfl=${PARLAY_MARKET_FOR.nfl}`,
);
check("the model version is stamped", TB2_MODEL_VERSION.length > 0, TB2_MODEL_VERSION);

// ---- the recorded rows, against a live slate
console.log(`\n=== ${date}: what a snapshot would write`);
const { slate, candidates } = await twoBaseParlayCandidates(date);
const liveGames = new Set(candidates.map((c) => c.gameId));
console.log(
  `    ${candidates.length} hitters across ${liveGames.size} unstarted games ` +
    `(slate carries ${slate.games})`,
);

if (candidates.length === 0) {
  console.log("    no unstarted games today — nothing to check against a live slate");
  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

// Rebuild exactly what snapshotTb2Picks writes: the card, plus every slip leg.
const legKeys = new Set<string>();
for (const size of SIZES) {
  const slip = buildTdParlay(candidates, size, SIZE_CAP.mlb?.[size] ?? Infinity, "mlb");
  for (const l of slip.legs) legKeys.add(`${l.gameId}:${l.playerId}`);
}
const written = new Set<string>();
let cardRows = 0;
let deepRows = 0;
for (const g of slate.byGame) {
  if (!liveGames.has(g.gameId)) continue;
  g.picks.forEach((p, i) => {
    const key = `${g.gameId}:${p.playerId}`;
    if (i + 1 > SHOWN_PER_GAME && !legKeys.has(key)) return;
    written.add(key);
    if (i + 1 <= SHOWN_PER_GAME) cardRows += 1;
    else deepRows += 1;
  });
}
console.log(`    ${cardRows} card rows + ${deepRows} deeper rows needed by slips`);

const missing = [...legKeys].filter((k) => !written.has(k));
check(
  "every slip leg has a pick row to settle against",
  missing.length === 0,
  missing.length ? `${missing.length} legs with no row: ${missing.slice(0, 5).join(", ")}` : "",
);
check(
  "the card is recorded for every unstarted game",
  cardRows ===
    [...liveGames].reduce((n, id) => {
      const g = slate.byGame.find((x) => x.gameId === id);
      return n + Math.min(SHOWN_PER_GAME, g?.picks.length ?? 0);
    }, 0),
  `${cardRows} card rows over ${liveGames.size} games`,
);
check(
  "no row comes from a game already under way",
  [...written].every((k) => liveGames.has(Number(k.split(":")[0]))),
);
check(
  "deeper rows exist only because a slip needs them",
  deepRows <= legKeys.size,
  `${deepRows} deeper rows, ${legKeys.size} distinct slip legs`,
);

// ---- the read path
console.log("\n=== reading the ledger back");
const led = await readTb2Ledger();
check(
  "the ledger reports a state rather than guessing",
  ["ok", "not-provisioned", "unreadable"].includes(led.status),
  `status=${led.status}, writable=${led.writable}`,
);
check("it carries the card's claim", led.claim.anyHit === TB2_CLAIM.anyHit);
check("counts are called by baseball's name", led.countLabel === "total bases", led.countLabel);
if (led.status === "ok" && led.summary.n > 0) {
  console.log(
    `    ${led.summary.n} settled, ${led.summary.hits} hits ` +
      `(${((led.summary.hitRate ?? 0) * 100).toFixed(1)}%), ` +
      `${led.summary.pending} pending, ${led.summary.voided} void`,
  );
  check(
    "no settled pick is ranked deeper than the card",
    led.recent.every((r) => r.rank <= SHOWN_PER_GAME),
    `deepest rank ${Math.max(...led.recent.map((r) => r.rank))}`,
  );
} else {
  console.log(`    nothing settled yet (status ${led.status}) — shape checked, record empty`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
