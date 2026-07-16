#!/usr/bin/env -S npx tsx
/**
 * Round-11a: the soccer "Poisson goal simulator" family, ported to baseball
 * PROPERLY this time. Round 8's naïve Dixon-Coles port had no pitcher and pure
 * Poisson scoring — the two things baseball demands. This version grids:
 *
 *   distribution  Poisson vs Negative Binomial (r ∈ {3,5,8}) — baseball runs
 *                 are overdispersed (var ≈ 2×mean), which Poisson can't express
 *   starter γ     λ multiplied by (starter regressed RA/out ÷ league)^γ,
 *                 γ ∈ {0, 0.5, 1.0, 1.5} — soccer has no "today's pitcher"
 *   decay ξ       time-decay of past results, ξ ∈ {0, 0.01}/day
 *
 * Team attack/defense strengths refit EVERY date on results before that date
 * (walk-forward by construction). The only fitted knobs — combo + a confidence
 * temperature — are selected on dev (before 2026-06-14) and frozen for the
 * test window. Compared alone and as an ×Elo logit ensemble (the same help
 * v1/v2 get) against v1, v2 and the market from records-v5.jsonl.
 *
 *   npx tsx scripts/analyze-round11-poisson.ts
 */

import { readFileSync } from "node:fs";
import { fetchSeasonResults, type SeasonGameResult } from "../src/lib/mlb-sim";
import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const L = (p: number) => logit(clamp01(p));

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

// ─── Attack/defense Poisson-MLE fit (mean structure shared by Poisson & NB) ──

interface DCFit { mu: number; hfa: number; att: Map<number, number>; def: Map<number, number> }

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
    const gA = new Map<number, number>(), gD = new Map<number, number>();
    for (const t of teams) { gA.set(t, 0); gD.set(t, 0); }
    let gMu = 0, gH = 0, W = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i], wi = w[i];
      W += wi;
      const lh = Math.exp(mu + hfa + att.get(r.home)! - def.get(r.away)!);
      const la = Math.exp(mu + att.get(r.away)! - def.get(r.home)!);
      const eh = wi * (r.homeScore - lh), ea = wi * (r.awayScore - la);
      gMu += eh + ea; gH += eh;
      gA.set(r.home, gA.get(r.home)! + eh);
      gD.set(r.away, gD.get(r.away)! - eh);
      gA.set(r.away, gA.get(r.away)! + ea);
      gD.set(r.home, gD.get(r.home)! - ea);
    }
    mu += (lr * gMu) / (2 * W); hfa += (lr * gH) / W;
    let mA = 0, mD = 0;
    for (const t of teams) {
      att.set(t, att.get(t)! + (lr * gA.get(t)!) / W);
      def.set(t, def.get(t)! + (lr * gD.get(t)!) / W);
      mA += att.get(t)!; mD += def.get(t)!;
    }
    for (const t of teams) { att.set(t, att.get(t)! - mA / teams.size); def.set(t, def.get(t)! - mD / teams.size); }
  }
  return { mu, hfa, att, def };
}

// ─── Scoring distributions ────────────────────────────────────────────────────

const N_MAX = 30;
function poisPmf(lambda: number): number[] {
  const out = new Array(N_MAX);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k < N_MAX; k++) out[k] = (out[k - 1] * lambda) / k;
  return out;
}
/** Negative binomial with mean λ, dispersion r (variance λ(1+λ/r)). */
function nbPmf(lambda: number, r: number): number[] {
  const p = r / (r + lambda);
  const out = new Array(N_MAX);
  out[0] = Math.pow(p, r);
  for (let k = 1; k < N_MAX; k++) out[k] = out[k - 1] * ((k - 1 + r) / k) * (1 - p);
  return out;
}

function winProb(lh: number, la: number, dist: string): number {
  const ph = dist === "pois" ? poisPmf(lh) : nbPmf(lh, Number(dist.slice(2)));
  const pa = dist === "pois" ? poisPmf(la) : nbPmf(la, Number(dist.slice(2)));
  let win = 0, tie = 0;
  for (let h = 0; h < N_MAX; h++) for (let a = 0; a < N_MAX; a++) {
    const q = ph[h] * pa[a];
    if (h > a) win += q; else if (h === a) tie += q;
  }
  return win + tie * 0.52;
}

// ─── Starter runs-per-out, point-in-time from game logs ───────────────────────

interface StartLog { date: string; gs: number; outs: number; runs: number }
async function fetchStarterGameLog(personId: number, season: number): Promise<StartLog[]> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    return splits.map((s) => {
      const st = s.stat ?? {};
      const p = String(st.inningsPitched ?? "0.0").split(".");
      return { date: s.date ?? "", gs: st.gamesStarted ?? 0, outs: (parseInt(p[0], 10) || 0) * 3 + (p[1] ? parseInt(p[1], 10) : 0), runs: st.runs ?? 0 };
    });
  } catch {
    return [];
  }
}

async function main() {
  const t0 = Date.now();
  const recs: any[] = readFileSync(".backtest-cache/records-v5.jsonl", "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const byPk = new Map(recs.map((r) => [r.gamePk, r]));
  const season = 2026;
  const testStart = "2026-06-14";

  // Schedule with probables for starter identities (one call).
  const schedRes = await fetchWithTimeout(
    `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher&startDate=${season}-03-01&endDate=2026-07-11`,
    60_000,
  );
  const schedJson: any = await schedRes.json();
  const probables = new Map<number, { hp: number | null; ap: number | null }>();
  const starterIds = new Set<number>();
  for (const d of schedJson?.dates ?? []) for (const g of d?.games ?? []) {
    const hp = g.teams?.home?.probablePitcher?.id ?? null, ap = g.teams?.away?.probablePitcher?.id ?? null;
    probables.set(g.gamePk, { hp, ap });
    if (byPk.has(g.gamePk)) { if (hp) starterIds.add(hp); if (ap) starterIds.add(ap); }
  }
  console.log(`probable starters for study games: ${starterIds.size}`);
  const logById = new Map<number, StartLog[]>();
  await batchedAll(Array.from(starterIds).map((id) => async () => {
    logById.set(id, await fetchStarterGameLog(id, season));
  }), 10);

  /** Starter regressed runs-per-out entering `date` relative to league. */
  const PRIOR_OUTS = 90;
  const lgRPO = 4.6 / 27; // league runs per out (≈ per-team R/G ÷ 27)
  const sFactor = (pid: number | null, date: string): number => {
    if (!pid) return 1;
    const log = (logById.get(pid) ?? []).filter((a) => a.date < date && a.gs > 0);
    let outs = 0, runs = 0;
    for (const a of log) { outs += a.outs; runs += a.runs; }
    if (outs < 30) return 1;
    const rpo = (runs + lgRPO * PRIOR_OUTS) / (outs + PRIOR_OUTS);
    return rpo / lgRPO;
  };

  // Per-date walk-forward fits.
  const dates = Array.from(new Set(recs.map((r) => r.date))).sort();
  const resultsByDate = new Map<string, SeasonGameResult[]>();
  for (const d of dates) resultsByDate.set(d, await fetchSeasonResults(season, d));
  console.log(`season snapshots: ${dates.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  const XIS = [0, 0.01];
  const fits = new Map<string, DCFit>(); // `${date}|${xi}`
  for (const d of dates) {
    const hist = resultsByDate.get(d)!;
    if (hist.length < 150) continue;
    for (const xi of XIS) fits.set(`${d}|${xi}`, fitDC(hist, d, xi));
  }
  console.log(`fits done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // Raw win prob per combo per game.
  const DISTS = ["pois", "nb3", "nb5", "nb8"];
  const GAMMAS = [0, 0.5, 1.0, 1.5];
  const pred = new Map<string, Map<number, number>>(); // combo -> pk -> p
  for (const xi of XIS) for (const dist of DISTS) for (const g of GAMMAS) pred.set(`${dist}|g${g}|x${xi}`, new Map());
  for (const r of recs) {
    for (const xi of XIS) {
      const fit = fits.get(`${r.date}|${xi}`);
      if (!fit || !fit.att.has(r.homeId) || !fit.att.has(r.awayId)) continue;
      const pb = probables.get(r.gamePk) ?? { hp: null, ap: null };
      const lh0 = Math.exp(fit.mu + fit.hfa + fit.att.get(r.homeId)! - fit.def.get(r.awayId)!);
      const la0 = Math.exp(fit.mu + fit.att.get(r.awayId)! - fit.def.get(r.homeId)!);
      const fH = sFactor(pb.ap, r.date); // home batting faces AWAY starter
      const fA = sFactor(pb.hp, r.date);
      for (const g of GAMMAS) {
        const lh = lh0 * Math.pow(fH, g), la = la0 * Math.pow(fA, g);
        for (const dist of DISTS) pred.get(`${dist}|g${g}|x${xi}`)!.set(r.gamePk, winProb(lh, la, dist));
      }
    }
  }

  // Dev-select combo + temperature; score frozen test, alone and ×Elo.
  const dev = recs.filter((r) => r.date < testStart);
  const test = recs.filter((r) => r.date >= testStart);
  const evalCombo = (set: any[], combo: string, a: number, withElo: boolean) =>
    metrics(set.flatMap((r) => {
      const p = pred.get(combo)!.get(r.gamePk);
      if (p == null) return [];
      const pc = sigmoid(a * L(p));
      const out = withElo ? sigmoid((L(pc) + L(r.pElo)) / 2) : pc;
      return [[out, r.y] as [number, number]];
    }));

  let best = { combo: "", a: 1, brier: Infinity };
  for (const combo of pred.keys()) {
    for (let a = 0.3; a <= 1.4001; a += 0.05) {
      const m = evalCombo(dev, combo, a, false);
      if (m.n > 500 && m.brier < best.brier) best = { combo, a: Number(a.toFixed(2)), brier: m.brier };
    }
  }
  console.log(`\ndev-selected: ${best.combo} temperature a=${best.a} (dev brier ${best.brier.toFixed(4)})`);

  const fmt = (nm: string, m: ReturnType<typeof metrics>) =>
    console.log(`  ${nm.padEnd(30)} n=${m.n}  acc=${(m.acc * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`);

  console.log("\n═══ Frozen test window ═══");
  fmt("NB/starter DC (selected)", evalCombo(test, best.combo, best.a, false));
  fmt("  + Elo ensemble", evalCombo(test, best.combo, best.a, true));
  fmt("naive Poisson γ=0 (Round-8 port)", evalCombo(test, "pois|g0|x0", 0.4, false));
  fmt("v1 (headline)", metrics(test.map((r) => [r.pV1, r.y] as [number, number])));
  fmt("v2 (recent form)", metrics(test.map((r) => [r.pV2, r.y] as [number, number])));
  fmt("market", metrics(test.filter((r) => r.pMarket != null).map((r) => [r.pMarket, r.y] as [number, number])));

  console.log("\n═══ Ablation on dev (each knob's contribution, a re-tuned per row) ═══");
  const bestFor = (combo: string) => {
    let b = { a: 1, brier: Infinity };
    for (let a = 0.3; a <= 1.4001; a += 0.05) {
      const m = evalCombo(dev, combo, a, false);
      if (m.n > 500 && m.brier < b.brier) b = { a, brier: m.brier };
    }
    return b;
  };
  const [dSel, gSel, xSel] = best.combo.split("|");
  for (const row of [
    ["pure Poisson, no starter", `pois|g0|${xSel}`],
    [`${dSel}, no starter`, `${dSel}|g0|${xSel}`],
    [`pure Poisson, starter ${gSel}`, `pois|${gSel}|${xSel}`],
    [`selected (${best.combo})`, best.combo],
  ] as const) {
    const b = bestFor(row[1]);
    console.log(`  ${row[0].padEnd(34)} dev brier ${b.brier.toFixed(4)} (a=${b.a.toFixed(2)})`);
  }
  console.log(`\ntotal ${(Date.now() - t0) / 1000 | 0}s`);
}

main().catch((err) => { console.error("💥", err); process.exit(1); });
