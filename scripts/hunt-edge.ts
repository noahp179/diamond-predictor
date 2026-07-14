#!/usr/bin/env -S npx tsx
/**
 * Round-8 edge hunt: five independent attacks on the sportsbook line.
 *
 *   npx tsx scripts/hunt-edge.ts [--in .backtest-cache/records.jsonl]
 *                                [--market .backtest-cache/market-early.jsonl]
 *                                [--test-start 2026-06-14]
 *
 *   1. DEVIG SHOOTOUT — proportional vs Shin vs power vig removal. If the
 *      standard devig mis-handles the favorite-longshot effect, a better
 *      transform of the book's own numbers beats "the market" benchmark.
 *   2. BIAS SCAN — favorite/underdog levels, home/away, day/night: implied vs
 *      actual win rate and the flat-bet ROI of always taking that side, with
 *      bootstrap 90% CIs and split-half consistency.
 *   3. DIXON-COLES — the model family that historically found edges in soccer
 *      markets: time-decayed attack/defense strengths fit by Poisson MLE on
 *      season-to-date scores, win prob from the score grid, refit walk-forward
 *      every date, temperature-calibrated on dev.
 *   4. RESIDUAL INFORMATION TEST — walk-forward logistic with the market as a
 *      fixed offset: do our sims, Elo, disagreement size, or context factors
 *      carry ANY information the line misses?
 *   5. BETTING RULES — vig-inclusive expected-value thresholds per model:
 *      bet a side when the model's edge over the break-even probability
 *      exceeds t. Thresholds picked on dev, frozen on test, plus fixed-t
 *      walk-forward ROI with bootstrap CIs.
 *
 * Pre-committed bar for claiming an edge: walk-forward ROI > 0 with a 90%
 * bootstrap CI excluding 0 AND the same sign in both date-halves — or a
 * walk-forward Brier at least 0.001 better than the market's. Anything less
 * is reported as "no edge."
 *
 * Read-only; only network use is per-date season results for Dixon-Coles.
 */

import { readFileSync, existsSync } from "node:fs";
import { fetchSeasonResults, type SeasonGameResult } from "../src/lib/mlb-sim";

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const L = (p: number) => logit(clamp01(p));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Rec {
  date: string;
  gamePk: number;
  homeId?: number;
  awayId?: number;
  y: number;
  hourUTC: number | null;
  mlHome: number | null;
  mlAway: number | null;
  pSimV1?: number;
  pSimV2?: number;
  pElo?: number;
  pV1?: number;
  pV2?: number;
  f?: Record<string, number | null>;
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

// ─── Devig methods ────────────────────────────────────────────────────────────

const impl = (ml: number) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
/** Winning a 1u flat stake at American odds pays this profit. */
const payout = (ml: number) => (ml > 0 ? ml / 100 : 100 / -ml);

function devigProp(mlH: number, mlA: number): number {
  const qh = impl(mlH), qa = impl(mlA);
  return qh / (qh + qa);
}

/** Shin (1992) devig, two-outcome closed form solved by bisection on z. */
function devigShin(mlH: number, mlA: number): number {
  const qh = impl(mlH), qa = impl(mlA);
  const B = qh + qa;
  const p = (q: number, z: number) => (Math.sqrt(z * z + 4 * (1 - z) * (q * q) / B) - z) / (2 * (1 - z));
  let lo = 0, hi = 0.25;
  for (let i = 0; i < 60; i++) {
    const z = (lo + hi) / 2;
    const s = p(qh, z) + p(qa, z);
    if (s > 1) hi = z; else lo = z;
  }
  const z = (lo + hi) / 2;
  return p(qh, z) / (p(qh, z) + p(qa, z));
}

/** Power devig: p_i = q_i^k with k solved so probabilities sum to 1. */
function devigPower(mlH: number, mlA: number): number {
  const qh = impl(mlH), qa = impl(mlA);
  let lo = 1, hi = 3;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    const s = Math.pow(qh, k) + Math.pow(qa, k);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return Math.pow(qh, k) / (Math.pow(qh, k) + Math.pow(qa, k));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 90% bootstrap CI for mean of `xs` (2,000 resamples, seeded). */
function bootCI(xs: number[], seed = 7): [number, number] {
  if (xs.length === 0) return [NaN, NaN];
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[(rnd() * xs.length) | 0];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.05 * 2000)], means[Math.floor(0.95 * 2000)]];
}

// ─── Dixon-Coles style attack/defense Poisson model ──────────────────────────

interface DCFit {
  mu: number;
  hfa: number;
  att: Map<number, number>;
  def: Map<number, number>;
}

function fitDC(results: SeasonGameResult[], asOf: string, xi: number): DCFit {
  const teams = new Set<number>();
  for (const r of results) { teams.add(r.home); teams.add(r.away); }
  const att = new Map<number, number>(), def = new Map<number, number>();
  for (const t of teams) { att.set(t, 0); def.set(t, 0); }
  let mu = Math.log(4.5), hfa = 0.02;
  const t0 = new Date(asOf + "T00:00:00Z").getTime();
  const w = results.map((r) => Math.exp((-xi * (t0 - new Date(r.date + "T00:00:00Z").getTime())) / 86400000));
  const lr = 0.06;
  for (let it = 0; it < 350; it++) {
    const gAtt = new Map<number, number>(), gDef = new Map<number, number>();
    for (const t of teams) { gAtt.set(t, 0); gDef.set(t, 0); }
    let gMu = 0, gHfa = 0, W = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i], wi = w[i];
      W += wi;
      const lh = Math.exp(mu + hfa + att.get(r.home)! - def.get(r.away)!);
      const la = Math.exp(mu + att.get(r.away)! - def.get(r.home)!);
      const eh = wi * (r.homeScore - lh), ea = wi * (r.awayScore - la);
      gMu += eh + ea; gHfa += eh;
      gAtt.set(r.home, gAtt.get(r.home)! + eh);
      gDef.set(r.away, gDef.get(r.away)! - eh);
      gAtt.set(r.away, gAtt.get(r.away)! + ea);
      gDef.set(r.home, gDef.get(r.home)! - ea);
    }
    mu += (lr * gMu) / (2 * W); hfa += (lr * gHfa) / W;
    let mA = 0, mD = 0;
    for (const t of teams) {
      att.set(t, att.get(t)! + (lr * gAtt.get(t)!) / W);
      def.set(t, def.get(t)! + (lr * gDef.get(t)!) / W);
      mA += att.get(t)!; mD += def.get(t)!;
    }
    // identifiability: keep attack/defense centered
    for (const t of teams) { att.set(t, att.get(t)! - mA / teams.size); def.set(t, def.get(t)! - mD / teams.size); }
  }
  return { mu, hfa, att, def };
}

const poisCache = new Map<string, number[]>();
function poisPmf(lambda: number): number[] {
  const key = lambda.toFixed(3);
  const hit = poisCache.get(key);
  if (hit) return hit;
  const N = 26, out = new Array(N);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k < N; k++) out[k] = (out[k - 1] * lambda) / k;
  poisCache.set(key, out);
  return out;
}

function dcWinProb(fit: DCFit, home: number, away: number): number | null {
  if (!fit.att.has(home) || !fit.att.has(away)) return null;
  const lh = Math.exp(fit.mu + fit.hfa + fit.att.get(home)! - fit.def.get(away)!);
  const la = Math.exp(fit.mu + fit.att.get(away)! - fit.def.get(home)!);
  const ph = poisPmf(lh), pa = poisPmf(la);
  let win = 0, tie = 0;
  for (let h = 0; h < 26; h++) {
    for (let a = 0; a < 26; a++) {
      const p = ph[h] * pa[a];
      if (h > a) win += p;
      else if (h === a) tie += p;
    }
  }
  return win + tie * 0.52; // regulation tie → extra innings, slight home edge
}

// ─── Logistic with offset (for the residual test) ─────────────────────────────

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const recs: Rec[] = readFileSync(arg("in", ".backtest-cache/records.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gamePk - b.gamePk));
  const marketPath = arg("market", ".backtest-cache/market-early.jsonl");
  const early: Rec[] = existsSync(marketPath)
    ? readFileSync(marketPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];
  const testStart = arg("test-start", "2026-06-14");

  const withOdds = recs.filter((r) => r.mlHome != null && r.mlAway != null);
  const allMkt: Rec[] = [...early, ...withOdds].sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`model records: ${recs.length} (${recs[0].date} → ${recs[recs.length - 1].date}), with odds ${withOdds.length}`);
  console.log(`market-only sample incl. early season: ${allMkt.length} games (${allMkt[0]?.date} → ${allMkt[allMkt.length - 1]?.date})\n`);

  // ═══ 1. Devig shootout ═══
  console.log("═══ 1 · Devig shootout (all games with a line) ═══");
  const devigs: Array<[string, (h: number, a: number) => number]> = [
    ["proportional (shipped)", devigProp],
    ["Shin", devigShin],
    ["power", devigPower],
  ];
  for (const [nm, f] of devigs) {
    const m = metrics(allMkt.map((r) => [f(r.mlHome!, r.mlAway!), r.y] as [number, number]));
    console.log(`  ${nm.padEnd(24)} n=${m.n}  acc=${(m.acc * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`);
  }

  // ═══ 2. Bias scan ═══
  console.log("\n═══ 2 · Market bias scan — implied vs actual + flat-bet ROI (90% CI) ═══");
  const half = allMkt[Math.floor(allMkt.length / 2)].date;
  interface Pocket { nm: string; sel: (r: Rec) => { side: "H" | "A" } | null }
  const pockets: Pocket[] = [
    { nm: "home favorites", sel: (r) => (devigProp(r.mlHome!, r.mlAway!) > 0.5 ? { side: "H" } : null) },
    { nm: "road favorites", sel: (r) => (devigProp(r.mlHome!, r.mlAway!) < 0.5 ? { side: "A" } : null) },
    { nm: "home underdogs", sel: (r) => (devigProp(r.mlHome!, r.mlAway!) < 0.5 ? { side: "H" } : null) },
    { nm: "road underdogs", sel: (r) => (devigProp(r.mlHome!, r.mlAway!) > 0.5 ? { side: "A" } : null) },
    { nm: "big favorites (>60%)", sel: (r) => { const p = devigProp(r.mlHome!, r.mlAway!); return p > 0.6 ? { side: "H" } : p < 0.4 ? { side: "A" } : null; } },
    { nm: "big underdogs (<40%)", sel: (r) => { const p = devigProp(r.mlHome!, r.mlAway!); return p < 0.4 ? { side: "H" } : p > 0.6 ? { side: "A" } : null; } },
    { nm: "coin flips (47–53%)", sel: (r) => { const p = devigProp(r.mlHome!, r.mlAway!); return p >= 0.47 && p <= 0.53 ? { side: "H" } : null; } },
    { nm: "day games — home side", sel: (r) => (r.hourUTC != null && r.hourUTC <= 19 ? { side: "H" } : null) },
    { nm: "night games — home side", sel: (r) => (r.hourUTC != null && r.hourUTC > 19 ? { side: "H" } : null) },
  ];
  for (const pk of pockets) {
    const profits: number[] = [];
    let nImp = 0, sImp = 0, sAct = 0;
    let h1 = 0, n1 = 0, h2 = 0, n2 = 0;
    for (const r of allMkt) {
      const s = pk.sel(r);
      if (!s) continue;
      const ml = s.side === "H" ? r.mlHome! : r.mlAway!;
      const pImp = s.side === "H" ? devigProp(r.mlHome!, r.mlAway!) : 1 - devigProp(r.mlHome!, r.mlAway!);
      const won = s.side === "H" ? r.y === 1 : r.y === 0;
      const profit = won ? payout(ml) : -1;
      profits.push(profit);
      nImp++; sImp += pImp; sAct += won ? 1 : 0;
      if (r.date < half) { n1++; h1 += profit; } else { n2++; h2 += profit; }
    }
    if (profits.length < 30) continue;
    const roi = profits.reduce((a, b) => a + b, 0) / profits.length;
    const [lo, hi] = bootCI(profits);
    const consistent = Math.sign(h1 / Math.max(1, n1)) === Math.sign(h2 / Math.max(1, n2));
    console.log(
      `  ${pk.nm.padEnd(26)} n=${String(nImp).padStart(4)}  implied=${((sImp / nImp) * 100).toFixed(1)}%  actual=${((sAct / nImp) * 100).toFixed(1)}%  ROI=${(roi * 100).toFixed(1)}%  CI[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  halves ${consistent ? "same sign" : "FLIP"}`,
    );
  }

  // ═══ 3. Dixon-Coles walk-forward ═══
  console.log("\n═══ 3 · Dixon-Coles attack/defense model (walk-forward refit daily) ═══");
  const season = parseInt(recs[0].date.slice(0, 4), 10);
  const dates = Array.from(new Set(recs.map((r) => r.date))).sort();
  const resultsByDate = new Map<string, SeasonGameResult[]>();
  for (const d of dates) resultsByDate.set(d, await fetchSeasonResults(season, d));
  console.log(`  season results fetched for ${dates.length} dates`);

  const XIS = [0, 0.005, 0.01, 0.02];
  const dcPred = new Map<string, Map<number, number>>(); // xi -> gamePk -> prob
  for (const xi of XIS) dcPred.set(String(xi), new Map());
  for (const d of dates) {
    const hist = resultsByDate.get(d)!;
    if (hist.length < 150) continue;
    const day = recs.filter((r) => r.date === d);
    for (const xi of XIS) {
      const fit = fitDC(hist, d, xi);
      for (const g of day) {
        const p = dcWinProb(fit, g.homeId!, g.awayId!);
        if (p != null) dcPred.get(String(xi))!.set(g.gamePk, p);
      }
    }
  }
  // dev-select xi and a temperature for the DC output
  const dev = recs.filter((r) => r.date < testStart);
  const test = recs.filter((r) => r.date >= testStart);
  let best = { xi: "0", a: 1, brier: Infinity };
  for (const xi of XIS.map(String)) {
    for (let a = 0.4; a <= 1.2001; a += 0.05) {
      const pairs = dev
        .filter((r) => dcPred.get(xi)!.has(r.gamePk))
        .map((r) => [sigmoid(a * L(dcPred.get(xi)!.get(r.gamePk)!)), r.y] as [number, number]);
      if (pairs.length < 200) continue;
      const b = metrics(pairs).brier;
      if (b < best.brier) best = { xi, a: Number(a.toFixed(2)), brier: b };
    }
  }
  const dcOf = (r: Rec): number | null => {
    const p = dcPred.get(best.xi)!.get(r.gamePk);
    return p == null ? null : sigmoid(best.a * L(p));
  };
  console.log(`  dev-selected: decay xi=${best.xi}/day, temperature a=${best.a}`);
  for (const [nm, set] of [["dev", dev], ["test (frozen)", test]] as const) {
    const pairs = (set as Rec[]).map((r) => [dcOf(r), r.y] as [number | null, number]).filter(([p]) => p != null) as Array<[number, number]>;
    const m = metrics(pairs);
    console.log(`  DC ${String(nm).padEnd(14)} n=${m.n}  acc=${(m.acc * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`);
  }
  const mktPairs = test.filter((r) => r.mlHome != null).map((r) => [devigShin(r.mlHome!, r.mlAway!), r.y] as [number, number]);
  console.log(`  market (Shin) test     n=${mktPairs.length}  brier=${metrics(mktPairs).brier.toFixed(4)}  (the bar)`);

  // ═══ 4. Residual information test ═══
  console.log("\n═══ 4 · What does the market NOT know? (walk-forward, offset = Shin market) ═══");
  const featNames = ["v2−mkt", "v1−mkt", "elo−mkt", "DC−mkt", "sim spread", "rest diff", "starter-rest diff"];
  const featOf = (r: Rec, pm: number): number[] => {
    const dc = dcOf(r);
    return [
      L(r.pV2!) - L(pm),
      L(r.pV1!) - L(pm),
      L(r.pElo!) - L(pm),
      dc == null ? 0 : L(dc) - L(pm),
      Math.abs(L(r.pSimV1!) - L(r.pSimV2!)),
      ((r.f?.restH as number) ?? 1) - ((r.f?.restA as number) ?? 1),
      ((r.f?.srestH as number) ?? 5) - ((r.f?.srestA as number) ?? 5),
    ];
  };
  const wfPairs: Array<[number, number]> = [];
  const wfMktPairs: Array<[number, number]> = [];
  for (const d of dates) {
    const hist = withOdds.filter((r) => r.date < d);
    if (hist.length < 200) continue;
    const day = withOdds.filter((r) => r.date === d);
    if (day.length === 0) continue;
    const fit = fitLogistic(hist.map((r) => {
      const pm = devigShin(r.mlHome!, r.mlAway!);
      return { x: featOf(r, pm), y: r.y, off: L(pm) };
    }));
    for (const r of day) {
      const pm = devigShin(r.mlHome!, r.mlAway!);
      wfPairs.push([applyLogistic(fit, featOf(r, pm), L(pm)), r.y]);
      wfMktPairs.push([pm, r.y]);
    }
  }
  const mR = metrics(wfPairs), mM = metrics(wfMktPairs);
  console.log(`  market alone           n=${mM.n}  brier=${mM.brier.toFixed(4)}  logloss=${mM.logLoss.toFixed(4)}`);
  console.log(`  market + our signals   n=${mR.n}  brier=${mR.brier.toFixed(4)}  logloss=${mR.logLoss.toFixed(4)}`);
  const finalFit = fitLogistic(withOdds.map((r) => {
    const pm = devigShin(r.mlHome!, r.mlAway!);
    return { x: featOf(r, pm), y: r.y, off: L(pm) };
  }));
  console.log("  full-sample standardized coefficients (0 = market already knows it):");
  featNames.forEach((nm, j) => console.log(`    ${nm.padEnd(18)} ${finalFit.w[j] >= 0 ? "+" : ""}${finalFit.w[j].toFixed(3)}`));

  // ═══ 5. Betting rules (vig-inclusive EV thresholds) ═══
  console.log("\n═══ 5 · Betting rules — bet when model edge over break-even > t ═══");
  const pV4 = (r: Rec) => sigmoid(0.6 * L(r.pV2!));
  const models: Array<[string, (r: Rec) => number | null]> = [
    ["v1", (r) => r.pV1!],
    ["v2", (r) => r.pV2!],
    ["v4 (calibrated)", pV4],
    ["DC", dcOf],
  ];
  const evOf = (p: number, ml: number) => p * payout(ml) - (1 - p);
  for (const [nm, model] of models) {
    for (const t of [0.0, 0.03, 0.06]) {
      const profits: number[] = [];
      let h1 = 0, n1 = 0, h2 = 0, n2 = 0;
      for (const r of withOdds) {
        const p = model(r);
        if (p == null) continue;
        const evH = evOf(p, r.mlHome!), evA = evOf(1 - p, r.mlAway!);
        const side = evH >= evA ? "H" : "A";
        const ev = Math.max(evH, evA);
        if (ev <= t) continue;
        const won = side === "H" ? r.y === 1 : r.y === 0;
        const profit = won ? payout(side === "H" ? r.mlHome! : r.mlAway!) : -1;
        profits.push(profit);
        if (r.date < half) { n1++; h1 += profit; } else { n2++; h2 += profit; }
      }
      if (profits.length < 25) continue;
      const roi = profits.reduce((a, b) => a + b, 0) / profits.length;
      const [lo, hi] = bootCI(profits);
      const consistent = n1 > 0 && n2 > 0 && Math.sign(h1 / n1) === Math.sign(h2 / n2);
      console.log(
        `  ${nm.padEnd(17)} t=${t.toFixed(2)}  bets=${String(profits.length).padStart(4)}  ROI=${(roi * 100).toFixed(1)}%  CI[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  halves ${consistent ? "same sign" : "flip"}`,
      );
    }
  }
  console.log("\nEdge bar (pre-committed): WF ROI>0 with CI excluding 0 AND same-sign halves, or WF brier ≤ market − 0.001.");
}

main().catch((err) => {
  console.error("💥 hunt failed:", err);
  process.exit(1);
});
