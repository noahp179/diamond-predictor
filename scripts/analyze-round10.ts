#!/usr/bin/env -S npx tsx
/**
 * Round-10 analysis: do the invented stats carry anything the line misses?
 *
 *   npx tsx scripts/analyze-round10.ts [--in .backtest-cache/records-v5.jsonl]
 *                                      [--novel .backtest-cache/novel.jsonl]
 *
 * Three lenses, hardest first:
 *   1. UNIVARIATE — correlation of each invented stat (home−away diff) with the
 *      market residual (y − pMarket), bootstrap 90% CI. A real signal shows a
 *      CI excluding zero.
 *   2. MULTIVARIATE — walk-forward logistic, market as fixed offset, all novel
 *      stats as features. Brier vs the market alone.
 *   3. POCKET STRATEGIES — flat-bet rules built on the stats (velo-drop fade,
 *      luck regression, travel fatigue, sweep spots, pen exhaustion, model
 *      consensus), each with ROI, bootstrap 90% CI and split-half sign.
 *
 * Edge bar unchanged from Round 8: CI excluding zero AND same-sign halves.
 */

import { readFileSync } from "node:fs";

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const L = (p: number) => logit(clamp01(p));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Row {
  date: string;
  gamePk: number;
  y: number;
  pV1: number;
  pV2: number;
  pV5: number | null;
  pMarket: number;
  mlHome: number;
  mlAway: number;
  nv: Record<string, number | null>;
}

const impl = (ml: number) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
const payout = (ml: number) => (ml > 0 ? ml / 100 : 100 / -ml);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bootCI(xs: number[], seed = 11): [number, number] {
  if (xs.length === 0) return [NaN, NaN];
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[(rnd() * xs.length) | 0];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[100], means[1900]];
}

function metrics(pairs: Array<[number, number]>) {
  const eps = 1e-7;
  let brier = 0, ll = 0, acc = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  return { n: pairs.length, acc: acc / pairs.length, brier: brier / pairs.length, logLoss: ll / pairs.length };
}

function fitLogistic(rows: Array<{ x: number[]; y: number; off: number }>, lambda = 0.02, iters = 2500, lr = 0.15) {
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
  const recs: any[] = readFileSync(arg("in", ".backtest-cache/records-v5.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const novel: any[] = readFileSync(arg("novel", ".backtest-cache/novel.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const nvByPk = new Map(novel.map((n) => [n.gamePk, n]));
  const rows: Row[] = recs
    .filter((r) => r.pMarket != null && nvByPk.has(r.gamePk))
    .map((r) => ({
      date: r.date, gamePk: r.gamePk, y: r.y, pV1: r.pV1, pV2: r.pV2, pV5: r.pV5 ?? null,
      pMarket: r.pMarket, mlHome: r.mlHome, mlAway: r.mlAway, nv: nvByPk.get(r.gamePk)!,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`joined ${rows.length} games with market + novel stats\n`);

  // Feature diffs (home − away), missing → null (excluded per-feature).
  const FEATS: Array<[string, (r: Row) => number | null]> = [
    ["veloDelta diff", (r) => (r.nv.veloDeltaH != null && r.nv.veloDeltaA != null ? (r.nv.veloDeltaH as number) - (r.nv.veloDeltaA as number) : null)],
    ["seq luck21 diff", (r) => (r.nv.luck21H as number) - (r.nv.luck21A as number)],
    ["pythag luck diff", (r) => (r.nv.pythagLuckH as number) - (r.nv.pythagLuckA as number)],
    ["one-run luck diff", (r) => (r.nv.oneRunLuckH as number) - (r.nv.oneRunLuckA as number)],
    ["tz shift diff", (r) => (r.nv.tzShiftH as number) - (r.nv.tzShiftA as number)],
    ["km 72h diff", (r) => ((r.nv.km72H as number) - (r.nv.km72A as number)) / 1000],
    ["getaway diff", (r) => (r.nv.getawayH as number) - (r.nv.getawayA as number)],
    ["down-0-2 diff", (r) => (r.nv.down02H as number) - (r.nv.down02A as number)],
    ["pen BF 2d diff", (r) => ((r.nv.penBF2dH as number) - (r.nv.penBF2dA as number)) / 10],
  ];

  console.log("═══ 1 · Each invented stat vs the market residual (y − pMarket) ═══");
  for (const [nm, f] of FEATS) {
    const xs: number[] = [], res: number[] = [];
    for (const r of rows) {
      const v = f(r);
      if (v == null) continue;
      xs.push(v);
      res.push(r.y - r.pMarket);
    }
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, mr = res.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0, vr = 0;
    for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (res[i] - mr); vx += (xs[i] - mx) ** 2; vr += (res[i] - mr) ** 2; }
    const corr = cov / Math.sqrt(vx * vr);
    // bootstrap the correlation
    const rnd = mulberry32(23);
    const cs: number[] = [];
    for (let b = 0; b < 1500; b++) {
      let c = 0, sx = 0, sr = 0, sxx = 0, srr = 0, sxr = 0;
      for (let i = 0; i < n; i++) {
        const k = (rnd() * n) | 0;
        sx += xs[k]; sr += res[k]; sxx += xs[k] ** 2; srr += res[k] ** 2; sxr += xs[k] * res[k];
      }
      const num = sxr - (sx * sr) / n;
      const den = Math.sqrt((sxx - (sx * sx) / n) * (srr - (sr * sr) / n));
      if (den > 0) cs.push(num / den);
    }
    cs.sort((a, b) => a - b);
    const lo = cs[Math.floor(cs.length * 0.05)], hi = cs[Math.floor(cs.length * 0.95)];
    const sig = lo > 0 || hi < 0 ? "  ← CI excludes 0" : "";
    console.log(`  ${nm.padEnd(20)} n=${String(n).padStart(4)}  r=${corr >= 0 ? "+" : ""}${corr.toFixed(3)}  CI[${lo.toFixed(3)}, ${hi.toFixed(3)}]${sig}`);
  }

  console.log("\n═══ 2 · All invented stats on top of the market (walk-forward) ═══");
  const featVec = (r: Row) => FEATS.map(([, f]) => f(r) ?? 0);
  const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
  const wf: Array<[number, number]> = [], wfM: Array<[number, number]> = [];
  for (const d of dates) {
    const hist = rows.filter((r) => r.date < d);
    if (hist.length < 200) continue;
    const day = rows.filter((r) => r.date === d);
    const fit = fitLogistic(hist.map((r) => ({ x: featVec(r), y: r.y, off: L(r.pMarket) })));
    for (const r of day) {
      wf.push([applyLogistic(fit, featVec(r), L(r.pMarket)), r.y]);
      wfM.push([r.pMarket, r.y]);
    }
  }
  console.log(`  market alone           n=${wfM.length}  brier=${metrics(wfM).brier.toFixed(4)}`);
  console.log(`  market + novel stats   n=${wf.length}  brier=${metrics(wf).brier.toFixed(4)}`);
  const full = fitLogistic(rows.map((r) => ({ x: featVec(r), y: r.y, off: L(r.pMarket) })));
  console.log("  full-sample coefficients (standardized):");
  FEATS.forEach(([nm], j) => console.log(`    ${nm.padEnd(20)} ${full.w[j] >= 0 ? "+" : ""}${full.w[j].toFixed(3)}`));

  console.log("\n═══ 3 · Pocket strategies (flat 1u, real prices) ═══");
  interface Strat { nm: string; pick: (r: Row) => "H" | "A" | null }
  const evOf = (p: number, ml: number) => p * payout(ml) - (1 - p);
  const consensusSide = (r: Row, minEdge: number): "H" | "A" | null => {
    if (r.pV5 == null) return null;
    const side = r.pV1 >= 0.5 && r.pV2 >= 0.5 && r.pV5 >= 0.5 ? "H" : r.pV1 < 0.5 && r.pV2 < 0.5 && r.pV5 < 0.5 ? "A" : null;
    if (!side) return null;
    const pAvg = sigmoid((L(r.pV1) + L(r.pV2) + L(r.pV5)) / 3);
    const p = side === "H" ? pAvg : 1 - pAvg;
    const m = side === "H" ? r.pMarket : 1 - r.pMarket;
    return p - m >= minEdge ? side : null;
  };
  const strats: Strat[] = [
    { nm: "fade velo-drop starter (≤−1.0mph)", pick: (r) => (r.nv.veloDeltaH != null && (r.nv.veloDeltaH as number) <= -1.0 ? "A" : r.nv.veloDeltaA != null && (r.nv.veloDeltaA as number) <= -1.0 ? "H" : null) },
    { nm: "fade velo-drop starter (≤−1.5mph)", pick: (r) => (r.nv.veloDeltaH != null && (r.nv.veloDeltaH as number) <= -1.5 ? "A" : r.nv.veloDeltaA != null && (r.nv.veloDeltaA as number) <= -1.5 ? "H" : null) },
    { nm: "back velo-GAIN starter (≥+1.0mph)", pick: (r) => (r.nv.veloDeltaH != null && (r.nv.veloDeltaH as number) >= 1.0 ? "H" : r.nv.veloDeltaA != null && (r.nv.veloDeltaA as number) >= 1.0 ? "A" : null) },
    { nm: "fade sequencing-lucky team (diff>0.7 r/g)", pick: (r) => { const d = (r.nv.luck21H as number) - (r.nv.luck21A as number); return d > 0.7 ? "A" : d < -0.7 ? "H" : null; } },
    { nm: "fade pythag-lucky team (diff>0.05)", pick: (r) => { const d = (r.nv.pythagLuckH as number) - (r.nv.pythagLuckA as number); return d > 0.05 ? "A" : d < -0.05 ? "H" : null; } },
    { nm: "fade one-run-lucky team (diff>0.15)", pick: (r) => { const d = (r.nv.oneRunLuckH as number) - (r.nv.oneRunLuckA as number); return d > 0.15 ? "A" : d < -0.15 ? "H" : null; } },
    { nm: "fade getaway-tired team", pick: (r) => ((r.nv.getawayH as number) === 1 && (r.nv.getawayA as number) === 0 ? "A" : (r.nv.getawayA as number) === 1 && (r.nv.getawayH as number) === 0 ? "H" : null) },
    { nm: "fade 2+ tz shift team", pick: (r) => { const d = (r.nv.tzShiftH as number) - (r.nv.tzShiftA as number); return d >= 2 ? "A" : d <= -2 ? "H" : null; } },
    { nm: "back sweep-avoidance team (down 0-2)", pick: (r) => ((r.nv.down02H as number) === 1 ? "H" : (r.nv.down02A as number) === 1 ? "A" : null) },
    { nm: "fade down-0-2 team", pick: (r) => ((r.nv.down02H as number) === 1 ? "A" : (r.nv.down02A as number) === 1 ? "H" : null) },
    { nm: "fade gassed pen (diff>15 BF)", pick: (r) => { const d = (r.nv.penBF2dH as number) - (r.nv.penBF2dA as number); return d > 15 ? "A" : d < -15 ? "H" : null; } },
    { nm: "model consensus vs line (edge≥3%)", pick: (r) => consensusSide(r, 0.03) },
    { nm: "model consensus vs line (edge≥5%)", pick: (r) => consensusSide(r, 0.05) },
    { nm: "consensus + opp velo-drop", pick: (r) => { const c = consensusSide(r, 0.02); if (!c) return null; const oppVelo = c === "H" ? r.nv.veloDeltaA : r.nv.veloDeltaH; return oppVelo != null && (oppVelo as number) <= -0.5 ? c : null; } },
  ];
  const half = rows[Math.floor(rows.length / 2)].date;
  for (const st of strats) {
    const profits: number[] = [];
    let h1 = 0, n1 = 0, h2 = 0, n2 = 0, wins = 0;
    for (const r of rows) {
      const side = st.pick(r);
      if (!side) continue;
      const ml = side === "H" ? r.mlHome : r.mlAway;
      const won = side === "H" ? r.y === 1 : r.y === 0;
      const profit = won ? payout(ml) : -1;
      profits.push(profit);
      if (won) wins++;
      if (r.date < half) { n1++; h1 += profit; } else { n2++; h2 += profit; }
    }
    if (profits.length < 20) {
      console.log(`  ${st.nm.padEnd(40)} n=${profits.length} (too few)`);
      continue;
    }
    const roi = profits.reduce((a, b) => a + b, 0) / profits.length;
    const [lo, hi] = bootCI(profits);
    const consistent = n1 > 0 && n2 > 0 && Math.sign(h1 / n1) === Math.sign(h2 / n2);
    const flag = lo > 0 && consistent ? "  ★ MEETS BAR" : "";
    console.log(
      `  ${st.nm.padEnd(40)} n=${String(profits.length).padStart(4)}  win%=${((wins / profits.length) * 100).toFixed(1)}  ROI=${(roi * 100).toFixed(1)}%  CI[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  halves ${consistent ? "same" : "flip"}${flag}`,
    );
  }
  console.log("\nBar: CI excluding 0 AND same-sign halves. ~14 strategies tested — expect ~1 nominal near-miss by luck.");
}

main().catch((err) => {
  console.error("💥 round10 failed:", err);
  process.exit(1);
});
