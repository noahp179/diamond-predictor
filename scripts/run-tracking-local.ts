#!/usr/bin/env node
/**
 * Record today's soccer and tennis predictions and settle what has finished.
 *
 * The same `runTrackingCycle` the cron hook calls — run locally, against the
 * real database, using SUPABASE_SERVICE_ROLE_KEY from .env. This exists for the
 * same reason run-pipeline-local.sh does: the Vercel cron has not been writing,
 * and there is no reason to wait on a deploy to start keeping the record.
 *
 * Predictions are written once and never overwritten (UNIQUE on
 * model_version, event_id), so running it twice in a day is safe and running it
 * late only means that day's fixtures were missed, not corrupted.
 *
 * Run:  npx tsx scripts/run-tracking-local.ts [YYYY-MM-DD]
 */
import { canTrack, runTrackingCycle, readLedger } from "../src/lib/tracking.server";

const date = process.argv[2] || new Date().toISOString().slice(0, 10);

if (!canTrack()) {
  console.error(
    "No SUPABASE_SERVICE_ROLE_KEY — the ledger is read-only here and nothing would be written.\n" +
      "Add it to .env from Supabase Dashboard → Project Settings → API keys → service_role.",
  );
  process.exit(1);
}

// Fail loudly rather than writing into the void: without the table every insert
// is silently dropped, which is precisely how this went unnoticed for weeks.
const probe = await readLedger("tennis", "atp");
if (probe.status === "not-provisioned") {
  console.error(
    "event_predictions does not exist — every write would be rejected.\n" +
      "Run `npx tsx scripts/provision-ledger.ts` first.",
  );
  process.exit(1);
}

console.log(`\nrecording ${date}…\n`);
const result = await runTrackingCycle(date);
console.log(
  `  recorded  ${result.recorded.soccer} soccer + ${result.recorded.tennis} tennis\n` +
    `  settled   ${result.settled}\n` +
    `  pending   ${result.pending}\n`,
);
console.log("Run `npx tsx scripts/check-ledger.ts` to see the ledger.\n");
