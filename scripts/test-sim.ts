#!/usr/bin/env bun
/**
 * Simulation model test script
 *
 * Usage:
 *   bun scripts/test-sim.ts             # Run for today
 *   bun scripts/test-sim.ts 2026-06-15  # Run for a specific date
 *   (npx tsx works too if bun isn't installed)
 *
 * Runs the sim-elo-v1 model (Monte Carlo game simulation + Elo ensemble)
 * for every game on the given date and prints the three probabilities
 * side by side. Read-only: does not write to the database.
 */

import { buildSimPredictionsForDate, MODEL_VERSION_SIM } from "../src/lib/mlb-sim";

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(`\n🎲 ${MODEL_VERSION_SIM} predictions for ${date}\n`);
  const t0 = Date.now();
  const games = await buildSimPredictionsForDate(date);
  if (games.length === 0) {
    console.log("No games scheduled.");
    return;
  }
  const pct = (p: number) => `${(p * 100).toFixed(1)}%`.padStart(6);
  console.log(
    "matchup".padEnd(46) + "sim".padStart(7) + "elo".padStart(8) + "ensemble".padStart(10),
  );
  for (const g of games) {
    const label = `${g.awayName} @ ${g.homeName}`;
    console.log(
      label.padEnd(46) +
        pct(g.simProb).padStart(7) +
        pct(g.eloProb).padStart(8) +
        pct(g.ensembleProb).padStart(10),
    );
  }
  console.log(`\n${games.length} games in ${((Date.now() - t0) / 1000).toFixed(1)}s (home win probabilities)\n`);
}

main().catch((err) => {
  console.error("💥 sim test failed:", err);
  process.exit(1);
});
