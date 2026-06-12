#!/usr/bin/env bun
/**
 * Pipeline test script
 *
 * Usage:
 *   bun scripts/test-pipeline.ts           # Run for today
 *   bun scripts/test-pipeline.ts 2025-06-05  # Run for a specific date
 *
 * This runs the same code path as the scheduled cron hook,
 * so you can verify end-to-end that ingestion, settlement,
 * and metric recomputation all work before relying on the cron.
 */

import {
  ingestAndPredict,
  settleFinished,
  recomputeDailyMetrics,
} from "../src/lib/mlb-pipeline.server";

async function main() {
  const dateArg = process.argv[2];
  const date = dateArg || new Date().toISOString().slice(0, 10);

  console.log(`\n🚀 Running pipeline test for ${date}\n`);

  try {
    // 1. Ingest the day's schedule (or re-ingest)
    console.log("Step 1/3: Ingest & predict…");
    const ingestResult = await ingestAndPredict(date);
    console.log("   ✅ Ingested:", JSON.stringify(ingestResult, null, 2));

    // 2. Settle any finished games
    console.log("\nStep 2/3: Settle finished games…");
    const settleResult = await settleFinished();
    console.log("   ✅ Settled:", settleResult.settled, "games");

    // 3. Recompute aggregate metrics
    console.log("\nStep 3/3: Recompute daily metrics…");
    const metricsResult = await recomputeDailyMetrics();
    console.log("   ✅ Updated:", metricsResult.days, "days of metrics");

    console.log("\n✅ Pipeline test completed successfully!\n");
  } catch (err) {
    console.error("\n💥 Pipeline test failed:", err);
    process.exit(1);
  }
}

main();
