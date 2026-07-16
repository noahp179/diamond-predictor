#!/usr/bin/env -S npx tsx
/**
 * Round-11b: what do more Monte Carlo simulations actually buy?
 *
 * Assembles the production v2 inputs ONCE per game on the frozen test window
 * (Jun 14 – Jul 11, 376 games), then re-runs the same engine at
 * N = 250 … 50,000 sims/game with the production seed. Measures, per rung:
 *   - accuracy / Brier / log loss of the ×Elo ensemble
 *   - mean |Δp| and pick flips vs the 50,000-sim reference
 *   - wallclock
 * The theoretical MC noise is sqrt(p(1−p)/N) ≈ 0.5/√N per game — this study
 * shows where the empirical curve flattens and whether 3,000 (production) is
 * leaving anything on the table.
 *
 *   npx tsx scripts/sim-scaling-study.ts [--start 2026-06-14] [--end 2026-07-11]
 */

import { writeFileSync } from "node:fs";
import {
  computeElo,
  eloWinProb,
  fetchSeasonResults,
  leagueRates,
  reshapeStaff,
  simulateMatchup,
  type MatchupInputs,
  type StarterInfo,
  type TeamRates,
} from "../src/lib/mlb-sim";
import { fetchAllTeamRatesRecent, fetchStarterInfoRecent } from "../src/lib/mlb-recent-form";
import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const ens = (s: number, e: number) => sigmoid((logit(clamp01(s)) + logit(clamp01(e))) / 2);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dayBefore = (d: string) =>
  new Date(new Date(d + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);

function metrics(pairs: Array<[number, number]>) {
  const eps = 1e-7;
  let acc = 0, brier = 0, ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  return { n: pairs.length, acc: acc / pairs.length, brier: brier / pairs.length, logLoss: ll / pairs.length };
}

async function main() {
  const t0 = Date.now();
  const start = arg("start", "2026-06-14");
  const end = arg("end", "2026-07-11");
  const season = parseInt(start.slice(0, 4), 10);
  const LADDER = [250, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000];
  const REF = 50000;

  console.log("assembling production v2 inputs per game…");
  const schedRes = await fetchWithTimeout(
    `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher,team,venue&startDate=${start}&endDate=${end}`,
    45_000,
  );
  const schedJson: any = await schedRes.json();
  interface G { pk: number; date: string; inputs: MatchupInputs; pElo: number; y: number }
  const games: G[] = [];
  const [prev2, prev1] = await Promise.all([
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
  ]);

  for (const d of schedJson?.dates ?? []) {
    const date: string = d.date;
    const day = (d.games ?? []).filter((g: any) => {
      const st = g?.status?.detailedState ?? "";
      const hs = g?.teams?.home?.score, as = g?.teams?.away?.score;
      return /final|game over|completed/i.test(st) && typeof hs === "number" && typeof as === "number" && hs !== as;
    });
    if (day.length === 0) continue;
    const [seasonResults, teamRates] = await Promise.all([
      fetchSeasonResults(season, date),
      fetchAllTeamRatesRecent(season, date),
    ]);
    const elo = computeElo([prev2, prev1, seasonResults]);
    const lg = leagueRates(teamRates);
    const pitcherIds = new Set<number>();
    for (const g of day) {
      const hp = g.teams?.home?.probablePitcher?.id, ap = g.teams?.away?.probablePitcher?.id;
      if (hp) pitcherIds.add(hp);
      if (ap) pitcherIds.add(ap);
    }
    const starters = new Map<number, StarterInfo | null>();
    await batchedAll(Array.from(pitcherIds).map((id) => async () => {
      starters.set(id, await fetchStarterInfoRecent(id, season, date, lg));
    }), 8);
    for (const g of day) {
      const rates = (id: number): TeamRates => teamRates.get(id) ?? { batting: null, staff: null };
      const hR = rates(g.teams.home.team.id), aR = rates(g.teams.away.team.id);
      const hp = g.teams.home.probablePitcher?.id, ap = g.teams.away.probablePitcher?.id;
      games.push({
        pk: g.gamePk,
        date,
        y: g.teams.home.score > g.teams.away.score ? 1 : 0,
        pElo: eloWinProb(elo.get(g.teams.home.team.id) ?? 1500, elo.get(g.teams.away.team.id) ?? 1500),
        inputs: {
          homeBatting: hR.batting ?? lg,
          awayBatting: aR.batting ?? lg,
          homeStarter: (hp && starters.get(hp)) || null,
          awayStarter: (ap && starters.get(ap)) || null,
          homeStaff: reshapeStaff(hR.staff, lg),
          awayStaff: reshapeStaff(aR.staff, lg),
          league: lg,
          venue: g.venue?.name ?? null,
        },
      });
    }
    console.log(`  ${date}: ${day.length} games (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`inputs ready for ${games.length} games\n`);

  // Reference first, then the ladder.
  const probs = new Map<number, Map<number, number>>(); // N -> pk -> ensemble prob
  const timing: Record<number, number> = {};
  for (const N of [...LADDER].sort((a, b) => b - a)) {
    const tN = Date.now();
    const m = new Map<number, number>();
    for (const g of games) m.set(g.pk, ens(simulateMatchup(g.inputs, N, 2_000_000 + g.pk), g.pElo));
    probs.set(N, m);
    timing[N] = Date.now() - tN;
    console.log(`  N=${String(N).padStart(5)}  ${(timing[N] / 1000).toFixed(1)}s`);
  }

  const ref = probs.get(REF)!;
  console.log("\n═══ Monte Carlo depth ladder (frozen test window) ═══");
  console.log("N      acc     brier    logloss   mean|Δp| vs 50k  flips  sec");
  const rows: any[] = [];
  for (const N of LADDER) {
    const m = probs.get(N)!;
    const met = metrics(games.map((g) => [m.get(g.pk)!, g.y] as [number, number]));
    let dsum = 0, flips = 0;
    for (const g of games) {
      const a = m.get(g.pk)!, b = ref.get(g.pk)!;
      dsum += Math.abs(a - b);
      if ((a >= 0.5) !== (b >= 0.5)) flips++;
    }
    const row = {
      N, acc: met.acc, brier: met.brier, logLoss: met.logLoss,
      meanAbsDp: dsum / games.length, flips, sec: timing[N] / 1000,
      theoryNoise: 0.5 / Math.sqrt(N),
    };
    rows.push(row);
    console.log(
      `${String(N).padStart(5)}  ${(met.acc * 100).toFixed(1)}%  ${met.brier.toFixed(4)}  ${met.logLoss.toFixed(4)}   ${row.meanAbsDp.toFixed(4)}          ${String(flips).padStart(3)}   ${row.sec.toFixed(1)}`,
    );
  }
  writeFileSync(".backtest-cache/simscale.json", JSON.stringify({ games: games.length, rows }, null, 2));
  console.log(`\nsaved .backtest-cache/simscale.json  (total ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min)`);
}

main().catch((err) => { console.error("💥", err); process.exit(1); });
