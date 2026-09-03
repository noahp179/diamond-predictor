#!/usr/bin/env node
/**
 * Checks the team-stack model the way the props model is checked: does the
 * TypeScript that serves the page compute the same numbers the Python that
 * fitted it did?
 *
 * Three things have to hold, or the Team Stacks page is quoting a model nobody
 * backtested:
 *
 *   1. the logistic team totals and the runs regression reproduce the reference
 *      vectors scikit-learn shipped in the model file,
 *   2. the Gaussian copula reproduces the reference stacks — a different normal
 *      CDF here than in scipy, so this is the one that could drift,
 *   3. the copula leaves the marginals alone. That is the whole reason it is
 *      safe to bolt onto two models fitted one leg at a time: correlating the
 *      legs must not change what any single leg is worth.
 *
 * Run:  npx tsx scripts/test-stacks.ts
 */
import model from "../src/lib/mlb-stacks-model.json";
import { stackMatrix, stackProb, stacksParityError } from "../src/lib/mlb-stacks.server";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---- 1 + 2: parity with the trainer
const err = stacksParityError();
check(
  `model parity with scikit-learn and scipy (worst ${err.toExponential(2)})`,
  err < 1e-4,
  `worst disagreement ${err}`,
);

// ---- 3: the copula moves the joint, never the marginals
const R2 = stackMatrix(1, true);
for (const p of [0.12, 0.35, 0.5, 0.81]) {
  check(`a one-leg stack is just its own probability (${p})`, near(stackProb([p], R2), p, 1e-12));
}
// Two legs with rho: the joint has to sit between the independent product and
// the smaller marginal, and it has to be strictly above the product.
for (const [a, b] of [
  [0.42, 0.35],
  [0.6, 0.2],
  [0.9, 0.9],
]) {
  const joint = stackProb([a, b], R2);
  check(
    `team+bat ${a}/${b} lands between independence and the shorter leg`,
    joint > a * b && joint < Math.min(a, b),
    `joint ${joint}, product ${a * b}, min ${Math.min(a, b)}`,
  );
}

// Zero correlation must collapse exactly to independence.
const I = [
  [1, 0],
  [0, 1],
];
check("rho = 0 is independence", near(stackProb([0.42, 0.35], I), 0.42 * 0.35, 1e-6));

// The measured correlations, in the order the research found them.
const { hitterHitter, teamHitter } = model.correlation;
check(
  "hitter-to-hitter correlation is the weak one",
  hitterHitter < teamHitter / 3,
  `hitter-hitter ${hitterHitter}, team-hitter ${teamHitter}`,
);
const pair = [0.42, 0.35];
const teamJoint = stackProb(pair, stackMatrix(1, true));
const batJoint = stackProb(pair, stackMatrix(2, false));
check(
  "a team total + a bat beats two bats at the same prices",
  teamJoint > batJoint,
  `team+bat ${teamJoint}, bat+bat ${batJoint}`,
);

// ---- adding a leg can only make a stack shorter
const R3 = stackMatrix(2, true);
const three = stackProb([0.42, 0.35, 0.31], R3);
check("a third leg lowers the price", three < teamJoint, `three ${three}, two ${teamJoint}`);

// ---- the numbers the page quotes are the held-out ones
const v = model.correlation.verification.team_hitter;
check(
  "the two-leg card was verified out of sample",
  Math.abs(v.modelError) < 0.05 && Math.abs(v.indepError) > 0.15,
  `model ${(v.modelError * 100).toFixed(1)}%, independence ${(v.indepError * 100).toFixed(1)}%`,
);
check("card tiers separate", model.card.tiers[0].hitRate > model.card.tiers.at(-1)!.hitRate);
check(
  "hitters on the night's best offences clear the field",
  model.gate.top1 > model.gate.all,
  `top-1 ${model.gate.top1}, all ${model.gate.all}`,
);

console.log(fails === 0 ? "\nall checks passed" : `\n${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
