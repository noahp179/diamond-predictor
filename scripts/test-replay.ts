#!/usr/bin/env node
/**
 * Checks the scored replay that feeds the Track Record charts.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * A replay is trivially easy to get wrong in a way that looks like success. If
 * a match is folded into the ratings BEFORE it is scored, the model is
 * predicting a result it has already seen and the reported accuracy climbs.
 *
 * The important thing about that failure is how QUIET it is. Moving the observer
 * after the fold takes the EPL replay from 48.9% to 55.4% — measured, by doing
 * exactly that. Against a backtest claiming 52.8% the leaked number looks better
 * than the honest one and still entirely plausible, so no threshold on accuracy
 * can be trusted to catch it. One match barely moves an Elo rating; the leak is
 * small per call and completely fatal to the meaning of the chart.
 *
 * So the checks here are:
 *
 *   1. the aggregation is right, on hand-computed inputs;
 *   2. the buckets are the same buckets everywhere on the site;
 *   3. the observer fires BEFORE the fold — checked on the arithmetic directly,
 *      because as above the output cannot be trusted to reveal it;
 *   4. the live replay against real data lands near the held-out backtest.
 *
 * Check 4 hits the ESPN API and takes a minute. It is skipped without --live.
 *
 * Run:  npx tsx scripts/test-replay.ts [--live]
 */
import {
  bucketise,
  pickOf,
  scoreOutcome,
  summarise,
  type ScoredCall,
} from "../src/lib/ledger-stats";

let fails = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    fails += 1;
  }
};
const near = (a: number | null, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// --------------------------------------------------------------- aggregation

console.log("\nsummarise()");
{
  const call = (date: string, pickProb: number, correct: boolean): ScoredCall => ({
    date,
    pickProb,
    correct,
    brier: correct ? 0.2 : 0.8,
    logLoss: correct ? 0.3 : 1.2,
    rps: null,
  });

  // Deliberately out of order: the page hands these over newest-first.
  const s = summarise([
    call("2026-01-03", 0.9, true),
    call("2026-01-01", 0.6, true),
    call("2026-01-02", 0.7, false),
    call("2026-01-01", 0.6, false),
  ]);

  ok(s.summary.n === 4, "counts every call");
  ok(s.summary.correct === 2 && near(s.summary.accuracy, 0.5), "accuracy is hits over calls");
  ok(near(s.summary.brier!, 0.5), "mean Brier", `got ${s.summary.brier}`);
  ok(near(s.summary.logLoss!, 0.75), "mean log loss", `got ${s.summary.logLoss}`);
  ok(s.summary.rps === null, "RPS stays null when no call carries one");
  ok(
    s.summary.firstDate === "2026-01-01" && s.summary.lastDate === "2026-01-03",
    "date range is sorted, not taken from input order",
  );

  // Sorted oldest-first: 01-01 (t,f in some order), 01-02 (f), 01-03 (t).
  ok(s.running.length === 4 && s.running[0].i === 1, "running series is one point per call");
  ok(near(s.running[3].accuracy, 0.5), "running accuracy ends at the overall rate");
  ok(
    s.running.every((p, i) => i === 0 || p.date >= s.running[i - 1].date),
    "running series is chronological",
  );

  ok(s.daily.length === 3, "one daily row per distinct date", `got ${s.daily.length}`);
  ok(s.daily[0].date === "2026-01-01" && s.daily[0].n === 2, "the doubled-up day is merged");
  ok(near(s.daily[0].accuracy, 0.5), "that day went 1 from 2");

  const empty = summarise([]);
  ok(empty.summary.n === 0 && empty.running.length === 0, "empty input is not a crash");
}

// ------------------------------------------------------------------ buckets

console.log("\nbucketise()");
{
  const b = bucketise([
    { pickProb: 0.52, correct: true },
    { pickProb: 0.54, correct: false },
    { pickProb: 0.91, correct: true },
    { pickProb: 0.95, correct: true },
  ]);
  ok(b.length === 2, "only non-empty buckets are returned", `got ${b.length}`);
  ok(b[0].band === "<55%" && b[0].n === 2, "the low bucket holds both coin flips");
  ok(near(b[0].actual, 0.5), "low bucket hit rate");
  ok(near(b[0].predicted, 0.53), "low bucket mean claim", `got ${b[0].predicted}`);
  ok(b[1].band === "85%+" && b[1].n === 2 && near(b[1].actual, 1), "the top bucket went 2 from 2");

  // A three-way pick can be the favourite while sitting under 50%, and dropping
  // those would silently exclude the hardest matches from every chart.
  const low = bucketise([{ pickProb: 0.38, correct: false }]);
  ok(low.length === 1 && low[0].n === 1, "a sub-coin-flip favourite is still scored");
}

// -------------------------------------------------------------- pick/score

console.log("\npickOf() and scoreOutcome()");
{
  ok(pickOf({ a: 0.5, draw: 0.3, b: 0.2 }).pick === "a", "picks the home side");
  ok(pickOf({ a: 0.2, draw: 0.5, b: 0.3 }).pick === "draw", "picks the draw when it leads");
  ok(near(pickOf({ a: 0.2, draw: 0.5, b: 0.3 }).pickProb, 0.5), "pickProb follows the pick");
  ok(pickOf({ a: 0.4, draw: null, b: 0.6 }).pick === "b", "two-way picks the favourite");

  // Two-way, p=0.7 on the winner: Brier = (0.7-1)^2 + (0.3-0)^2 = 0.18.
  const two = scoreOutcome({ a: 0.7, draw: null, b: 0.3 }, "a");
  ok(near(two.brier, 0.18), "two-way multiclass Brier", `got ${two.brier}`);
  ok(near(two.logLoss, -Math.log(0.7), 1e-12), "two-way log loss");
  ok(two.rps === null, "RPS is not defined for an unordered two-way market");

  // Three-way [0.5, 0.3, 0.2], result home. Cumulative: (0.5-1)^2 + (0.8-1)^2
  // = 0.25 + 0.04 = 0.29.
  const three = scoreOutcome({ a: 0.5, draw: 0.3, b: 0.2 }, "a");
  ok(near(three.rps!, 0.29), "three-way RPS", `got ${three.rps}`);

  // RPS must punish being wrong in the FAR direction harder than the near one.
  const nearMiss = scoreOutcome({ a: 0.5, draw: 0.3, b: 0.2 }, "draw");
  const farMiss = scoreOutcome({ a: 0.5, draw: 0.3, b: 0.2 }, "b");
  ok(farMiss.rps! > nearMiss.rps!, "an away result costs more than a draw when home was favoured");
}

// -------------------------------------------------- no leakage, structurally

console.log("\nreplay() scores before it folds");
{
  const { replay } = await import("../src/lib/soccer.server");
  const { matchModelFor } = await import("../src/lib/soccer.server");
  const model = matchModelFor("epl");
  const { hfa, k, gdExp, init } = model.elo;

  const finals = [
    { date: "2026-01-01", home: "H", away: "A", hg: 3, ag: 0, season: 2025 },
    { date: "2026-01-08", home: "H", away: "A", hg: 0, ag: 0, season: 2025 },
  ];

  const seen: { date: string; gap: number; known: boolean }[] = [];
  replay(model, finals, "2026-02-01", (m, ctx) => seen.push({ date: m.date, ...ctx }));

  ok(seen.length === 2, "the observer sees every match", `got ${seen.length}`);

  // THE CHECK. Before anything is folded in, both clubs sit at the initial
  // rating, so the gap the first match is priced at can only be the home
  // advantage. Fold first and the 3-0 has already moved both ratings, and this
  // is off by 2 * k * 4^gdExp * (1 - expected) — a number this assertion pins.
  ok(
    Math.abs(seen[0].gap - hfa) < 1e-9,
    "the first match is priced at exactly the home advantage",
    `gap=${seen[0].gap} hfa=${hfa}`,
  );
  ok(!seen[0].known, "neither club is rated yet, so the first match is not scored");

  // The second match must see the 3-0 and nothing else. Recomputed here from
  // the model constants rather than read back from the implementation.
  const exp = 1 / (1 + 10 ** (-hfa / 400));
  const d = k * (3 + 1) ** gdExp * (1 - exp);
  ok(
    Math.abs(seen[1].gap - (init + d + hfa - (init - d))) < 1e-9,
    "the second match sees the first result and only the first result",
    `gap=${seen[1].gap} expected=${2 * d + hfa}`,
  );
  ok(seen[1].known, "both clubs are rated by the second match");
}

// ------------------------------------------------------------- live replay

if (process.argv.includes("--live")) {
  /**
   * Sandbox workaround, not a production concern.
   *
   * ESPN's edge answers Node's default fetch with 403 from inside the dev
   * container while answering curl with 200 — it is fingerprinting the client,
   * not rejecting the request. Deployed on Vercel the same calls succeed, which
   * is why the shipped code does not send a User-Agent: the one that works here
   * ("curl/…") would be a lie in the header, and the browser-shaped ones are
   * refused anyway. Confined to the test so nothing about the running site
   * depends on it.
   */
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", "curl/8.5.0");
    return realFetch(input, { ...init, headers });
  }) as typeof fetch;

  const { soccerHistory } = await import("../src/lib/soccer.server");
  const { tennisHistory } = await import("../src/lib/tennis.server");
  const soccerModels = (await import("../src/lib/soccer-match-model.json")).default as Record<
    string,
    { backtest: { acc: number } }
  >;
  const tennisModels = (await import("../src/lib/tennis-match-model.json")).default as Record<
    string,
    { backtest: { acc: number } }
  >;

  const today = new Date().toISOString().slice(0, 10);

  const check = async (
    label: string,
    calls: Promise<ScoredCall[]>,
    claimed: number,
    minN: number,
  ) => {
    const c = await calls;
    const s = summarise(c);
    console.log(
      `\n${label}: n=${s.summary.n}  acc=${((s.summary.accuracy ?? 0) * 100).toFixed(1)}%  ` +
        `brier=${s.summary.brier?.toFixed(4)}  claimed=${(claimed * 100).toFixed(1)}%`,
    );
    console.log(
      `  buckets: ${s.calibration.map((b) => `${b.band} n=${b.n} ${(b.actual * 100).toFixed(0)}%`).join("  ")}`,
    );

    ok(s.summary.n >= minN, `${label}: enough matches replayed`, `got ${s.summary.n}`);
    if (s.summary.n === 0) return;

    const acc = s.summary.accuracy!;
    // A sanity band, NOT the leakage check — see the header: a leaked replay
    // sits comfortably inside any band wide enough to allow honest variation.
    // The leakage check is the structural one above. This catches the cruder
    // failures: a broken orientation, a mis-joined result, a model file that
    // no longer matches the code that reads it.
    ok(
      acc < claimed + 0.08,
      `${label}: not implausibly above its backtest`,
      `${acc} vs ${claimed}`,
    );
    ok(
      acc > claimed - 0.12,
      `${label}: not collapsed against the backtest`,
      `${acc} vs ${claimed}`,
    );
    ok(
      s.calibration.length >= 2,
      `${label}: confidence is spread across bands`,
      `${s.calibration.length} bands`,
    );
    ok(
      s.running.length === s.summary.n && s.daily.length > 5,
      `${label}: chart series are populated`,
    );
    ok(
      s.summary.firstDate! >= new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10),
      `${label}: window respected`,
      `first=${s.summary.firstDate}`,
    );
  };

  console.log("\nlive replay (hits ESPN)");
  await check("epl", soccerHistory("epl", today), soccerModels.epl.backtest.acc, 200);
  await check("laliga", soccerHistory("laliga", today), soccerModels.laliga.backtest.acc, 200);
  await check("atp", tennisHistory("atp", today), tennisModels.atp.backtest.acc, 500);
  await check("wta", tennisHistory("wta", today), tennisModels.wta.backtest.acc, 500);
} else {
  console.log("\nlive replay: skipped (pass --live to hit ESPN)");
}

console.log(fails === 0 ? "\nAll checks passed.\n" : `\n${fails} check(s) failed.\n`);
process.exit(fails === 0 ? 0 : 1);
