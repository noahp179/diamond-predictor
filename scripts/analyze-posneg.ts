#!/usr/bin/env -S npx tsx
/**
 * Theory test: a "positives" model and a "negatives" model that agree/disagree.
 *
 * We build TWO independent win-predictors from DISJOINT feature families:
 *
 *   POSITIVE model — reasons a team WINS (strengths):
 *     offense (runs scored/g, 30d), recent form (last-10 win%), streak,
 *     starting-pitcher quality (recent runs/out), rest & starter rest.
 *
 *   NEGATIVE model — reasons a team LOSES (weaknesses / wear):
 *     run prevention weakness (runs allowed/g, 30d), bullpen fatigue (relief
 *     batters faced last 2 days), travel (km last 72h, timezone shift, trip
 *     length, getaway day).
 *
 * Each is a logistic regression predicting the HOME win, fit on the dev window
 * (games before 2026-06-14) and FROZEN on the test window (2026-06-14 → 07-11,
 * 376 games). Because the two draw on different information, they can disagree —
 * and the theory is that when the "who's strong" model and the "who's weak"
 * model AGREE on a winner, that pick is far more reliable than when they clash.
 *
 * Reports, on the frozen test window:
 *   - each model alone, and their blend
 *   - accuracy on AGREEMENT games vs DISAGREEMENT games (the headline)
 *   - what a "bet only when they agree" rule would have hit
 *   - a combined system (agree → our pick, disagree → defer to the market)
 *   - baselines: home-always, the market, Recent Form (pV2)
 *
 *   npx tsx scripts/analyze-posneg.ts
 */

import { readFileSync } from "node:fs";

const TEST_START = "2026-06-14";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const n0 = (x: unknown) => (typeof x === "number" && isFinite(x) ? x : 0);

interface Rec {
  date: string;
  gamePk: number;
  y: number;
  pMarket: number | null;
  pV2: number | null;
  feat: Record<string, number>; // all candidate features (home − away)
}

/** Two ways to split "positives" from "negatives". */
const GROUPINGS: Record<string, { pos: string[]; neg: string[] }> = {
  // A — strengths (any reason to win) vs weaknesses/wear (any reason to lose)
  A_strength_vs_wear: {
    pos: ["offense", "form", "streak", "starter", "rest", "srest"],
    neg: ["allowed", "penFatigue", "travelKm", "tz", "trip", "getaway"],
  },
  // B — the cleanest split: offense (scoring) vs run-prevention (pitching/defense)
  B_offense_vs_prevention: {
    pos: ["offense", "form", "streak", "rest"],
    neg: ["allowed", "starter", "penFatigue", "travelKm", "trip"],
  },
};

function loadRecords(): Rec[] {
  const rec = readFileSync(".backtest-cache/records-v5.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const nov = new Map<number, any>(
    readFileSync(".backtest-cache/novel.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .map((n: any) => [n.gamePk, n]),
  );

  const out: Rec[] = [];
  for (const r of rec) {
    const f = r.f ?? {};
    const nv = nov.get(r.gamePk) ?? {};
    const rateH = (rs: number, g: number) => (g > 0 ? rs / g : 4.5);
    // POSITIVE — strengths (home − away), higher favors home winning
    const offense = rateH(n0(f.rs30H), n0(f.g30H)) - rateH(n0(f.rs30A), n0(f.g30A));
    const form = n0(f.l10H) - n0(f.l10A);
    const streak = n0(f.stkH) - n0(f.stkA);
    const starter = n0(f.sr3A) - n0(f.sr3H); // lower runs/out is better → home edge when home's is lower
    const rest = n0(f.restH) - n0(f.restA);
    const srest = n0(f.srestH) - n0(f.srestA);
    // NEGATIVE — weaknesses / wear (home − away), higher = home more burdened (→ home more likely to LOSE)
    const allowed = rateH(n0(f.ra30H), n0(f.g30H)) - rateH(n0(f.ra30A), n0(f.g30A));
    const penFatigue = n0(nv.penBF2dH) - n0(nv.penBF2dA);
    const travelKm = n0(nv.km72H) - n0(nv.km72A);
    const tz = n0(nv.tzShiftH) - n0(nv.tzShiftA);
    const trip = n0(f.tripH) - n0(f.tripA);
    const getaway = n0(nv.getawayH) - n0(nv.getawayA);

    out.push({
      date: r.date,
      gamePk: r.gamePk,
      y: r.y,
      pMarket: r.pMarket ?? null,
      pV2: r.pV2 ?? null,
      feat: { offense, form, streak, starter, rest, srest, allowed, penFatigue, travelKm, tz, trip, getaway },
    });
  }
  return out;
}

/** Standardize a feature matrix using column mean/std from the dev rows only. */
function standardizer(devRows: number[][]) {
  const d = devRows[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const r of devRows) for (let j = 0; j < d; j++) mean[j] += r[j];
  for (let j = 0; j < d; j++) mean[j] /= devRows.length;
  for (const r of devRows) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / devRows.length) || 1;
  return (row: number[]) => row.map((v, j) => (v - mean[j]) / std[j]);
}

/** L2-regularized logistic regression via gradient descent. Predicts P(y=1). */
function fitLogistic(X: number[][], y: number[], lambda = 0.01, iters = 4000, lr = 0.2) {
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  const N = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < N; i++) {
      const p = sigmoid(b + X[i].reduce((s, x, j) => s + x * w[j], 0));
      const e = p - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
    }
    b -= (lr * gb) / N;
    for (let j = 0; j < d; j++) w[j] -= (lr * (gw[j] / N + lambda * w[j]));
  }
  return { w, b, predict: (row: number[]) => sigmoid(b + row.reduce((s, x, j) => s + x * w[j], 0)) };
}

function metrics(pairs: Array<[number, number]>) {
  if (pairs.length === 0) return { n: 0, acc: NaN, brier: NaN };
  let acc = 0,
    brier = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
  }
  return { n: pairs.length, acc: acc / pairs.length, brier: brier / pairs.length };
}

const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;

function runGrouping(gname: string, all: Rec[]) {
  const { pos, neg } = GROUPINGS[gname];
  const dev = all.filter((r) => r.date < TEST_START);
  const test = all.filter((r) => r.date >= TEST_START);
  const vecPos = (r: Rec) => pos.map((k) => r.feat[k]);
  const vecNeg = (r: Rec) => neg.map((k) => r.feat[k]);

  console.log(`\n\n████ GROUPING ${gname} ████`);
  console.log(`  POSITIVE features: ${pos.join(", ")}`);
  console.log(`  NEGATIVE features: ${neg.join(", ")}`);

  const stdPos = standardizer(dev.map(vecPos));
  const stdNeg = standardizer(dev.map(vecNeg));
  const y = dev.map((r) => r.y);
  const fitPos = fitLogistic(dev.map((r) => stdPos(vecPos(r))), y);
  const fitNeg = fitLogistic(dev.map((r) => stdNeg(vecNeg(r))), y);

  console.log("  weights (+ favors home): POS " +
    pos.map((k, j) => `${k} ${fitPos.w[j].toFixed(2)}`).join(", "));
  console.log("                           NEG " +
    neg.map((k, j) => `${k} ${fitNeg.w[j].toFixed(2)}`).join(", "));

  const score = (rows: Rec[]) =>
    rows.map((r) => {
      const pPlus = fitPos.predict(stdPos(vecPos(r)));
      const pMinus = fitNeg.predict(stdNeg(vecNeg(r)));
      const pickPlus = pPlus >= 0.5 ? 1 : 0;
      const pickMinus = pMinus >= 0.5 ? 1 : 0;
      const agree = pickPlus === pickMinus;
      const blend = sigmoid(
        (Math.log(pPlus / (1 - pPlus)) + Math.log(pMinus / (1 - pMinus))) / 2,
      );
      return { r, pPlus, pMinus, pickPlus, pickMinus, agree, blend };
    });

  const report = (label: string, rows: Rec[]) => {
    const s = score(rows);
    console.log(`\n═══ ${label} (${rows.length} games) ═══`);
    console.log(`  Positive model alone     acc=${pctOf(metrics(s.map((x) => [x.pPlus, x.r.y])).acc)}  brier=${metrics(s.map((x) => [x.pPlus, x.r.y])).brier.toFixed(4)}`);
    console.log(`  Negative model alone     acc=${pctOf(metrics(s.map((x) => [x.pMinus, x.r.y])).acc)}  brier=${metrics(s.map((x) => [x.pMinus, x.r.y])).brier.toFixed(4)}`);
    console.log(`  Blend (both)             acc=${pctOf(metrics(s.map((x) => [x.blend, x.r.y])).acc)}  brier=${metrics(s.map((x) => [x.blend, x.r.y])).brier.toFixed(4)}`);

    const agree = s.filter((x) => x.agree);
    const disagree = s.filter((x) => !x.agree);
    const accOn = (set: typeof s) =>
      set.length ? set.filter((x) => x.pickPlus === x.r.y).length / set.length : NaN;
    console.log(`\n  ── The theory: agreement vs disagreement ──`);
    console.log(`  AGREE     ${agree.length} games (${pctOf(agree.length / s.length)} of slate)  →  acc=${pctOf(accOn(agree))}`);
    console.log(`  DISAGREE  ${disagree.length} games (${pctOf(disagree.length / s.length)} of slate)  →  acc=${pctOf(accOn(disagree))}  (blend acc=${pctOf(metrics(disagree.map((x) => [x.blend, x.r.y])).acc)})`);

    // Strong agreement: both models confident (|p-0.5| large on both sides).
    const strong = agree.filter((x) => Math.abs(x.pPlus - 0.5) > 0.1 && Math.abs(x.pMinus - 0.5) > 0.1);
    console.log(`  AGREE + both confident   ${strong.length} games (${pctOf(strong.length / s.length)})  →  acc=${pctOf(accOn(strong))}`);

    // Baselines
    const homeAlways = rows.filter((r) => r.y === 1).length / rows.length;
    const mkt = metrics(rows.filter((r) => r.pMarket != null).map((r) => [r.pMarket as number, r.y]));
    const v2 = metrics(rows.filter((r) => r.pV2 != null).map((r) => [r.pV2 as number, r.y]));
    console.log(`\n  ── Baselines ──`);
    console.log(`  Home-always              acc=${pctOf(homeAlways)}`);
    console.log(`  Market (devigged)        acc=${pctOf(mkt.acc)}  brier=${mkt.brier.toFixed(4)}  (n=${mkt.n})`);
    console.log(`  Recent Form (pV2)        acc=${pctOf(v2.acc)}  brier=${v2.brier.toFixed(4)}  (n=${v2.n})`);

    // Combined system: agree → our blend pick; disagree → defer to market.
    const combo = metrics(
      s.map((x) => {
        if (x.agree) return [x.blend, x.r.y] as [number, number];
        const m = x.r.pMarket;
        return [m != null ? m : x.blend, x.r.y] as [number, number];
      }),
    );
    console.log(`\n  ── Combined system (agree → our pick, disagree → market) ──`);
    console.log(`  acc=${pctOf(combo.acc)}  brier=${combo.brier.toFixed(4)}`);
    return { s, agree, disagree };
  };

  report("DEV (in-sample reference)", dev);
  const t = report("TEST — frozen (2026-06-14 → 07-11)", test);

  // How often does the market side with the winner on disagreements?
  const dis = t.disagree.filter((x) => x.r.pMarket != null);
  const marketAgreesPos = dis.filter((x) => (x.r.pMarket! >= 0.5 ? 1 : 0) === x.pickPlus).length;
  console.log(
    `\nOn TEST disagreements (${dis.length} priced): market sides with the POSITIVE model ${marketAgreesPos} times (${pctOf(marketAgreesPos / dis.length)}), the NEGATIVE model the rest.`,
  );
}

function main() {
  const all = loadRecords();
  console.log(`Loaded ${all.length} games · dev/test split at ${TEST_START}`);
  for (const g of Object.keys(GROUPINGS)) runGrouping(g, all);
}

main();
