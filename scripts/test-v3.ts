#!/usr/bin/env bun
/**
 * Algorithm V2 (sim-elo-v3) test script — live data, read-only.
 *
 *   bun scripts/test-v3.ts             # Run for today
 *   bun scripts/test-v3.ts 2026-07-11  # Run for a specific date
 *
 * Prints the sim-elo-v2 ensemble next to sim-elo-v3's final probability so
 * the schedule-strength and context effects are visible per game. Needs
 * network access to statsapi.mlb.com.
 */

import { MODEL_VERSION_SIM } from "../src/lib/mlb-sim";
import { buildV3PredictionsForDate, MODEL_VERSION_V3 } from "../src/lib/mlb-v3";

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(`\n🧮 ${MODEL_VERSION_V3} (Algorithm V2) vs ${MODEL_VERSION_SIM} for ${date}\n`);
  const t0 = Date.now();
  const games = await buildV3PredictionsForDate(date);
  if (games.length === 0) {
    console.log("No games scheduled.");
    return;
  }
  const pct = (p: number) => `${(p * 100).toFixed(1)}%`.padStart(6);
  console.log(
    "matchup".padEnd(44) +
      "sim*".padStart(7) +
      "elo".padStart(7) +
      "v2-ens".padStart(8) +
      "ctxΔ".padStart(7) +
      "v3".padStart(7),
  );
  for (const g of games) {
    console.log(
      `${g.awayName} @ ${g.homeName}`.padEnd(44) +
        pct(g.simProb).padStart(7) +
        pct(g.eloProb).padStart(7) +
        pct(g.ensembleProb).padStart(8) +
        `${g.contextDelta.total >= 0 ? "+" : ""}${g.contextDelta.total.toFixed(2)}`.padStart(7) +
        pct(g.finalProb).padStart(7),
    );
  }
  console.log(
    `\n${games.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(sim* = Monte Carlo on schedule-adjusted rates; home win probabilities)\n`,
  );
}

main().catch((err) => {
  console.error("💥 v3 test failed:", err);
  process.exit(1);
});
