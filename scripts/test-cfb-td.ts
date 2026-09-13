/**
 * Proves the TypeScript touchdown model agrees with the Python that fitted it.
 *
 * src/lib/cfb-td-model.json carries three feature vectors and the probability
 * research/cfb/final.py produced for each. A porting slip — a coefficient out
 * of order, a standardization applied to the wrong column — still returns a
 * perfectly plausible-looking probability, so nothing about the page would
 * look wrong. This is what catches it.
 *
 *   bun scripts/test-cfb-td.ts
 */
import { selfTest } from "../src/lib/cfb-td.server";
import model from "../src/lib/cfb-td-model.json";

const { ok, worst } = selfTest();
console.log(`cfb-td model self-test: ${model.selftest.length} vectors`);
console.log(`  worst absolute disagreement with Python: ${worst.toExponential(2)}`);
if (!ok) {
  console.error("FAIL — the TypeScript port does not match the fitted model.");
  process.exit(1);
}
console.log("  OK — the port matches the fit.");

// The feature list is the contract between features.py and featureVector();
// importing the module at all runs assertFeatureOrder, so reaching here means
// the two agree on order as well as on arithmetic.
console.log(`  feature order verified: ${model.features.length} features`);
