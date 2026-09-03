#!/usr/bin/env node
/**
 * What is ACTUALLY stored in the database, per sport.
 *
 * This exists because the question "do we have tracked predictions for tennis?"
 * was answered wrong for weeks, by everyone including the Track Record page
 * itself. The page counted rows, got zero, and said "nothing settled yet — the
 * first run happens on the next daily cycle". The truth was that
 * `event_predictions` had never been created, so no cycle was ever going to
 * write anything, and the reassuring sentence was printed again every day.
 *
 * So this reports the ledger's STATE, not just its contents:
 *
 *   missing   the table does not exist. No data, and none coming.
 *   empty     the table exists and has no rows for this division.
 *   n rows    what is there, and how much of it has been scored.
 *
 * It reads through the public key, which is all that is needed — the tables are
 * world-readable. Run it before believing anything about what is tracked.
 *
 * Run:  npx tsx scripts/check-ledger.ts
 */

const url = (process.env.SUPABASE_URL ?? "").replace(/^"|"$/g, "").replace(/\/$/, "");
const key = (
  process.env.PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  ""
)
  .replace(/^"|"$/g, "")
  .trim();

if (!url || !key) {
  console.error("Set SUPABASE_URL and PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) first.");
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };

/** Row count via PostgREST's Content-Range, or null when the table is absent. */
async function count(table: string, query = ""): Promise<number | null> {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1${query}`, {
    headers: { ...headers, Prefer: "count=exact" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function rows<T>(table: string, query: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: { ...headers, Range: `${offset}-${offset + 999}` },
    });
    if (!res.ok) break;
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`\ndatabase: ${url.replace(/^https:\/\//, "").slice(0, 20)}…\n`);

// ------------------------------------------------- the soccer/tennis ledger

const ledger = await count("event_predictions");
console.log("event_predictions  — the soccer & tennis forward ledger");
if (ledger === null) {
  console.log("  STATUS  missing — the table does not exist in this database.");
  console.log("  MEANING no soccer or tennis prediction has ever been stored, and none");
  console.log("          will be until the migration is applied:");
  console.log("            supabase/migrations/20260815120000_event_predictions.sql");
} else if (ledger === 0) {
  console.log("  STATUS  empty — the table exists but holds no rows yet.");
} else {
  console.log(`  STATUS  ${ledger} rows`);
  const all = await rows<{
    sport: string;
    division: string;
    event_date: string;
    settled_at: string | null;
    correct: boolean | null;
  }>("event_predictions", "select=sport,division,event_date,settled_at,correct");
  const groups = new Map<string, typeof all>();
  for (const r of all) {
    const k = `${r.sport}/${r.division}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, g] of [...groups].sort()) {
    const settled = g.filter((r) => r.settled_at && r.correct !== null);
    const dates = g.map((r) => r.event_date).sort();
    const acc = settled.length
      ? pct(settled.filter((r) => r.correct).length / settled.length)
      : "—";
    console.log(
      `    ${k.padEnd(16)} n=${String(g.length).padStart(5)}  settled=${String(settled.length).padStart(5)}` +
        `  acc=${acc.padStart(6)}  ${dates[0]} → ${dates[dates.length - 1]}`,
    );
  }
}

// ----------------------------------------------------------- the MLB ledger

console.log("\npredictions  — the MLB forward ledger");
const mlb = await count("predictions");
if (mlb === null) {
  console.log("  STATUS  missing.");
} else {
  console.log(`  STATUS  ${mlb} rows`);
  const all = await rows<{
    model_version: string;
    predicted_at: string;
    settled_at: string | null;
    correct: boolean | null;
    brier: number | null;
  }>(
    "predictions",
    "select=model_version,predicted_at,settled_at,correct,brier&order=predicted_at.asc",
  );
  const days = new Set(all.map((r) => r.predicted_at.slice(0, 10)));
  const span = [...days].sort();
  console.log(`  SPAN    ${span[0]} → ${span[span.length - 1]} (${days.size} days with writes)`);
  const byModel = new Map<string, typeof all>();
  for (const r of all) byModel.set(r.model_version, [...(byModel.get(r.model_version) ?? []), r]);
  for (const [m, g] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
    const settled = g.filter((r) => r.settled_at && r.correct !== null);
    const acc = settled.length
      ? pct(settled.filter((r) => r.correct).length / settled.length)
      : "—";
    const briers = settled.map((r) => r.brier).filter((b): b is number => b != null);
    const brier = briers.length
      ? (briers.reduce((a, b) => a + b, 0) / briers.length).toFixed(4)
      : "—";
    console.log(
      `    ${m.padEnd(20)} n=${String(g.length).padStart(5)}  settled=${String(settled.length).padStart(5)}` +
        `  acc=${acc.padStart(6)}  brier=${brier}`,
    );
  }
}

// ------------------------------------------------------------------ the rest

console.log("\nother tables");
for (const t of ["games", "game_odds", "daily_metrics", "profiles"]) {
  const n = await count(t);
  console.log(`  ${t.padEnd(16)} ${n === null ? "missing" : `${n} rows`}`);
}
console.log();
