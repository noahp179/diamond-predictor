#!/usr/bin/env -S npx tsx
/**
 * Round-7 model study: candidate algorithms built ON TOP of the tracked models
 * (v1/v2/v3), evaluated with a dev/test protocol over the collector's cache.
 *
 *   npx tsx scripts/collect-backtest-data.ts        # once (heavy)
 *   npx tsx scripts/analyze-models.ts [--in .backtest-cache/records.jsonl]
 *                                     [--test-start 2026-06-14]
 *
 * Protocol:
 *   dev  = games before --test-start  → every weight/coefficient is fit here
 *   test = games from --test-start on → each candidate scored ONCE, frozen
 *          (defaults to the exact 376-game window Rounds 4–6 reported on)
 *   walk-forward = finalists refit on all games < each date across the full
 *          span — the most honest single number, no frozen-window luck.
 *
 * Candidates:
 *   - logit blends of the tracked models (v1×v2, v2×v3, v1×v2×v3)
 *   - re-weighted sim×Elo inside v2 (is 50/50 right?)
 *   - a trailing-30d run-differential (Pythagorean log5) leg
 *   - an "offset" logistic layer: v2 as a fixed base + schedule/context factors
 *     (rest, fatigue, streak, L10, road trip, starter rest/form, day game)
 *   - temperature (confidence) calibration per model
 *   - market blends, on the subset with stored odds
 *
 * Pure math; no network. Prints a league table plus finalist walk-forwards.
 */

import { readFileSync } from "node:fs";

interface Rec {
  date: string;
  gamePk: number;
  y: number;
  pSimV1: number;
  pSimV2: number;
  pSimV3: number;
  pElo: number;
  pV1: number;
  pV2: number;
  pV3: number;
  pMarket: number | null;
  mlHome: number | null;
  mlAway: number | null;
  hourUTC: number | null;
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

// ─── Candidate building blocks ────────────────────────────────────────────────

type Model = (r: Rec) => number | null; // null = model can't price this game

const blend2 = (a: Model, b: Model, w: number): Model => (r) => {
  const pa = a(r), pb = b(r);
  if (pa == null || pb == null) return null;
  return sigmoid((1 - w) * L(pa) + w * L(pb));
};

const blend3 = (a: Model, b: Model, c: Model, wa: number, wb: number, wc: number): Model => (r) => {
  const pa = a(r), pb = b(r), pc = c(r);
  if (pa == null || pb == null || pc == null) return null;
  const s = wa + wb + wc;
  return sigmoid((wa * L(pa) + wb * L(pb) + wc * L(pc)) / s);
};

const temp = (m: Model, a: number): Model => (r) => {
  const p = m(r);
  return p == null ? null : sigmoid(a * L(p));
};

/** Trailing-30d Pythagorean log5 with a fitted home-edge intercept. */
const pythag30 = (h: number): Model => (r) => {
  const f = r.f;
  const g30H = (f.g30H as number) ?? 0, g30A = (f.g30A as number) ?? 0;
  if (g30H < 8 || g30A < 8) return null;
  const ex = 1.83;
  const py = (rs: number, ra: number) => {
    if (rs <= 0 && ra <= 0) return 0.5;
    const a = Math.pow(Math.max(1, rs), ex);
    const b = Math.pow(Math.max(1, ra), ex);
    return a / (a + b);
  };
  const pH = py(f.rs30H as number, f.ra30H as number);
  const pA = py(f.rs30A as number, f.ra30A as number);
  const num = pH * (1 - pA);
  const den = num + (1 - pH) * pA;
  const p = den > 0 ? num / den : 0.5;
  return sigmoid(L(p) + h);
};

// ─── Factor features for the offset/stacker layer ─────────────────────────────

const FEATURES = [
  "restDiff", "g7Diff", "l10Diff", "stkDiff", "py30Diff", "tripDiff", "srestDiff", "sr3Diff", "dayGame",
] as const;

function features(r: Rec): number[] {
  const f = r.f;
  const nz = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? d : v);
  const py = (rs: number, ra: number, g: number) => {
    if (g < 8) return 0.5;
    const ex = 1.83;
    const a = Math.pow(Math.max(1, rs), ex), b = Math.pow(Math.max(1, ra), ex);
    return a / (a + b);
  };
  const pyH = py(nz(f.rs30H as number), nz(f.ra30H as number), nz(f.g30H as number));
  const pyA = py(nz(f.rs30A as number), nz(f.ra30A as number), nz(f.g30A as number));
  return [
    nz(f.restH as number, 1) - nz(f.restA as number, 1),
    nz(f.g7H as number, 6) - nz(f.g7A as number, 6),
    nz(f.l10H as number, 0.5) - nz(f.l10A as number, 0.5),
    nz(f.stkH as number) - nz(f.stkA as number),
    L(clamp01(pyH)) - L(clamp01(pyA)),
    nz(f.tripH as number) - nz(f.tripA as number),
    nz(f.srestH as number, 5) - nz(f.srestA as number, 5),
    nz(f.sr3H as number, 0.16) - nz(f.sr3A as number, 0.16),
    r.hourUTC != null && r.hourUTC <= 19 ? 1 : 0,
  ];
}

/**
 * Regularized logistic fit with a fixed offset: z = offset(r) + b0 + Σ wi·xi.
 * Offset = logit of a base model (or 0 for a from-scratch stacker whose base
 * probabilities enter as features instead). Plain gradient descent — n is tiny.
 */
function fitLogistic(
  rows: Array<{ x: number[]; y: number; off: number }>,
  lambda = 0.02,
  iters = 4000,
  lr = 0.15,
): { w: number[]; b: number; mean: number[]; sd: number[] } {
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
    for (let j = 0; j < d; j++) w[j] = w[j] - (lr * (gw[j] / X.length + lambda * w[j]));
    b -= lr * (gb / X.length);
  }
  return { w, b, mean, sd };
}

function applyLogistic(
  fit: { w: number[]; b: number; mean: number[]; sd: number[] },
  x: number[],
  off: number,
): number {
  const z = off + fit.b + x.reduce((a, v, j) => a + ((v - fit.mean[j]) / fit.sd[j]) * fit.w[j], 0);
  return sigmoid(z);
}

// ─── Grid search helpers (always on dev only) ─────────────────────────────────

function bestW(dev: Rec[], make: (w: number) => Model, lo = 0, hi = 1, step = 0.05): { w: number; brier: number } {
  let best = { w: lo, brier: Infinity };
  for (let w = lo; w <= hi + 1e-9; w += step) {
    const m = make(w);
    const pairs = dev.map((r) => [m(r), r.y] as [number | null, number]).filter(([p]) => p != null) as Array<[number, number]>;
    if (pairs.length === 0) continue;
    const b = metrics(pairs).brier;
    if (b < best.brier) best = { w: Number(w.toFixed(2)), brier: b };
  }
  return best;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function evalOn(set: Rec[], m: Model) {
  return metrics(set.map((r) => [m(r), r.y] as [number | null, number]).filter(([p]) => p != null) as Array<[number, number]>);
}

async function main() {
  const inPath = arg("in", ".backtest-cache/records.jsonl");
  const testStart = arg("test-start", "2026-06-14");
  const recs: Rec[] = readFileSync(inPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gamePk - b.gamePk));
  const dev = recs.filter((r) => r.date < testStart);
  const test = recs.filter((r) => r.date >= testStart);
  console.log(`Loaded ${recs.length} games (${recs[0].date} → ${recs[recs.length - 1].date})`);
  console.log(`dev n=${dev.length} (< ${testStart})   test n=${test.length} (frozen)\n`);

  const mV1: Model = (r) => r.pV1;
  const mV2: Model = (r) => r.pV2;
  const mV3: Model = (r) => r.pV3;
  const mElo: Model = (r) => r.pElo;
  const mSim2: Model = (r) => r.pSimV2;
  const mMarket: Model = (r) => r.pMarket;
  const mHome54: Model = () => 0.54;

  // ── fit everything on dev ──
  const wV1V2 = bestW(dev, (w) => blend2(mV1, mV2, w));
  const wV2V3 = bestW(dev, (w) => blend2(mV2, mV3, w));
  const wSimElo = bestW(dev, (w) => blend2(mSim2, mElo, w)); // v2's internal mix (currently 0.5)
  let bestTri = { wa: 1, wb: 1, wc: 1, brier: Infinity };
  for (let wa = 0; wa <= 10; wa += 2) for (let wb = 0; wb <= 10; wb += 2) for (let wc = 0; wc <= 10; wc += 2) {
    if (wa + wb + wc === 0) continue;
    const b = evalOn(dev, blend3(mV1, mV2, mV3, wa, wb, wc)).brier;
    if (b < bestTri.brier) bestTri = { wa, wb, wc, brier: b };
  }
  const hPy = bestW(dev, (h) => pythag30(h * 0.6 - 0.3), 0, 1, 0.05); // h ∈ [-0.3, +0.3]
  const hPyVal = hPy.w * 0.6 - 0.3;
  const wV2Py = bestW(dev, (w) => blend2(mV2, pythag30(hPyVal), w));
  const aV1 = bestW(dev, (a) => temp(mV1, 0.5 + a), 0, 1, 0.05); // a ∈ [0.5, 1.5]
  const aV2 = bestW(dev, (a) => temp(mV2, 0.5 + a), 0, 1, 0.05);

  // offset layer: v2 as fixed base + factor features
  const offRows = dev.map((r) => ({ x: features(r), y: r.y, off: L(r.pV2) }));
  const offFit = fitLogistic(offRows);
  const mOffset: Model = (r) => applyLogistic(offFit, features(r), L(r.pV2));

  // full stacker: sim/elo logits enter as features (no fixed base)
  const stackX = (r: Rec) => [L(r.pSimV2), L(r.pElo), ...features(r)];
  const stackRows = dev.map((r) => ({ x: stackX(r), y: r.y, off: 0 }));
  const stackFit = fitLogistic(stackRows);
  const mStack: Model = (r) => applyLogistic(stackFit, stackX(r), 0);

  // 3-logit ensemble: logistic on [logit simV1, logit simV2, logit elo] only —
  // a generalized blend whose weights need not sum to 1, so temperature
  // (confidence) calibration is absorbed into the same fit. No context factors.
  const triX = (r: Rec) => [L(r.pSimV1), L(r.pSimV2), L(r.pElo)];
  const triFit = fitLogistic(dev.map((r) => ({ x: triX(r), y: r.y, off: 0 })), 0.01);
  const mTri: Model = (r) => applyLogistic(triFit, triX(r), 0);

  // market blends (fit on dev subset with odds)
  const devOdds = dev.filter((r) => r.pMarket != null);
  const wV2Mkt = bestW(devOdds, (w) => blend2(mV2, mMarket, w));

  // ── league table ──
  const rows: Array<{ name: string; note: string; m: Model }> = [
    { name: "v1 (sim-elo-v2)", note: "tracked", m: mV1 },
    { name: "v2 (sim-recent-v1)", note: "tracked", m: mV2 },
    { name: "v3 (sim-recent-v2)", note: "tracked", m: mV3 },
    { name: "elo only", note: "component", m: mElo },
    { name: "home-always-54", note: "floor", m: mHome54 },
    { name: `blend v1×v2 (w=${wV1V2.w})`, note: "candidate", m: blend2(mV1, mV2, wV1V2.w) },
    { name: `blend v2×v3 (w=${wV2V3.w})`, note: "candidate", m: blend2(mV2, mV3, wV2V3.w) },
    { name: `blend v1×v2×v3 (${bestTri.wa}:${bestTri.wb}:${bestTri.wc})`, note: "candidate", m: blend3(mV1, mV2, mV3, bestTri.wa, bestTri.wb, bestTri.wc) },
    { name: "blend v1×v2×v3 (equal)", note: "candidate", m: blend3(mV1, mV2, mV3, 1, 1, 1) },
    { name: `v2 sim×elo rebalanced (wElo=${wSimElo.w})`, note: "candidate", m: blend2(mSim2, mElo, wSimElo.w) },
    { name: `pythag-30 log5 (h=${hPyVal.toFixed(2)})`, note: "leg", m: pythag30(hPyVal) },
    { name: `blend v2×pythag30 (w=${wV2Py.w})`, note: "candidate", m: blend2(mV2, pythag30(hPyVal), wV2Py.w) },
    { name: `v1 temperature (a=${(0.5 + aV1.w).toFixed(2)})`, note: "calibration", m: temp(mV1, 0.5 + aV1.w) },
    { name: `v2 temperature (a=${(0.5 + aV2.w).toFixed(2)})`, note: "calibration", m: temp(mV2, 0.5 + aV2.w) },
    { name: "v2 + schedule offset layer", note: "factors", m: mOffset },
    { name: "full stacker (sim,elo,factors)", note: "factors", m: mStack },
    { name: "3-logit ensemble (simV1,simV2,elo)", note: "candidate", m: mTri },
  ];

  const fmt = (name: string, note: string, d: ReturnType<typeof metrics>, t: ReturnType<typeof metrics>) =>
    console.log(
      `${name.padEnd(36)} ${note.padEnd(11)} dev ${(d.acc * 100).toFixed(1)}% ${d.brier.toFixed(4)}   test ${(t.acc * 100).toFixed(1)}% ${t.brier.toFixed(4)} ${t.logLoss.toFixed(4)} (n=${t.n})`,
    );
  console.log("═══ All games — model  dev acc/brier  ·  TEST acc/brier/logloss ═══");
  const scored = rows.map((r) => ({ ...r, d: evalOn(dev, r.m), t: evalOn(test, r.m) }));
  scored.sort((a, b) => a.t.brier - b.t.brier);
  for (const r of scored) fmt(r.name, r.note, r.d, r.t);

  // ── odds subset ──
  const testOdds = test.filter((r) => r.pMarket != null);
  console.log(`\n═══ Games with stored odds only (test n=${testOdds.length}) ═══`);
  const oddsRows: Array<{ name: string; m: Model }> = [
    { name: "market (devigged DK)", m: mMarket },
    { name: `blend v2×market (w=${wV2Mkt.w})`, m: blend2(mV2, mMarket, wV2Mkt.w) },
    { name: "blend v1×market (w=0.65, shipped)", m: blend2(mV1, mMarket, 0.65) },
    { name: "v2 (same subset)", m: mV2 },
    { name: "v1 (same subset)", m: mV1 },
  ];
  for (const r of oddsRows) {
    const d = evalOn(devOdds, r.m), t = evalOn(testOdds, r.m);
    fmt(r.name, "odds", d, t);
  }

  // ── walk-forward for finalists (refit before every date, full span) ──
  console.log("\n═══ Walk-forward (refit on all prior games, ≥150 history) ═══");
  const dates = Array.from(new Set(recs.map((r) => r.date))).sort();
  type WF = { name: string; predict: (hist: Rec[], day: Rec[]) => Array<[number, number]> };
  const wfs: WF[] = [
    {
      name: "blend v1×v2 (w refit)",
      predict: (hist, day) => {
        const w = bestW(hist, (w) => blend2(mV1, mV2, w)).w;
        const m = blend2(mV1, mV2, w);
        return day.map((r) => [m(r)!, r.y]);
      },
    },
    {
      name: "v2 + offset layer (refit)",
      predict: (hist, day) => {
        const fit = fitLogistic(hist.map((r) => ({ x: features(r), y: r.y, off: L(r.pV2) })));
        return day.map((r) => [applyLogistic(fit, features(r), L(r.pV2)), r.y]);
      },
    },
    {
      name: "v2 temperature (a refit)",
      predict: (hist, day) => {
        const a = 0.5 + bestW(hist, (a) => temp(mV2, 0.5 + a), 0, 1, 0.05).w;
        return day.map((r) => [temp(mV2, a)(r)!, r.y]);
      },
    },
    {
      name: "3-logit ensemble (refit)",
      predict: (hist, day) => {
        const fit = fitLogistic(hist.map((r) => ({ x: triX(r), y: r.y, off: 0 })), 0.01);
        return day.map((r) => [applyLogistic(fit, triX(r), 0), r.y]);
      },
    },
    {
      name: "full stacker (refit)",
      predict: (hist, day) => {
        const fit = fitLogistic(hist.map((r) => ({ x: stackX(r), y: r.y, off: 0 })));
        return day.map((r) => [applyLogistic(fit, stackX(r), 0), r.y]);
      },
    },
    {
      name: "v1 temperature (a refit)",
      predict: (hist, day) => {
        const a = 0.5 + bestW(hist, (a) => temp(mV1, 0.5 + a), 0, 1, 0.05).w;
        return day.map((r) => [temp(mV1, a)(r)!, r.y]);
      },
    },
    {
      name: "blend v2×market (w refit)",
      predict: (hist, day) => {
        const histOdds = hist.filter((r) => r.pMarket != null);
        const w = bestW(histOdds, (w) => blend2(mV2, mMarket, w)).w;
        const m = blend2(mV2, mMarket, w);
        return day.filter((r) => r.pMarket != null).map((r) => [m(r)!, r.y]);
      },
    },
    { name: "market (reference)", predict: (_h, day) => day.filter((r) => r.pMarket != null).map((r) => [r.pMarket!, r.y]) },
    { name: "v2 (reference, no refit)", predict: (_h, day) => day.map((r) => [r.pV2, r.y]) },
    { name: "v1 (reference, no refit)", predict: (_h, day) => day.map((r) => [r.pV1, r.y]) },
  ];
  for (const wf of wfs) {
    const pairs: Array<[number, number]> = [];
    for (const date of dates) {
      const hist = recs.filter((r) => r.date < date);
      if (hist.length < 150) continue;
      const day = recs.filter((r) => r.date === date);
      pairs.push(...wf.predict(hist, day));
    }
    const m = metrics(pairs);
    console.log(`${wf.name.padEnd(36)} acc ${(m.acc * 100).toFixed(1)}%  brier ${m.brier.toFixed(4)}  logloss ${m.logLoss.toFixed(4)}  (n=${m.n})`);
  }

  // ── head-to-head vs v2 for the top test candidate ──
  const top = scored.filter((s) => s.note === "candidate" || s.note === "factors")[0];
  if (top) {
    let dis = 0, right = 0;
    for (const r of test) {
      const p = top.m(r);
      if (p == null) continue;
      if ((p >= 0.5) !== (r.pV2 >= 0.5)) {
        dis++;
        if ((p >= 0.5 ? 1 : 0) === r.y) right++;
      }
    }
    console.log(`\nTop candidate on test: ${top.name} — disagreed with v2 on ${dis}, right on ${right}`);
  }

  console.log("\nOffset-layer coefficients (standardized):");
  FEATURES.forEach((f, j) => console.log(`  ${f.padEnd(10)} ${offFit.w[j] >= 0 ? "+" : ""}${offFit.w[j].toFixed(3)}`));
}

main().catch((err) => {
  console.error("💥 analyze failed:", err);
  process.exit(1);
});
