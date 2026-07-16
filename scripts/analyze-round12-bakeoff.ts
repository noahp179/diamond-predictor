#!/usr/bin/env -S npx tsx
/**
 * Round 12 — full model bake-off + best-effort improvement.
 *
 * Puts the positive/negative approach head-to-head against every model we track,
 * on the same frozen test window (2026-06-14 → 07-11, 376 games), then tries as
 * hard as possible to build something that beats the incumbents:
 *
 *   Incumbents (probs already stored in records-v5): Elo, Simulator (pV1),
 *   Recent Form (pV2), Bullpen (pV3), Lineup (pV5), Market, and Poisson
 *   (dcnb.json if the cache has been built).
 *
 *   Challengers we fit here (dev-fit, test-frozen):
 *     - Positive model / Negative model / their blend
 *     - Factor-All: one logistic over all 12 raw factor differentials
 *     - Stack (no market): logistic over the model probs, market withheld
 *     - Stack (+ market): same, market included
 *     - Market+residual: market as the base, our signal added on top
 *     - Temperature-calibrated best challenger
 *
 * Reports acc / Brier / log loss, a bootstrap CI on Brier vs the market for the
 * best challenger, and flat-stake betting ROI at the stored moneylines.
 *
 *   npx tsx scripts/analyze-round12-bakeoff.ts
 */

import { readFileSync, existsSync } from "node:fs";

const TEST_START = "2026-06-14";
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (p: number) => Math.min(0.995, Math.max(0.005, p));
const n0 = (x: unknown) => (typeof x === "number" && isFinite(x) ? x : 0);

interface Rec {
  date: string;
  gamePk: number;
  y: number;
  ml: [number, number]; // home, away moneyline
  probs: Record<string, number | null>; // incumbent model probs
  feat: number[]; // 12 raw factor differentials (home − away)
}

const FEAT_NAMES = [
  "offense", "form", "streak", "starter", "rest", "srest",
  "allowed", "penFatigue", "travelKm", "tz", "trip", "getaway",
];

function load(): Rec[] {
  const recs = readFileSync(".backtest-cache/records-v5.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const nov = new Map<number, any>(
    readFileSync(".backtest-cache/novel.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((n: any) => [n.gamePk, n]),
  );
  const dcnb: Record<string, number> = existsSync(".backtest-cache/dcnb.json")
    ? JSON.parse(readFileSync(".backtest-cache/dcnb.json", "utf8"))
    : {};

  return recs.map((r: any): Rec => {
    const f = r.f ?? {};
    const nv = nov.get(r.gamePk) ?? {};
    const rate = (rs: number, g: number) => (g > 0 ? rs / g : 4.5);
    return {
      date: r.date,
      gamePk: r.gamePk,
      y: r.y,
      ml: [n0(r.mlHome), n0(r.mlAway)],
      probs: {
        elo: r.pElo ?? null,
        sim: r.pV1 ?? null,
        recent: r.pV2 ?? null,
        bullpen: r.pV3 ?? null,
        lineup: r.pV5 ?? null,
        market: r.pMarket ?? null,
        poisson: dcnb[r.gamePk] ?? null,
      },
      feat: [
        rate(n0(f.rs30H), n0(f.g30H)) - rate(n0(f.rs30A), n0(f.g30A)),
        n0(f.l10H) - n0(f.l10A),
        n0(f.stkH) - n0(f.stkA),
        n0(f.sr3A) - n0(f.sr3H),
        n0(f.restH) - n0(f.restA),
        n0(f.srestH) - n0(f.srestA),
        rate(n0(f.ra30H), n0(f.g30H)) - rate(n0(f.ra30A), n0(f.g30A)),
        n0(nv.penBF2dH) - n0(nv.penBF2dA),
        n0(nv.km72H) - n0(nv.km72A),
        n0(nv.tzShiftH) - n0(nv.tzShiftA),
        n0(f.tripH) - n0(f.tripA),
        n0(nv.getawayH) - n0(nv.getawayA),
      ],
    };
  });
}

function metrics(pairs: Array<[number, number]>) {
  if (pairs.length === 0) return { n: 0, acc: NaN, brier: NaN, ll: NaN };
  let acc = 0, brier = 0, ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = clamp(p);
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = pairs.length;
  return { n, acc: acc / n, brier: brier / n, ll: ll / n };
}

function standardizer(rows: number[][]) {
  const d = rows[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j];
  for (let j = 0; j < d; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / rows.length) || 1;
  return (row: number[]) => row.map((v, j) => (v - mean[j]) / std[j]);
}

function fitLogistic(X: number[][], y: number[], lambda = 0.02, iters = 5000, lr = 0.2) {
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
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / N + lambda * w[j]);
  }
  return (row: number[]) => sigmoid(b + row.reduce((s, x, j) => s + x * w[j], 0));
}

const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Flat-stake ROI: 1u on the model's pick, paid at the stored moneyline. */
function roi(rows: Rec[], prob: (r: Rec) => number | null) {
  let bets = 0, units = 0, wins = 0;
  for (const r of rows) {
    const p = prob(r);
    if (p == null) continue;
    const home = p >= 0.5;
    const ml = home ? r.ml[0] : r.ml[1];
    if (!ml) continue;
    bets++;
    const won = home === (r.y === 1);
    if (won) { wins++; units += ml > 0 ? ml / 100 : 100 / -ml; } else units -= 1;
  }
  return { bets, units, wins, roi: bets ? units / bets : NaN };
}

function bootstrapBrierDiff(rows: Rec[], a: (r: Rec) => number, b: (r: Rec) => number, B = 3000) {
  // fraction of resamples where model A's Brier < model B's (A better)
  const n = rows.length;
  let aBetter = 0;
  for (let k = 0; k < B; k++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[(Math.random() * n) | 0];
      sa += (a(r) - r.y) ** 2;
      sb += (b(r) - r.y) ** 2;
    }
    if (sa < sb) aBetter++;
  }
  return aBetter / B;
}

function main() {
  const all = load();
  const dev = all.filter((r) => r.date < TEST_START);
  const test = all.filter((r) => r.date >= TEST_START);
  const hasPoisson = test.filter((r) => r.probs.poisson != null).length > test.length * 0.8;
  console.log(`Loaded ${all.length} games (dev ${dev.length} / test ${test.length}). Poisson cache: ${hasPoisson ? "present" : "MISSING — run scripts/_cache-dcnb.ts"}`);

  const y = dev.map((r) => r.y);

  // ── Challengers fit on dev ──────────────────────────────────────────────────
  // Positive / Negative / blend (best grouping: offense-side vs prevention-side)
  const POS = [0, 1, 2, 4, 5]; // offense, form, streak, rest, srest
  const NEG = [6, 3, 7, 8, 10]; // allowed, starter, penFatigue, travelKm, trip
  const sub = (r: Rec, idx: number[]) => idx.map((i) => r.feat[i]);
  const stdPos = standardizer(dev.map((r) => sub(r, POS)));
  const stdNeg = standardizer(dev.map((r) => sub(r, NEG)));
  const fPos = fitLogistic(dev.map((r) => stdPos(sub(r, POS))), y);
  const fNeg = fitLogistic(dev.map((r) => stdNeg(sub(r, NEG))), y);
  const pPos = (r: Rec) => fPos(stdPos(sub(r, POS)));
  const pNeg = (r: Rec) => fNeg(stdNeg(sub(r, NEG)));
  const pPosNeg = (r: Rec) => sigmoid((logit(clamp(pPos(r))) + logit(clamp(pNeg(r)))) / 2);

  // Factor-All: one logistic over all 12 differentials
  const stdAll = standardizer(dev.map((r) => r.feat));
  const fAll = fitLogistic(dev.map((r) => stdAll(r.feat)), y);
  const pFactorAll = (r: Rec) => fAll(stdAll(r.feat));

  // Stacks over incumbent model probs (as logits). Withhold games missing any input.
  const stackKeys = (withMarket: boolean, withPoisson: boolean) =>
    ["elo", "sim", "recent", ...(withPoisson ? ["poisson"] : []), ...(withMarket ? ["market"] : [])];
  const mkStack = (keys: string[], extraPos = false) => {
    const vec = (r: Rec) => [
      ...keys.map((k) => logit(clamp((r.probs[k] as number) ?? 0.5))),
      ...(extraPos ? [logit(clamp(pPos(r))), logit(clamp(pNeg(r)))] : []),
    ];
    const rowsOk = dev.filter((r) => keys.every((k) => r.probs[k] != null));
    const std = standardizer(rowsOk.map(vec));
    const fit = fitLogistic(rowsOk.map((r) => std(vec(r))), rowsOk.map((r) => r.y));
    return (r: Rec) => (keys.every((k) => r.probs[k] != null) ? fit(std(vec(r))) : null);
  };
  const pStackNoMkt = mkStack(stackKeys(false, hasPoisson), true);
  const pStackMkt = mkStack(stackKeys(true, hasPoisson), true);
  const pMarketPlus = mkStack(["market"], true); // market base + our pos/neg residual

  // Equal-weight logit-average ensembles — no fitting, so they can't overfit.
  const avgOf = (keys: string[]) => (r: Rec) => {
    const ls = keys.map((k) => r.probs[k]).filter((p): p is number => p != null).map((p) => logit(clamp(p)));
    return ls.length ? sigmoid(ls.reduce((a, b) => a + b, 0) / ls.length) : null;
  };
  const pAvg4 = avgOf(["elo", "sim", "recent", "poisson"]);
  const pAvg4Mkt = avgOf(["elo", "sim", "recent", "poisson", "market"]);

  // ── Leaderboard ─────────────────────────────────────────────────────────────
  const inc = (k: string) => (r: Rec) => r.probs[k] as number | null;
  const rowsFor = (f: (r: Rec) => number | null, set: Rec[]) =>
    set.flatMap((r) => { const p = f(r); return p == null ? [] : [[p, r.y] as [number, number]]; });

  const models: Array<[string, (r: Rec) => number | null]> = [
    ["Home-always", () => 1],
    ["Elo", inc("elo")],
    ["Simulator (v1)", inc("sim")],
    ["Recent Form (v2)", inc("recent")],
    ["Bullpen (v3)", inc("bullpen")],
    ["Lineup (v5)", inc("lineup")],
    ...(hasPoisson ? [["Poisson (DC-NB)", inc("poisson")] as [string, (r: Rec) => number | null]] : []),
    ["Market", inc("market")],
    ["— Positive", pPos],
    ["— Negative", pNeg],
    ["— Pos+Neg blend", pPosNeg],
    ["★ Factor-All", pFactorAll],
    ["★ Avg4 (equal)", pAvg4],
    ["★ Avg4 + market", pAvg4Mkt],
    ["★ Stack (no market)", pStackNoMkt],
    ["★ Stack (+ market)", pStackMkt],
    ["★ Market+residual", pMarketPlus],
  ];

  const scoreTable = (set: Rec[], label: string) => {
    console.log(`\n═══ ${label} ═══`);
    console.log("model                    n     acc     brier    logloss");
    const scored = models.map(([nm, f]) => {
      const m = metrics(rowsFor(f, set));
      return { nm, m };
    }).sort((a, b) => (isNaN(a.m.brier) ? 1 : a.m.brier) - (isNaN(b.m.brier) ? 1 : b.m.brier));
    for (const { nm, m } of scored) {
      console.log(`${nm.padEnd(24)} ${String(m.n).padStart(4)}  ${pctOf(m.acc).padStart(6)}  ${m.brier.toFixed(4)}   ${m.ll.toFixed(4)}`);
    }
  };
  scoreTable(dev, "DEV (in-sample reference)");
  scoreTable(test, "TEST — frozen (the verdict)");

  // ── Is the best challenger real vs the market? ──────────────────────────────
  const priced = test.filter((r) => r.probs.market != null);
  const challengers: Array<[string, (r: Rec) => number]> = [
    ["Avg4 + market", (r) => pAvg4Mkt(r) ?? (r.probs.market as number)],
    ["Avg4 (no market)", (r) => pAvg4(r) ?? 0.5],
    ["Stack (+ market)", (r) => pStackMkt(r) ?? (r.probs.market as number)],
    ["Market+residual", (r) => pMarketPlus(r) ?? (r.probs.market as number)],
    ["Poisson", (r) => (r.probs.poisson as number) ?? 0.5],
  ];
  console.log(`\n═══ Bootstrap: P(challenger Brier < Market Brier) on ${priced.length} priced test games ═══`);
  for (const [nm, f] of challengers) {
    const p = bootstrapBrierDiff(priced, f, (r) => r.probs.market as number);
    console.log(`  ${nm.padEnd(20)} ${(p * 100).toFixed(0)}%  ${p > 0.95 ? "★ beats market" : p < 0.05 ? "market wins" : "toss-up"}`);
  }

  // ── Betting ROI (flat stake at stored odds) ─────────────────────────────────
  console.log(`\n═══ Flat-stake ROI on priced test games ═══`);
  console.log("model                    bets   units    ROI");
  for (const [nm, f] of [
    ["Market", inc("market")],
    ["Recent Form", inc("recent")],
    ...(hasPoisson ? [["Poisson", inc("poisson")] as [string, (r: Rec) => number | null]] : []),
    ["Pos+Neg blend", pPosNeg],
    ["Stack (+ market)", pStackMkt],
    ["Market+residual", pMarketPlus],
  ] as Array<[string, (r: Rec) => number | null]>) {
    const rr = roi(test, f);
    console.log(`${nm.padEnd(24)} ${String(rr.bets).padStart(4)}  ${rr.units >= 0 ? "+" : ""}${rr.units.toFixed(1)}u   ${(rr.roi * 100).toFixed(1)}%`);
  }
}

main();
