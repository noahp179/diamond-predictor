/**
 * Proves the TypeScript forest agrees with the Python that fitted it.
 *
 * A misread offset, a uint16 overflow, an unaligned typed array — none of these
 * throw. They return a plausible probability for the wrong leaf, and every page
 * downstream looks healthy. This is what catches them.
 *
 *   bun scripts/test-cfb-forest.ts
 */
import { forestSelfTest, FOREST_FEATURES, FOREST_HOLDOUT } from "../src/lib/cfb-td-forest";
import model from "../src/lib/cfb-td-forest.json";

const { ok, worst, n } = forestSelfTest();
console.log(
  `cfb-td forest: ${model.trees.n_trees} trees, ${model.trees.total_nodes.toLocaleString()} nodes`,
);
console.log(`  features: ${FOREST_FEATURES.length}`);
console.log(
  `  held out: top-1 ${(FOREST_HOLDOUT.top1 * 100).toFixed(2)}%, ece ${FOREST_HOLDOUT.ece}`,
);
console.log(`  self-test: ${n} vectors, worst disagreement ${worst.toExponential(2)}`);
if (!ok) {
  console.error("FAIL — the TypeScript port does not match the fitted forest.");
  process.exit(1);
}
console.log("  OK — the port matches the fit.");
