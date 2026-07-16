#!/usr/bin/env -S npx tsx
/**
 * Round-9 analysis: the smart lineup offense (v5) and weather, judged under the
 * usual protocol against v2 and the market.
 *
 *   npx tsx scripts/collect-backtest-data.ts --lineup --weather --out .backtest-cache/records-v5.jsonl
 *   npx tsx scripts/analyze-round9.ts [--in .backtest-cache/records-v5.jsonl] [--test-start 2026-06-14]
 *
 * v5 = sim-recent (v2) inputs with the offense swapped for the PA-weighted,
 * platoon-aware, environment-normalized lineup line (mlb-lineup.ts). v5np is
 * the same without the platoon multipliers, so the platoon constants are
 * judged separately. Both are FIXED models (no fitting), so dev vs test is a
 * pure stability read; temperature calibration is the only fitted knob (dev).
 * Weather (temp / wind at first pitch, roofs zeroed) is tested as walk-forward
 * residual features on top of the market — the same "does the line miss it?"
 * framing as Round 8, using OBSERVED weather, i.e. an upper bound on what a
 * forecast could add.
 *
 * Ship bar (pre-committed, same as Round 7): beat v2 on BOTH accuracy and
 * Brier on the frozen test window, confirmed directionally on the full span.
 */

import { readFileSync } from "node:fs";

interface Rec {
  date: string;
  gamePk: number;
  y: number;
  pSimV1: number;
  pSimV2: number;
  pElo: number;
  pV1: number;
  pV2: number;
  pV3: number;
  pV5: number | null;
  pV5np: number | null;
  lineupH?: boolean;
  lineupA?: boolean;
  pMarket: number | null;
  mlHome: number | null;
  mlAway: number | null;
  tempC: number | null;
  windKmh: number | null;
  roof: boolean | null;
  f: Record<string, number | null>;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const L = (p: number) => logit(clamp01(p));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function metrics(pairs: Array<[number, number]>) {
  const eps = 1e-7;
  let acc = 0, brier = 0, ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = pairs.length;
  return n === 0 ? { n, acc: NaN, brier: NaN, logLoss: NaN } : { n, acc: acc / n, brier: brier / n, logLoss: ll / n };
}

type Model = (r: Rec) => number | null;
const evalOn = (set: Rec[], m: Model) =>
  metrics(set.map((r) => [m(r), r.y] as [number | null, number]).filter(([p]) => p != null) as Array<[number, number]>);

const blend2 = (a: Model, b: Model, w: number): Model => (r) => {
  const pa = a(r), pb = b(r);
  if (pa == null || pb == null) return null;
  return sigmoid((1 - w) * L(pa) + w * L(pb));
};
const temp = (m: Model, a: number): Model => (r) => {
  const p = m(r);
  return p == null ? null : sigmoid(a * L(p));
};

function bestW(dev: Rec[], make: (w: number) => Model, lo = 0, hi = 1, step = 0.05) {
  let best = { w: lo, brier: Infinity };
  for (let w = lo; w <= hi + 1e-9; w += step) {
    const b = evalOn(dev, make(w)).brier;
    if (b < best.brier) best = { w: Number(w.toFixed(2)), brier: b };
  }
  return best;
}

function fitLogistic(rows: Array<{ x: number[]; y: number; off: number }>, lambda = 0.02, iters = 3000, lr = 0.15) {
  const d = rows[0].x.length;
  const mean = Array(d).fill(0), sd = Array(d).fill(0);
  for (const r of rows) r.x.forEach((v, j) => (mean[j] += v / rows.length));
  for (const r of rows) r.x.forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / rows.length));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const X = rows.map((r) => r.x.map((v, j) => (v - mean[j]) / sd[j]));
  let w = Array(d).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const z = rows[i].off + b + X[i].reduce((a, v, j) => a + v * w[j], 0);
      const e = sigmoid(z) - rows[i].y;
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + lambda * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b, mean, sd };
}
const applyLogistic = (f: ReturnType<typeof fitLogistic>, x: number[], off: number) =>
  sigmoid(off + f.b + x.reduce((a, v, j) => a + ((v - f.mean[j]) / f.sd[j]) * f.w[j], 0));

async function main() {
  const recs: Rec[] = readFileSync(arg("in", ".backtest-cache/records-v5.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gamePk - b.gamePk));
  const testStart = arg("test-start", "2026-06-14");
  const dev = recs.filter((r) => r.date < testStart);
  const test = recs.filter((r) => r.date >= testStart);
  const luAll = recs.filter((r) => r.pV5 != null).length;
  console.log(`Loaded ${recs.length} games — v5 lineup built for ${luAll} (${((luAll / recs.length) * 100).toFixed(1)}%)`);
  console.log(`dev n=${dev.length}   test n=${test.length} (frozen)\n`);

  const mV1: Model = (r) => r.pV1;
  const mV2: Model = (r) => r.pV2;
  const mV5: Model = (r) => r.pV5;
  const mV5np: Model = (r) => r.pV5np;
  const mMkt: Model = (r) => r.pMarket;

  // dev-fit knobs
  const aV5 = 0.5 + bestW(dev, (a) => temp(mV5, 0.5 + a), 0, 1, 0.05).w;
  const wV2V5 = bestW(dev, (w) => blend2(mV2, mV5, w)).w;

  const rows: Array<[string, Model]> = [
    ["v1 (headline)", mV1],
    ["v2 (recent form)", mV2],
    ["v5 lineup + platoon", mV5],
    ["v5 lineup, no platoon", mV5np],
    [`v5 + temperature (a=${aV5.toFixed(2)})`, temp(mV5, aV5)],
    [`blend v2×v5 (w=${wV2V5})`, blend2(mV2, mV5, wV2V5)],
    ["market (devigged)", mMkt],
  ];
  const fmt = (nm: string, d: ReturnType<typeof metrics>, t: ReturnType<typeof metrics>, full: ReturnType<typeof metrics>) =>
    console.log(
      `${nm.padEnd(28)} dev ${(d.acc * 100).toFixed(1)}% ${d.brier.toFixed(4)}   TEST ${(t.acc * 100).toFixed(1)}% ${t.brier.toFixed(4)} ${t.logLoss.toFixed(4)}   full ${(full.acc * 100).toFixed(1)}% ${full.brier.toFixed(4)}`,
    );
  console.log("═══ The lineup model — dev · frozen test · full span ═══");
  for (const [nm, m] of rows) fmt(nm, evalOn(dev, m), evalOn(test, m), evalOn(recs, m));

  // where v5 and v2 disagree
  let dis = 0, right = 0;
  for (const r of test) {
    if (r.pV5 == null) continue;
    if ((r.pV5 >= 0.5) !== (r.pV2 >= 0.5)) {
      dis++;
      if ((r.pV5 >= 0.5 ? 1 : 0) === r.y) right++;
    }
  }
  console.log(`\nv5 vs v2 picks on test: disagreed ${dis}, v5 right ${right} (${dis ? ((right / dis) * 100).toFixed(0) : 0}%)`);

  // platoon delta in isolation
  const dPlat = recs.filter((r) => r.pV5 != null && r.pV5np != null);
  console.log(
    `platoon constants alone (v5 vs v5np, full span): Δbrier=${(evalOn(dPlat, mV5).brier - evalOn(dPlat, mV5np).brier).toFixed(5)} (negative = platoon helps)`,
  );

  // ═══ weather as market-residual features (upper bound: observed, not forecast) ═══
  console.log("\n═══ Weather — does the line miss temperature/wind? (walk-forward, offset = market) ═══");
  const withOdds = recs.filter((r) => r.pMarket != null);
  const wFeat = (r: Rec): number[] => {
    const open = r.roof === false;
    const t = open && r.tempC != null ? r.tempC - 21 : 0; // vs ~70°F baseline
    const w = open && r.windKmh != null ? r.windKmh - 12 : 0;
    return [t, w, open ? 1 : 0, L(r.pV5 ?? r.pV2) - L(r.pMarket!)];
  };
  const dates = Array.from(new Set(withOdds.map((r) => r.date))).sort();
  const wf: Array<[number, number]> = [];
  const wfM: Array<[number, number]> = [];
  for (const d of dates) {
    const hist = withOdds.filter((r) => r.date < d);
    if (hist.length < 200) continue;
    const day = withOdds.filter((r) => r.date === d);
    const fit = fitLogistic(hist.map((r) => ({ x: wFeat(r), y: r.y, off: L(r.pMarket!) })));
    for (const r of day) {
      wf.push([applyLogistic(fit, wFeat(r), L(r.pMarket!)), r.y]);
      wfM.push([r.pMarket!, r.y]);
    }
  }
  console.log(`  market alone            n=${wfM.length}  brier=${metrics(wfM).brier.toFixed(4)}`);
  console.log(`  market + weather + v5   n=${wf.length}  brier=${metrics(wf).brier.toFixed(4)}`);
  const full = fitLogistic(withOdds.map((r) => ({ x: wFeat(r), y: r.y, off: L(r.pMarket!) })));
  ["tempC (open air)", "wind (open air)", "open-air flag", "v5−market"].forEach((nm, j) =>
    console.log(`    ${nm.padEnd(16)} ${full.w[j] >= 0 ? "+" : ""}${full.w[j].toFixed(3)}`),
  );

  console.log("\nShip bar: v5 (or a v5 variant) must beat v2 on BOTH acc and Brier on the frozen test.");
}

main().catch((err) => {
  console.error("💥 round9 failed:", err);
  process.exit(1);
});
