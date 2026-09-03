#!/usr/bin/env node
/**
 * Backfill the soccer and tennis ledger by replaying completed matches.
 *
 * WHAT THESE ROWS ARE, EXACTLY
 * ----------------------------
 * Every row written here is marked `provenance = 'reconstructed'`, and that
 * marking is the point of the script rather than a footnote to it.
 *
 * The arithmetic is not fudged. Each match is priced by the replay observer,
 * which fires BEFORE that match is folded into the ratings, so the probability
 * stored against it is genuinely the one the model would have produced that
 * morning — the identical code path the Track Record page's replay section
 * uses, so the stored rows and the on-page chart cannot disagree.
 *
 * What it still is not, and cannot be made into, is a forward record. These
 * rows were computed today, by a model shipped on 2026-08-15, over matches
 * whose results were already known when the model's constants were frozen. That
 * is a backtest, and a backtest can be re-run until it looks good in a way that
 * a row written yesterday morning cannot. So they are stored beside the forward
 * rows, never mixed into them, and the pages label which is which.
 *
 * Run it, then keep the cron running. In a few months the forward rows will be
 * the ones worth reading and these will be scaffolding.
 *
 * Usage:
 *   npx tsx scripts/backfill-ledger.ts --dry-run          # count, write nothing
 *   npx tsx scripts/backfill-ledger.ts                    # since the sports shipped
 *   npx tsx scripts/backfill-ledger.ts --since 2025-09-01 # further back
 *   npx tsx scripts/backfill-ledger.ts --only tennis
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (unless --dry-run) and the two migrations
 * applied. `scripts/provision-ledger.ts` handles the latter.
 */
import { LEAGUES, type LeagueSlug } from "../src/lib/soccer-leagues";
import { TOURS, type TourSlug } from "../src/lib/tennis-tours";
import { soccerHistoryRows } from "../src/lib/soccer.server";
import { tennisHistoryRows } from "../src/lib/tennis.server";
import { pickOf, scoreOutcome } from "../src/lib/ledger-stats";
import { SOCCER_MODEL_VERSION, TENNIS_MODEL_VERSION } from "../src/lib/tracking.server";

/**
 * The day soccer and tennis shipped. Before this the models did not exist, so
 * reconstructing earlier says less about "what the site would have told you"
 * and more about how the model scores on older seasons — which is what the
 * backtest figures on each page already report. --since overrides it.
 */
const LAUNCH = "2026-08-15";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const only = flag("--only");
const since = flag("--since") ?? LAUNCH;
const today = new Date().toISOString().slice(0, 10);

const days = Math.max(
  1,
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000),
);

const clean = (v: string | undefined) => (v ?? "").replace(/^"|"$/g, "").trim();
const url = clean(process.env.SUPABASE_URL).replace(/\/$/, "");
const serviceKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const readKey = serviceKey || clean(process.env.PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY);

if (!url || !readKey) {
  console.error("Set SUPABASE_URL and a Supabase key first (see .env).");
  process.exit(1);
}
if (!dryRun && !serviceKey) {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY is required to write. Re-run with --dry-run to preview.",
  );
  process.exit(1);
}

type Row = Record<string, unknown>;

/**
 * Insert, dropping anything already present.
 *
 * `ignoreDuplicates` on (model_version, event_id) is what makes the script safe
 * to re-run and, more importantly, unable to overwrite a forward row with a
 * reconstructed one. If the cron has already recorded a match properly, the
 * backfill must lose that race — the real record always wins.
 */
async function insert(rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(`${url}/rest/v1/event_predictions?on_conflict=model_version,event_id`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=representation,count=exact",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      console.error(`  insert failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return written;
    }
    written += ((await res.json()) as unknown[]).length;
  }
  return written;
}

console.log(`\nreconstructing ${since} → ${today} (${days} days)`);
console.log(dryRun ? "DRY RUN — nothing will be written\n" : "");

let totalRows = 0;
let totalWritten = 0;

if (only !== "tennis") {
  for (const l of LEAGUES) {
    try {
      const matches = await soccerHistoryRows(l.slug as LeagueSlug, today, days);
      const rows = matches.map((m) => {
        const probs = { a: m.probs.home, draw: m.probs.draw, b: m.probs.away };
        const { pick, pickProb } = pickOf(probs);
        const { brier, logLoss, rps } = scoreOutcome(probs, m.result);
        return {
          sport: "soccer",
          division: l.slug,
          model_version: SOCCER_MODEL_VERSION,
          event_id: m.eventId,
          event_date: m.date,
          subject_a: m.homeName,
          subject_b: m.awayName,
          context: m.venue || null,
          prob_a: probs.a,
          prob_draw: probs.draw,
          prob_b: probs.b,
          pick,
          pick_prob: pickProb,
          result: m.result,
          correct: pick === m.result,
          brier,
          log_loss: logLoss,
          rps,
          final_score: m.finalScore,
          // Settled at once: the match was already over when this was computed.
          settled_at: new Date().toISOString(),
          provenance: "reconstructed",
        };
      });
      totalRows += rows.length;
      const written = dryRun ? 0 : await insert(rows);
      totalWritten += written;
      const hit = rows.filter((r) => r.correct).length;
      console.log(
        `  ${l.slug.padEnd(10)} ${String(rows.length).padStart(5)} matches  ` +
          `acc=${rows.length ? ((hit / rows.length) * 100).toFixed(1) : "—"}%  ` +
          (dryRun ? "(dry run)" : `written=${written}`),
      );
    } catch (err) {
      console.error(`  ${l.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (only !== "soccer") {
  for (const t of TOURS) {
    try {
      const matches = await tennisHistoryRows(t.slug as TourSlug, today, days);
      const rows = matches.map((m) => {
        const probs = { a: m.probA, draw: null, b: 1 - m.probA };
        const { pick, pickProb } = pickOf(probs);
        const { brier, logLoss, rps } = scoreOutcome(probs, m.result);
        return {
          sport: "tennis",
          division: t.slug,
          model_version: TENNIS_MODEL_VERSION,
          event_id: m.eventId,
          event_date: m.date,
          subject_a: m.aName,
          subject_b: m.bName,
          context: m.context || null,
          prob_a: probs.a,
          prob_draw: null,
          prob_b: probs.b,
          pick,
          pick_prob: pickProb,
          result: m.result,
          correct: pick === m.result,
          brier,
          log_loss: logLoss,
          rps,
          final_score: m.finalScore || null,
          settled_at: new Date().toISOString(),
          provenance: "reconstructed",
        };
      });
      totalRows += rows.length;
      const written = dryRun ? 0 : await insert(rows);
      totalWritten += written;
      const hit = rows.filter((r) => r.correct).length;
      console.log(
        `  ${t.slug.padEnd(10)} ${String(rows.length).padStart(5)} matches  ` +
          `acc=${rows.length ? ((hit / rows.length) * 100).toFixed(1) : "—"}%  ` +
          (dryRun ? "(dry run)" : `written=${written}`),
      );
    } catch (err) {
      console.error(`  ${t.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(
  `\n${totalRows} matches reconstructed` +
    (dryRun ? " (nothing written)" : `, ${totalWritten} new rows stored`),
);
console.log("Every one is marked provenance='reconstructed'. They are a backtest,");
console.log("stored beside the forward record and never averaged into it.\n");
if (!dryRun) console.log("Next: npx tsx scripts/check-ledger.ts\n");
