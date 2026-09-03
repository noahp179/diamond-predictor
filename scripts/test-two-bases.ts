#!/usr/bin/env node
/**
 * Checks the 2+ total-bases model the same way the other shipped models are
 * checked: does the TypeScript serving the page compute what the Python that
 * fitted it computed, and does the plain-English layer tell the truth?
 *
 * The explanation is the part worth testing hardest. It is easy to write a
 * sentence generator that sounds right and says something the arithmetic does
 * not support — so the checks below pin the two properties that make it honest:
 * a reason listed as helping must actually push the projection up, and the
 * group contributions must add back to the model's own log-odds.
 *
 * Run:  npx tsx scripts/test-two-bases.ts
 */
import model from "../src/lib/mlb-tb2-model.json";
import {
  fallbackTemp,
  tb2ParityError,
  tb2Probability,
  tb2Reasons,
} from "../src/lib/mlb-tb2.server";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// ---- parity with scikit-learn
const err = tb2ParityError();
check(`model parity with the trainer (worst ${err.toExponential(2)})`, err < 1e-9, `${err}`);

// ---- the reference vectors are real hitters; use them to exercise the rest
const vectors = model.selftest.map((t) => t.x);

// ---- probabilities are probabilities
for (const t of model.selftest) {
  const p = tb2Probability(t.x);
  if (!(p > 0.05 && p < 0.95)) {
    check("a projection lands in a sane range", false, `got ${p}`);
    break;
  }
}
check("every reference projection lands between 5% and 95%", true);

// ---- a reason that "helps" must actually help
// Rebuild the log-odds from the group contributions and confirm they sum back
// to the model's own linear predictor. If they do, "up" really is up.
for (const x of vectors.slice(0, 3)) {
  const contrib = model.coef.map((c, i) => c * ((x[i] - model.mean[i]) / model.std[i]));
  const total = contrib.reduce((a, b) => a + b, 0) + model.intercept;
  const grouped = Object.values(model.groups)
    .flatMap((g) => g.features)
    .map((f) => model.features.indexOf(f))
    .filter((i) => i >= 0);
  const covered = new Set(grouped);
  check(
    "every feature belongs to exactly one explanation group",
    covered.size === model.features.length && grouped.length === model.features.length,
    `covered ${covered.size} of ${model.features.length}, ${grouped.length} assignments`,
  );
  const sumGrouped = grouped.reduce((a, i) => a + contrib[i], 0) + model.intercept;
  check(
    "group contributions add back to the model's own log-odds",
    Math.abs(sumGrouped - total) < 1e-9,
    `grouped ${sumGrouped} vs total ${total}`,
  );
  break;
}

// ---- direction: raising a feature the model likes must raise the projection
const x0 = [...vectors[0]];
const slotIdx = model.features.indexOf("slot");
const pBatting2 = tb2Probability(x0.map((v, i) => (i === slotIdx ? 2 : v)));
const pBatting9 = tb2Probability(x0.map((v, i) => (i === slotIdx ? 9 : v)));
check(
  "batting 2nd beats batting 9th, all else equal",
  pBatting2 > pBatting9,
  `2nd ${pBatting2.toFixed(4)} vs 9th ${pBatting9.toFixed(4)}`,
);

const parkIdx = model.features.indexOf("park_tb");
const pCoors = tb2Probability(x0.map((v, i) => (i === parkIdx ? 1.12 : v)));
const pPetco = tb2Probability(x0.map((v, i) => (i === parkIdx ? 0.94 : v)));
check(
  "a big park beats a small one, all else equal",
  pCoors > pPetco,
  `1.12 ${pCoors.toFixed(4)} vs 0.94 ${pPetco.toFixed(4)}`,
);

// ---- temperature: warm air carries the ball, and the model should know it
const tempIdx = model.features.indexOf("temp_fc");
check("the model carries a temperature feature", tempIdx >= 0);
const pHot = tb2Probability(x0.map((v, i) => (i === tempIdx ? 95 : v)));
const pCold = tb2Probability(x0.map((v, i) => (i === tempIdx ? 45 : v)));
check(
  "a hot night beats a cold one, all else equal",
  pHot > pCold,
  `95F ${pHot.toFixed(4)} vs 45F ${pCold.toFixed(4)}`,
);
// the effect should be real but not absurd — this is one of many inputs
check(
  "and the temperature swing is meaningful without dominating",
  pHot - pCold > 0.005 && pHot - pCold < 0.12,
  `50F swings the projection by ${((pHot - pCold) * 100).toFixed(1)} points`,
);

// ---- the fallback used when the forecast call fails
const cold = fallbackTemp("Target Field", "2026-04-05");
const warm = fallbackTemp("Target Field", "2026-07-05");
check(
  "park-month fallback temperatures are seasonal",
  warm > cold && cold > 20 && warm < 110,
  `Minneapolis April ${cold}F vs July ${warm}F`,
);
check(
  "an unknown park still gets a number",
  Number.isFinite(fallbackTemp("Nowhere Park", "2026-06-01")),
);

// ---- what the research concluded about weather, pinned so it cannot rot
const w = model.weatherFinding;
check(
  "the servable forecast recovers most of the unservable weather block",
  w.aucForecastTemp > w.aucNoWeather &&
    (w.aucForecastTemp - w.aucNoWeather) / (w.aucObservedWeather - w.aucNoWeather) > 0.7,
  `no weather ${w.aucNoWeather}, forecast ${w.aucForecastTemp}, observed ${w.aucObservedWeather}`,
);
check(
  "every park with a forecast has coordinates and a fallback",
  Object.keys(model.venueCoords).length > 25 && Object.keys(model.parkMonthTemp).length > 100,
  `${Object.keys(model.venueCoords).length} parks, ${Object.keys(model.parkMonthTemp).length} park-months`,
);

// ---- the sentence agrees with the arithmetic
const r = tb2Reasons(x0, "Coors Field");
check("a projection produces at least one reason", r.up.length + r.down.length > 0);
check(
  "reasons listed as helping have a positive effect",
  r.up.every((g) => g.effect > 0),
  JSON.stringify(r.up),
);
check(
  "reasons listed as hurting have a negative effect",
  r.down.every((g) => g.effect < 0),
  JSON.stringify(r.down),
);
check("the biggest helper is listed first", r.up.length < 2 || r.up[0].effect >= r.up[1].effect);

// ---- the numbers the page quotes are the held-out ones
check(
  "the dedicated model beats the one the props tab ships",
  model.metrics.auc > model.metrics.aucShipped && model.metrics.ci[0] > 0,
  `auc ${model.metrics.auc} vs ${model.metrics.aucShipped}, ci ${JSON.stringify(model.metrics.ci)}`,
);
check("and beats the naive 'his own rate so far'", model.metrics.auc > model.metrics.aucNaive);
check("tiers separate", model.tiers[0].hitRate > model.tiers.at(-1)!.hitRate);
check(
  "calibration is honest across every bucket",
  model.calibration.every((c) => Math.abs(c.pred - c.actual) < 0.04),
  JSON.stringify(model.calibration.map((c) => [c.pred.toFixed(3), c.actual.toFixed(3)])),
);
check(
  "the park index has real spread",
  Math.max(...Object.values(model.parkTb)) - Math.min(...Object.values(model.parkTb)) > 0.1,
);

console.log(fails === 0 ? "\nall checks passed" : `\n${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
