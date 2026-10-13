#!/usr/bin/env node
/**
 * Checks for the Champions League model and simulator.
 *
 * 1. PARITY. research/ucl/ship_ucl.py writes a snapshot of every club's rating,
 *    the matches played after it and the ratings Python reached by replaying
 *    them (results/ucl_parity.json). The TypeScript replay must land on the
 *    same numbers — new clubs, season turnover and all — or the live ratings
 *    are not the ones that were backtested. Same for a grid of goal-model
 *    prices.
 * 2. THE SHIPPED FILES agree with each other: the snapshot holds every club in
 *    this season's competition, the history is in date order, scorer shares
 *    are sane.
 * 3. THE ENGINE: determinism, merging, goals near the model's rates, a lower
 *    draw rate than the closed form (what the backtest found), knockouts that
 *    always produce a winner, scorer probabilities that add up.
 * 4. NAVIGATION: the Champions League swaps Player Props for Simulate.
 * 5. LIVE (with --live): the real slate for today from ESPN, end to end.
 *
 * Run:  npx tsx scripts/test-ucl.ts [--live]
 */
import { readFileSync } from "node:fs";

import {
  goalRates,
  priceRates,
  replayInto,
  stateFromSnapshot,
  type Snapshot,
  type UclResult,
} from "../src/lib/ucl-model";
import snapshotFile from "../src/lib/ucl-ratings.json";
import historyFile from "../src/lib/ucl-history.json";
import scorersFile from "../src/lib/ucl-scorers.json";
import { Rng } from "../src/lib/sim/core";
import { mergeBatch, runBatch, SoccerEngine, type SoccerSide } from "../src/lib/sim/soccer";
import { viewHref, viewsFor } from "../src/lib/nav";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// ---------------------------------------------------------------- 1. parity
{
  const fx = JSON.parse(readFileSync("research/ucl/results/ucl_parity.json", "utf8")) as {
    snapshot: Snapshot;
    matches: [string, string, string, string, string, number, number, boolean][];
    expected: Record<string, number>;
    grid: {
      rh: number;
      ra: number;
      neutral: boolean;
      ucl: boolean;
      lh: number;
      la: number;
      home: number;
      draw: number;
      away: number;
      over25: number;
      btts: number;
    }[];
  };
  const matches: UclResult[] = fx.matches.map(([id, comp, date, home, away, hg, ag, neutral]) => ({
    id,
    comp,
    date,
    home,
    away,
    hg,
    ag,
    neutral,
  }));
  const state = replayInto(stateFromSnapshot(fx.snapshot), matches);
  let worst = 0;
  let worstId = "";
  for (const [id, want] of Object.entries(fx.expected)) {
    const got = state.rating.get(id);
    const d = got === undefined ? Infinity : Math.abs(got - want);
    if (d > worst) {
      worst = d;
      worstId = id;
    }
  }
  const fresh = Object.keys(fx.expected).filter((id) => !(id in fx.snapshot.clubs)).length;
  check(
    `replay parity: ${matches.length} matches, ${Object.keys(fx.expected).length} clubs (${fresh} new) within 1e-6`,
    worst < 1e-6,
    `worst ${worst} on ${worstId}`,
  );

  let gridWorst = 0;
  for (const g of fx.grid) {
    const r = goalRates(g.rh, g.ra, g.neutral, g.ucl);
    const p = priceRates(r.home, r.away);
    gridWorst = Math.max(
      gridWorst,
      Math.abs(r.home - g.lh),
      Math.abs(r.away - g.la),
      Math.abs(p.home - g.home),
      Math.abs(p.draw - g.draw),
      Math.abs(p.away - g.away),
      Math.abs(p.over25 - g.over25),
      Math.abs(p.btts - g.btts),
    );
  }
  check(
    `goal-model parity on ${fx.grid.length} pairings within 1e-9`,
    gridWorst < 1e-9,
    `worst ${gridWorst}`,
  );
}

// ---------------------------------------------------------- 2. shipped files
{
  const snap = snapshotFile as unknown as Snapshot & { ucl: Record<string, string> };
  const ucl = Object.keys(snap.ucl);
  check(
    `snapshot rates all ${ucl.length} Champions League clubs`,
    ucl.length >= 32 && ucl.every((id) => id in snap.clubs),
  );
  const rows = (historyFile as unknown as { rows: [string, string, ...unknown[]][] }).rows;
  check(
    `history: ${rows.length} matches, in date order`,
    rows.length > 1200 && rows.every((r, i) => i === 0 || rows[i - 1][1] <= r[1]),
  );
  const probsOk = rows.every((r) => {
    const s = (r[4] as number) + (r[5] as number) + (r[6] as number);
    return Math.abs(s - 1) < 1e-3;
  });
  check("history: every row's probabilities sum to 1", probsOk);
  const clubs = (
    scorersFile as unknown as {
      clubs: Record<string, { teamGoals: number; players: Record<string, [string, number]> }>;
    }
  ).clubs;
  const sane = Object.values(clubs).every((c) => {
    const sum = Object.values(c.players).reduce((s, [, g]) => s + g, 0);
    return Math.abs(sum - c.teamGoals) < 1e-2 * Math.max(1, c.teamGoals);
  });
  check(`scorers: ${Object.keys(clubs).length} clubs, player goals add up to team goals`, sane);
}

// ------------------------------------------------------------------ 3. engine
{
  const side = (rate: number, n: number, tag: string): SoccerSide => ({
    name: tag,
    abbr: tag,
    rate,
    scorers: Array.from({ length: n }, (_, i) => ({
      id: `${tag}${i}`,
      name: `${tag}${i}`,
      pos: "F",
      share: ((1 - 0.028) * (n - i)) / ((n * (n + 1)) / 2),
    })),
  });
  const home = side(1.6, 5, "h");
  const away = side(1.2, 5, "a");

  const a = runBatch(2000, 42, home, away);
  const b = runBatch(2000, 42, home, away);
  check("engine is deterministic for a seed", JSON.stringify(a) === JSON.stringify(b));

  const m = mergeBatch(runBatch(3000, 1, home, away), runBatch(4000, 2, home, away));
  check(
    "merging adds counts",
    m.n === 7000 &&
      m.home + m.draw + m.away === 7000 &&
      m.totals.reduce((s, x) => s + x, 0) === 7000,
  );

  const big = runBatch(200000, 7, home, away);
  const goals = (big.homeGoals + big.awayGoals) / big.n;
  const closed = priceRates(1.6, 1.2);
  // The backtest's simulated matches averaged 3.6% more goals than the closed
  // form's rates (3.03 against 2.92): game state reshapes, it does not add.
  check(
    `goals per match ${goals.toFixed(3)} within 0.95-1.10x the model's 2.8`,
    goals > 0.95 * 2.8 && goals < 1.1 * 2.8,
  );
  const draw = big.draw / big.n;
  check(
    `fewer draws than the closed form (${(draw * 100).toFixed(1)}% vs ${(closed.draw * 100).toFixed(1)}%)`,
    draw < closed.draw,
  );
  const hw = big.home / big.n;
  check(
    `home win within 4 points of the closed form (${(hw * 100).toFixed(1)}% vs ${(closed.home * 100).toFixed(1)}%)`,
    Math.abs(hw - closed.home) < 0.04,
  );
  const anyMax = Math.max(...Object.values(big.anytime)) / big.n;
  const p0 = big.anytime.h0 / big.n;
  // A player with share s of a side's goals scores with 1 - E[(1-s)^G], which
  // for Poisson G with the side's simulated mean is 1 - exp(-s·mean).
  const s0 = home.scorers[0].share;
  const expect0 = 1 - Math.exp(-s0 * (big.homeGoals / big.n));
  check(
    `top scorer's anytime ${(p0 * 100).toFixed(1)}% ≈ 1-exp(-share·goals) = ${(expect0 * 100).toFixed(1)}%`,
    Math.abs(p0 - expect0) < 0.02 && anyMax === p0,
  );
  const firstTotal = Object.values(big.first).reduce((s, x) => s + x, 0) / big.n;
  check(
    `first-scorer probabilities sum to P(a goal) minus own goals (${firstTotal.toFixed(3)})`,
    firstTotal < 1 - big.scores[0][0] / big.n && firstTotal > 0.9 * (1 - big.scores[0][0] / big.n),
  );

  const ko = runBatch(20000, 3, home, away, { knockout: true });
  check(
    "knockout: extra time only after a 90-minute draw, every tie decided",
    ko.extraTime === ko.draw &&
      ko.shootouts <= ko.extraTime &&
      ko.advanceHome > 0 &&
      ko.advanceHome < ko.n,
  );
  const leg2 = runBatch(20000, 4, home, away, { knockout: true, firstLeg: { home: 0, away: 3 } });
  check(
    `second leg 3 down: home go through ${((leg2.advanceHome / leg2.n) * 100).toFixed(1)}% (should be small)`,
    leg2.advanceHome / leg2.n < 0.1,
  );

  const one = new SoccerEngine().play(new Rng(9), home, away, { knockout: true }, true);
  const logged = one.events!.filter((e) => e.kind !== "red");
  check(
    "a logged match's events add up to its score",
    logged.filter((e) => e.side === "home").length === one.hg &&
      logged.filter((e) => e.side === "away").length === one.ag,
  );
}

// ---------------------------------------------------------------- 4. nav
{
  const keys = viewsFor("soccer", "ucl").map((v) => v.key);
  check(
    "UCL tabs: Matches, Simulate, Model, Track Record",
    keys.join() === "slate,simulate,model,trackRecord",
  );
  check(
    "EPL tabs keep Player Props",
    viewsFor("soccer", "epl").some((v) => v.key === "props"),
  );
  check(
    "props link in the UCL lands on its matches",
    viewHref("soccer", "props", "ucl") === "/soccer/ucl",
  );
  check(
    "simulate link in the EPL lands on its matches",
    viewHref("soccer", "simulate", "epl") === "/soccer/epl",
  );
  check("UCL simulate path", viewHref("soccer", "simulate", "ucl") === "/soccer/ucl/simulate");
}

// ---------------------------------------------------------------- 5. live
if (process.argv.includes("--live")) {
  const { uclSlate, uclSquad, uclHistoryRows } = await import("../src/lib/ucl.server");
  const date = new Date().toISOString().slice(0, 10);
  const t0 = Date.now();
  const slate = await uclSlate(date);
  console.log(
    `      live slate ${date}: ${slate.matches.length} matches, ${slate.ratings.liveResults} results since ${slate.ratings.cutoff}, ${((Date.now() - t0) / 1000).toFixed(1)}s, missing: ${slate.ratings.missing.join(", ") || "none"}`,
  );
  for (const m of slate.matches) {
    console.log(
      `        ${m.home.name} v ${m.away.name}: ${m.probs ? [m.probs.home, m.probs.draw, m.probs.away].map((p) => (p * 100).toFixed(0)).join("/") : "unpriced"}  ${m.status}`,
    );
  }
  check(
    "live: every fixture priced",
    slate.matches.length === 0 || slate.matches.every((m) => m.probs),
  );
  check("live: power table has the competition's clubs", slate.table.length >= 32);
  if (slate.matches[0]) {
    const sq = await uclSquad(slate.matches[0].home.id);
    const sum = sq.scorers.reduce((s, p) => s + p.share, 0);
    check(
      `live: ${slate.matches[0].home.name} squad shares sum to 1 - own goals (${sum.toFixed(3)}), roster ${sq.rosterLive ? "live" : "fallback"}`,
      Math.abs(sum - 0.972) < 1e-6,
    );
  }
  const hist = await uclHistoryRows(date, "2026-07-01");
  check(`live: this season's replayed record has ${hist.length} matches`, hist.length >= 18);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
