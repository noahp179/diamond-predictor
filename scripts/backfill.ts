#!/usr/bin/env -S node --experimental-strip-types
/**
 * Catch-up backfill for a stale database.
 *
 * Usage:
 *   npx tsx scripts/backfill.ts                    # every missing date up through yesterday
 *   npx tsx scripts/backfill.ts 2026-06-16 2026-07-03  # explicit inclusive date range
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env. Loaded here via
 * process.loadEnvFile() *before* the pipeline module (and its Supabase admin
 * client) is imported, so the key is guaranteed to be present when the
 * client is constructed.
 *
 * Runs the exact same ingestAndPredict → settleFinished → recomputeDailyMetrics
 * path as the cron, one date at a time so a single bad date doesn't abort the
 * whole run. ingestAndPredict also fetches+caches real market odds for each
 * date's games as it goes (see mlb-odds.server.ts), so this single script
 * closes both the game-data gap and the odds-cache gap for the backfilled range.
 */

try {
  process.loadEnvFile(".env");
} catch {
  console.error(
    "No .env file found — SUPABASE_SERVICE_ROLE_KEY must already be set in the environment.",
  );
}

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { ingestAndPredict, settleFinished, recomputeDailyMetrics, getLastIngestedDate } =
    await import("../src/lib/mlb-pipeline.server");

  const [argStart, argEnd] = process.argv.slice(2);
  const yesterday = addDaysISO(new Date().toISOString().slice(0, 10), -1);

  let start: string;
  let end: string;
  if (argStart && argEnd) {
    start = argStart;
    end = argEnd;
  } else {
    const last = await getLastIngestedDate();
    if (!last) {
      console.error(
        "No games in the DB yet and no explicit date range given — pass a start/end date.",
      );
      process.exit(1);
    }
    start = addDaysISO(last, 1);
    end = yesterday;
  }

  if (start > end) {
    console.log(
      `Nothing to backfill — last ingested date is already current (start ${start} > end ${end}).`,
    );
    return;
  }

  const dates: string[] = [];
  for (let cur = start; cur <= end; cur = addDaysISO(cur, 1)) dates.push(cur);
  console.log(`\n🚀 Backfilling ${dates.length} date(s): ${start} → ${end}\n`);

  const failures: Record<string, string> = {};
  for (const date of dates) {
    try {
      const result = await ingestAndPredict(date);
      console.log(`  ✅ ${date}`, JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures[date] = msg;
      console.error(`  ❌ ${date}: ${msg}`);
    }
  }

  console.log("\nSettling finished games…");
  const settle = await settleFinished();
  console.log(`  ✅ settled ${settle.settled} predictions`);

  console.log("Recomputing daily metrics…");
  const metrics = await recomputeDailyMetrics();
  console.log(`  ✅ updated ${metrics.days} day/model buckets`);

  const failedDates = Object.keys(failures);
  if (failedDates.length > 0) {
    console.log(`\n⚠️  ${failedDates.length} date(s) failed and were skipped:`, failures);
    process.exitCode = 1;
  } else {
    console.log("\n✅ Backfill completed with no failures.\n");
  }
}

main().catch((err) => {
  console.error("\n💥 Backfill failed:", err);
  process.exit(1);
});
