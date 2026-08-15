#!/usr/bin/env node
/**
 * Checks the ledger's scoring arithmetic and its behaviour with no database.
 *
 * The scoring is the part that must be right: every number on a Track Record
 * page is an average of these, and a wrong Brier or a mis-ordered RPS would be
 * invisible on the page while quietly making the model look better or worse
 * than it is. The values below are computed by hand in the comments rather than
 * copied from the implementation, so this is a check and not a mirror.
 *
 * The no-database case matters too: the ledger reads through the public
 * Supabase client, which throws when its environment variables are absent. A
 * Track Record page must render an honest empty state in that situation rather
 * than a 500.
 *
 * Run:  npx tsx scripts/test-tracking.ts
 */
import { readLedger, scoreOutcome } from "../src/lib/tracking.server";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}
const near = (a: number | null, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// ---------------------------------------------------------- three-way (soccer)

// P = (0.5 home, 0.3 draw, 0.2 away), home wins.
//   Brier = (0.5-1)^2 + (0.3-0)^2 + (0.2-0)^2 = 0.25 + 0.09 + 0.04 = 0.38
//   log loss = -ln(0.5) = 0.6931471805599453
//   RPS: cumulative P = (0.5, 0.8); cumulative truth = (1, 1)
//        = (0.5-1)^2 + (0.8-1)^2 = 0.25 + 0.04 = 0.29
{
  const s = scoreOutcome({ a: 0.5, draw: 0.3, b: 0.2 }, "a");
  check("3-way Brier is the multiclass sum", near(s.brier, 0.38), `${s.brier}`);
  check(
    "3-way log loss is -ln(p of what happened)",
    near(s.logLoss, -Math.log(0.5)),
    `${s.logLoss}`,
  );
  check("3-way RPS uses cumulative probabilities", near(s.rps, 0.29), `${s.rps}`);
}

// Same probabilities, AWAY wins — RPS must punish this more than a draw, because
// the outcomes are ordered home > draw > away and the model leaned to the wrong end.
{
  const away = scoreOutcome({ a: 0.5, draw: 0.3, b: 0.2 }, "b");
  const draw = scoreOutcome({ a: 0.5, draw: 0.3, b: 0.2 }, "draw");
  //   away: cum P (0.5, 0.8) vs cum truth (0,0) = 0.25 + 0.64 = 0.89
  //   draw: cum P (0.5, 0.8) vs cum truth (0,1) = 0.25 + 0.04 = 0.29
  check("RPS punishes the far outcome hardest", near(away.rps, 0.89), `${away.rps}`);
  check("a draw costs less than the opposite win", (draw.rps ?? 9) < (away.rps ?? 0));
  check(
    "Brier does NOT know the outcomes are ordered",
    near(away.brier, draw.brier ?? -1) === false,
    "these should differ; RPS is the one that respects ordering",
  );
}

// A confident correct call must beat a hedged one on every metric.
{
  const sure = scoreOutcome({ a: 0.8, draw: 0.15, b: 0.05 }, "a");
  const hedge = scoreOutcome({ a: 0.4, draw: 0.35, b: 0.25 }, "a");
  check(
    "confidence is rewarded when right",
    sure.brier < hedge.brier && sure.logLoss < hedge.logLoss && (sure.rps ?? 9) < (hedge.rps ?? 9),
  );
  const wrongSure = scoreOutcome({ a: 0.8, draw: 0.15, b: 0.05 }, "b");
  const wrongHedge = scoreOutcome({ a: 0.4, draw: 0.35, b: 0.25 }, "b");
  check(
    "and punished when wrong",
    wrongSure.brier > wrongHedge.brier && wrongSure.logLoss > wrongHedge.logLoss,
  );
}

// ------------------------------------------------------------ two-way (tennis)

// P = (0.7 A, 0.3 B), A wins.
//   Brier = (0.7-1)^2 + (0.3-0)^2 = 0.09 + 0.09 = 0.18
//   log loss = -ln(0.7)
{
  const s = scoreOutcome({ a: 0.7, draw: null, b: 0.3 }, "a");
  check("2-way Brier ignores a draw that cannot happen", near(s.brier, 0.18), `${s.brier}`);
  check("2-way log loss", near(s.logLoss, -Math.log(0.7)), `${s.logLoss}`);
  check("2-way has no RPS, because the outcomes are not ordered", s.rps === null);
}

// A coin flip has to score exactly the reference values, or every "better than
// chance" claim on the pages is measured against the wrong baseline.
{
  const s = scoreOutcome({ a: 0.5, draw: null, b: 0.5 }, "a");
  check("a 2-way coin flip scores ln 2", near(s.logLoss, Math.log(2)), `${s.logLoss}`);
  check("and Brier 0.5", near(s.brier, 0.5), `${s.brier}`);
}

// Symmetry: which player is "a" is an arbitrary orientation, so swapping the
// sides and the result must not change the score.
{
  const one = scoreOutcome({ a: 0.62, draw: null, b: 0.38 }, "a");
  const flipped = scoreOutcome({ a: 0.38, draw: null, b: 0.62 }, "b");
  check(
    "scoring is symmetric under swapping the two sides",
    near(one.brier, flipped.brier) && near(one.logLoss, flipped.logLoss),
  );
}

// A certain-and-correct call is free; a certain-and-wrong one is not infinite.
{
  const perfect = scoreOutcome({ a: 1, draw: null, b: 0 }, "a");
  check("a perfect call costs nothing", near(perfect.brier, 0) && perfect.logLoss < 1e-8);
  const disaster = scoreOutcome({ a: 0, draw: null, b: 1 }, "a");
  check(
    "a certain miss is clamped, not infinite",
    Number.isFinite(disaster.logLoss) && disaster.logLoss > 15,
    `${disaster.logLoss}`,
  );
}

// ------------------------------------------------- no database, no explosion

{
  const view = await readLedger("soccer", "epl");
  check("an unreachable ledger returns an empty view, not a throw", view.summary.n === 0);
  check("and reports zero pending rather than null", view.summary.pending === 0);
  check("and names the model version anyway", view.modelVersion.length > 0, view.modelVersion);
  check("and carries no fabricated rows", view.recent.length === 0 && view.running.length === 0);
  check("accuracy is null, not zero — those mean different things", view.summary.accuracy === null);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
