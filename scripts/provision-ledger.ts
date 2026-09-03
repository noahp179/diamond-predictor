#!/usr/bin/env node
/**
 * Create the soccer/tennis ledger table, or say exactly why it cannot.
 *
 * `event_predictions` has never existed in this project's database. Everything
 * downstream of it — the tracking cron, the Track Record pages, every chart on
 * them — has been writing to and reading from a table that is not there. The
 * writes were rejected and the reads returned empty, so the failure looked
 * exactly like "no matches have settled yet".
 *
 * DDL cannot be run with a service-role key. That key authenticates against
 * PostgREST, which exposes tables, not `CREATE TABLE`. Creating a table needs
 * one of:
 *
 *   SUPABASE_DB_URL       a Postgres connection string (Dashboard → Settings →
 *                         Database → Connection string). This script uses it.
 *   the SQL editor        paste the migration; this script prints it and the
 *                         direct link.
 *
 * Either way the script finishes by checking whether the table is actually
 * there, so nobody has to take its word for it.
 *
 * Run:  npx tsx scripts/provision-ledger.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = "supabase/migrations/20260815120000_event_predictions.sql";

const clean = (v: string | undefined) => (v ?? "").replace(/^"|"$/g, "").trim();
const url = clean(process.env.SUPABASE_URL).replace(/\/$/, "");
const key = clean(
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.PUBLISHABLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY,
);
const dbUrl = clean(process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL);

if (!url || !key) {
  console.error("Set SUPABASE_URL and a Supabase key first (see .env).");
  process.exit(1);
}

const ref = url.replace(/^https:\/\//, "").split(".")[0];

/** Does the table exist? PostgREST answers 404 when it does not. */
async function exists(): Promise<boolean> {
  const res = await fetch(`${url}/rest/v1/event_predictions?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return res.status !== 404;
}

const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");

console.log(`\nproject: ${ref}\n`);

if (await exists()) {
  console.log("event_predictions already exists — nothing to do.");
  console.log("Run `npx tsx scripts/check-ledger.ts` to see what is in it.\n");
  process.exit(0);
}

console.log("event_predictions does NOT exist. No soccer or tennis prediction");
console.log("has ever been stored, and none can be until it does.\n");

if (dbUrl) {
  // A connection string is the only credential in this repo's world that can
  // run DDL. Applied through psql so there is no new dependency and no
  // hand-rolled SQL splitting, which is where this kind of script goes wrong.
  const { spawnSync } = await import("node:child_process");
  console.log("SUPABASE_DB_URL is set — applying the migration with psql…\n");
  const r = spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", MIGRATION], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("\npsql failed. Apply it by hand with the SQL below.");
  }
} else {
  console.log("No SUPABASE_DB_URL set, so this script cannot create it for you.");
  console.log("Two ways to finish:\n");
  console.log("  a) Add a connection string to .env and re-run this script:");
  console.log("       Dashboard → Settings → Database → Connection string (URI)");
  console.log("       SUPABASE_DB_URL=postgresql://…\n");
  console.log(`  b) Paste the migration into the SQL editor:`);
  console.log(`       https://supabase.com/dashboard/project/${ref}/sql/new\n`);
  console.log("─".repeat(72));
  console.log(sql.trim());
  console.log("─".repeat(72));
}

console.log("\nverifying…");
console.log(
  (await exists())
    ? "  event_predictions is present. Next: scripts/run-tracking-local.sh\n"
    : "  still not there — nothing was created.\n",
);
