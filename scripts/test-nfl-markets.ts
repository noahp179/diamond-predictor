/**
 * Proves the TypeScript 2+ and first-TD models agree with the Python that fitted
 * them, and that their shipped constants are internally consistent.
 *
 *   bun scripts/test-nfl-markets.ts
 */
import {
  inferMarket,
  marketSelfTest,
  MARKET_SIZES,
  MARKET_FLOOR,
  MARKET_MAX_PER_GAME,
  MARKET_EVIDENCE,
  MARKET_HELDOUT,
} from "../src/lib/nfl-td-markets";
import parity from "../src/lib/nfl-td-markets.parity.json";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

for (const market of ["td1", "td2"] as const) {
  const h = MARKET_HELDOUT[market];
  console.log(`\n=== ${market} ===`);
  console.log(
    `  held out: top-1 ${(h.top1 * 100).toFixed(1)}% of ${h.games} games, ` +
      `auc ${h.auc.toFixed(4)}, ece ${h.ece.toFixed(4)}, base ${(h.base_rate * 100).toFixed(2)}%`,
  );

  const cases = parity.cases[market];
  let worst = 0;
  for (const c of cases) worst = Math.max(worst, Math.abs(inferMarket(market, c.x) - c.p));
  const lo = Math.min(...cases.map((c) => c.p));
  const hi = Math.max(...cases.map((c) => c.p));
  console.log(
    `  parity: ${cases.length} vectors, p ${lo.toFixed(3)}..${hi.toFixed(3)}, ` +
      `worst disagreement ${worst.toExponential(2)}`,
  );
  check(worst < 1e-9, `${market} matches the Python fit`);

  // sizes are 5 and 10 only — 15 and 20 are meaningless at these base rates
  check(
    MARKET_SIZES[market].join(",") === "5,10",
    `${market} offers 5 and 10 legs only (got ${MARKET_SIZES[market].join(", ")})`,
  );
  // a longer slip must not demand a HIGHER floor than a shorter one, or it
  // becomes unbuildable on a slate the short one fills
  check(
    MARKET_FLOOR[market][10] <= MARKET_FLOOR[market][5],
    `${market} floor does not rise with size (${MARKET_FLOOR[market][5]} then ${MARKET_FLOOR[market][10]})`,
  );
  // every size the market offers must carry evidence, or the card quotes nothing
  check(
    MARKET_SIZES[market].every((s) => MARKET_EVIDENCE[market][String(s)] != null),
    `${market} carries backtest evidence at every size it offers`,
  );
  const ev = MARKET_EVIDENCE[market];
  for (const s of MARKET_SIZES[market]) {
    const e = ev[String(s)];
    console.log(
      `    ${String(s).padStart(2)} legs: 1 in ${e.oneIn.toLocaleString()}, ` +
        `${e.won} of ${e.slips} held-out weeks (${e.expected.toFixed(4)} expected)`,
    );
    // a zero that the backtest could never have produced is not evidence of
    // failure, and the card must be able to say so
    check(
      e.won > 0 || e.expected < 1,
      `${market} ${s}-leg: observed ${e.won} is consistent with ${e.expected.toFixed(3)} expected`,
    );
  }
}

// first TD allows exactly one leg per game, and that is structural: only one
// player can score a game's first touchdown, so two legs from one game is an
// impossible slip rather than a correlated one.
console.log("");
check(MARKET_MAX_PER_GAME.td1 === 1, "first TD is capped at one leg per game");
check(MARKET_MAX_PER_GAME.td2 === 2, "2+ TD allows two legs per game");

const built = marketSelfTest();
console.log(`\nbuilt-in self-test: ${built.n} vectors, worst ${built.worst.toExponential(2)}`);
check(built.ok, "built-in self-test vectors reproduce");

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
