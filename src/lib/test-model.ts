#!/usr/bin/env npx tsx
// test-model.ts
// Self-contained CLI test harness for v0.3 vs v0.4 model comparison.
// Hits the free MLB Stats API only — no Supabase required.
//
// Usage:
//   npx tsx src/lib/test-model.ts
//   npx tsx src/lib/test-model.ts --days=14
//   npx tsx src/lib/test-model.ts --start=2026-05-01 --end=2026-05-31

import { buildPredictionsForDate } from "./mlb-core";
import { buildPredictionsV4ForDate, MODEL_VERSION_V4 } from "./mlb-core-v4";
import { offsetDate } from "./mlb-features";

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
  );
  const days = parseInt(args.days ?? "7", 10);
  const today = new Date().toISOString().slice(0, 10);
  const end = args.end ?? offsetDate(today, -1);
  const start = args.start ?? offsetDate(end, -(days - 1));
  return { start, end, days };
}

// ─── Date range ───────────────────────────────────────────────────────────────

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = offsetDate(current, 1);
  }
  return dates;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface GameResult {
  gameId: number;
  date: string;
  home: string;
  away: string;
  winner: "home" | "away" | null;
  v3HomeProb: number;
  v4HomeProb: number;
}

function computeMetrics(results: GameResult[]) {
  const settled = results.filter((r) => r.winner != null);
  if (settled.length === 0) return null;

  const v3Correct = settled.filter(
    (r) => (r.v3HomeProb >= 0.5 ? "home" : "away") === r.winner,
  ).length;
  const v4Correct = settled.filter(
    (r) => (r.v4HomeProb >= 0.5 ? "home" : "away") === r.winner,
  ).length;

  const eps = 1e-7;
  const v3Brier =
    settled.reduce((s, r) => {
      const y = r.winner === "home" ? 1 : 0;
      return s + (r.v3HomeProb - y) ** 2;
    }, 0) / settled.length;
  const v4Brier =
    settled.reduce((s, r) => {
      const y = r.winner === "home" ? 1 : 0;
      return s + (r.v4HomeProb - y) ** 2;
    }, 0) / settled.length;

  const v3LogLoss =
    settled.reduce((s, r) => {
      const y = r.winner === "home" ? 1 : 0;
      const p = Math.min(1 - eps, Math.max(eps, r.v3HomeProb));
      return s - (y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }, 0) / settled.length;
  const v4LogLoss =
    settled.reduce((s, r) => {
      const y = r.winner === "home" ? 1 : 0;
      const p = Math.min(1 - eps, Math.max(eps, r.v4HomeProb));
      return s - (y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }, 0) / settled.length;

  return {
    total: results.length,
    settled: settled.length,
    v3: { correct: v3Correct, accuracy: v3Correct / settled.length, brier: v3Brier, logLoss: v3LogLoss },
    v4: { correct: v4Correct, accuracy: v4Correct / settled.length, brier: v4Brier, logLoss: v4LogLoss },
  };
}

// ─── Feature ablation ─────────────────────────────────────────────────────────

function featureSummary(results: GameResult[]) {
  const settled = results.filter((r) => r.winner != null);
  const agree = settled.filter(
    (r) =>
      (r.v3HomeProb >= 0.5 ? "home" : "away") ===
      (r.v4HomeProb >= 0.5 ? "home" : "away"),
  ).length;
  const disagree = settled.length - agree;
  const flipped = settled.filter(
    (r) =>
      (r.v3HomeProb >= 0.5 ? "home" : "away") !==
        (r.v4HomeProb >= 0.5 ? "home" : "away") &&
      (r.v4HomeProb >= 0.5 ? "home" : "away") === r.winner,
  ).length;
  return { agree, disagree, flippedToCorrect: flipped };
}

// ─── Printing ─────────────────────────────────────────────────────────────────

function pad(s: string, n: number) {
  return s.padEnd(n).slice(0, n);
}
function padL(s: string, n: number) {
  return s.padStart(n).slice(-n);
}

function printTable(metrics: NonNullable<ReturnType<typeof computeMetrics>>) {
  console.log("\n┌────────────┬─────────┬───────────┬──────────┬──────────────┐");
  console.log("│ Model      │ Correct │ Accuracy  │  Brier   │   Log-Loss   │");
  console.log("├────────────┼─────────┼───────────┼──────────┼──────────────┤");
  const row = (name: string, m: typeof metrics.v3) =>
    `│ ${pad(name, 10)} │ ${padL(String(m.correct), 7)} │ ${padL((m.accuracy * 100).toFixed(1) + "%", 9)} │ ${padL(m.brier.toFixed(4), 8)} │ ${padL(m.logLoss.toFixed(4), 12)} │`;
  console.log(row("v0.3", metrics.v3));
  console.log(row(MODEL_VERSION_V4, metrics.v4));
  console.log("└────────────┴─────────┴───────────┴──────────┴──────────────┘");

  const accDelta = ((metrics.v4.accuracy - metrics.v3.accuracy) * 100).toFixed(1);
  const brierDelta = (metrics.v4.brier - metrics.v3.brier).toFixed(4);
  const llDelta = (metrics.v4.logLoss - metrics.v3.logLoss).toFixed(4);
  console.log(`\n  Δ accuracy : ${accDelta.startsWith("-") ? "" : "+"}${accDelta}%`);
  console.log(`  Δ brier    : ${brierDelta.startsWith("-") ? "" : "+"}${brierDelta}  (negative = better)`);
  console.log(`  Δ log-loss : ${llDelta.startsWith("-") ? "" : "+"}${llDelta}  (negative = better)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { start, end, days } = parseArgs();
  console.log(`\n🔬  MLB Model Comparison: v0.3 vs ${MODEL_VERSION_V4}`);
  console.log(`    Testing ${start} → ${end} (up to ${days} days)\n`);

  const dates = dateRange(start, end);
  const allResults: GameResult[] = [];
  let datesWithGames = 0;

  for (const date of dates) {
    process.stdout.write(`  ${date}  fetching…`);
    try {
      // Run both models on the same date
      const [v3Games, v4Games] = await Promise.all([
        buildPredictionsForDate(date).catch(() => []),
        buildPredictionsV4ForDate(date).catch(() => []),
      ]);

      if (v3Games.length === 0) {
        process.stdout.write(`  (no games)\n`);
        continue;
      }

      datesWithGames++;
      const v4Map = new Map(v4Games.map((g) => [g.gameId, g]));
      const dayResults: GameResult[] = [];

      for (const g of v3Games) {
        const v4 = v4Map.get(g.gameId);
        if (!v4) continue;
        dayResults.push({
          gameId: g.gameId,
          date,
          home: g.home.name,
          away: g.away.name,
          winner: g.winner ?? null,
          v3HomeProb: g.homeWinProb,
          v4HomeProb: v4.v4WinProb,
        });
      }

      allResults.push(...dayResults);
      const settled = dayResults.filter((r) => r.winner != null).length;
      process.stdout.write(
        `  ${v3Games.length} games, ${settled} settled\n`,
      );
    } catch (err) {
      process.stdout.write(`  ERROR: ${(err as Error).message}\n`);
    }
  }

  console.log(`\n  Dates with games: ${datesWithGames} / ${dates.length}`);
  console.log(`  Total games: ${allResults.length}`);
  console.log(`  Settled: ${allResults.filter((r) => r.winner != null).length}`);

  const metrics = computeMetrics(allResults);
  if (!metrics || metrics.settled === 0) {
    console.log("\n  ⚠️  No settled games found in this date range. Try an earlier start date.\n");
    console.log("  Example: npx tsx src/lib/test-model.ts --start=2026-05-15 --days=14\n");
    return;
  }

  printTable(metrics);

  const fs = featureSummary(allResults);
  console.log(`\n  Models agreed on pick   : ${fs.agree} games`);
  console.log(`  Models disagreed         : ${fs.disagree} games`);
  console.log(`  v4 flipped to correct    : ${fs.flippedToCorrect} of ${fs.disagree} disagreements\n`);

  // Per-game breakdown for disagreements
  if (fs.disagree > 0) {
    console.log("  Games where models disagreed:");
    console.log("  ─────────────────────────────────────────────────────────────────");
    console.log("  Date       Home              Away              v0.3  v0.4  Result");
    console.log("  ─────────────────────────────────────────────────────────────────");
    for (const r of allResults.filter(
      (r) =>
        r.winner != null &&
        (r.v3HomeProb >= 0.5 ? "home" : "away") !== (r.v4HomeProb >= 0.5 ? "home" : "away"),
    ).slice(0, 20)) {
      const v3Pick = r.v3HomeProb >= 0.5 ? "HM" : "AW";
      const v4Pick = r.v4HomeProb >= 0.5 ? "HM" : "AW";
      const actual = r.winner === "home" ? "HM" : "AW";
      const v4Win = v4Pick === actual ? "✓" : "✗";
      console.log(
        `  ${r.date}  ${pad(r.home, 16)}  ${pad(r.away, 16)}  ${v3Pick}    ${v4Pick}    ${actual} ${v4Win}`,
      );
    }
    console.log("  ─────────────────────────────────────────────────────────────────\n");
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
