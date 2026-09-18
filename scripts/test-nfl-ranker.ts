/**
 * Proves the TypeScript ranker agrees with the Python that fitted it.
 *
 * Eighteen weights, two Platt constants, a shrink and a standardizer crossed a
 * language boundary as decimal text. None of the ways that goes wrong throw: a
 * transposed feature, a mean paired with the wrong scale, a shrink applied
 * before the sigmoid instead of after — each returns a plausible percentage for
 * the wrong player, and every page downstream looks healthy.
 *
 * So the port is held to 500 real feature vectors spanning the whole
 * probability range, not just the three baked into the artefact. Three rows can
 * agree by coincidence when two adjacent features are swapped; 500 cannot.
 *
 *   bun scripts/test-nfl-ranker.ts
 */
import { inferRanker, rankerSelfTest, FEATURES, HELDOUT } from "../src/lib/nfl-td-ranker";
import parity from "../src/lib/nfl-td-ranker.parity.json";

console.log(`nfl-td ranker: ${FEATURES.length} features, linear in within-game differences`);
console.log(
  `  held out: top-1 ${(HELDOUT.top1 * 100).toFixed(1)}% of ${HELDOUT.games} games, ` +
    `ece ${HELDOUT.ece.toFixed(4)}`,
);
console.log(
  `  lead picks: stated ${(HELDOUT.lead_stated * 100).toFixed(1)}%, ` +
    `actual ${(HELDOUT.lead_actual * 100).toFixed(1)}%`,
);

const built = rankerSelfTest();
console.log(`  built-in self-test: worst disagreement ${built.worst.toExponential(2)}`);

// The feature ORDER is the thing a swap would break, so check it explicitly
// rather than inferring it from the probabilities agreeing.
if (parity.features.join("|") !== FEATURES.join("|")) {
  console.error("FAIL — parity set feature order does not match the shipped model.");
  process.exit(1);
}

let worst = 0;
let worstCase = -1;
for (let i = 0; i < parity.cases.length; i++) {
  const d = Math.abs(inferRanker(parity.cases[i].x) - parity.cases[i].p);
  if (d > worst) {
    worst = d;
    worstCase = i;
  }
}
const lo = Math.min(...parity.cases.map((c) => c.p));
const hi = Math.max(...parity.cases.map((c) => c.p));
console.log(
  `  parity: ${parity.cases.length} vectors, p ${lo.toFixed(3)}..${hi.toFixed(3)}, ` +
    `worst disagreement ${worst.toExponential(2)} (case ${worstCase})`,
);

if (!built.ok || worst > 1e-9) {
  console.error("FAIL — the TypeScript port does not match the fitted ranker.");
  process.exit(1);
}
console.log("  OK — the port matches the fit.");
