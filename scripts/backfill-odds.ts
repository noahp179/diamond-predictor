#!/usr/bin/env -S node --experimental-strip-types
/**
 * One-time historical odds backfill for games ingested before the game_odds
 * table existed (i.e. everything before this feature shipped). New games
 * ingested going forward get their odds cached automatically inside
 * ingestAndPredict — this script only needs to run once for the backlog.
 *
 * Usage: npx tsx scripts/backfill-odds.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env, and the
 * `game_odds` migration (supabase/migrations/20260704023038_game_odds.sql)
 * must already be applied — this script upserts into that table.
 */

try {
  process.loadEnvFile(".env");
} catch {
  console.error(
    "No .env file found — SUPABASE_SERVICE_ROLE_KEY must already be set in the environment.",
  );
}

async function main() {
  const { supabaseAdmin } = await import("../src/integrations/supabase/client.server");
  const { fetchOddsForDate } = await import("../src/lib/mlb-odds.server");

  if (!supabaseAdmin) {
    console.error("supabaseAdmin is undefined — check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const { data: games, error } = await supabaseAdmin
    .from("games")
    .select(
      "game_id, game_date, home_team_name, away_team_name, home_team_abbr, away_team_abbr, game_odds(game_id)",
    )
    .order("game_date", { ascending: true });
  if (error) throw new Error(error.message);

  const missing = (games ?? []).filter((g: any) => !g.game_odds || g.game_odds.length === 0);
  console.log(`\n${(games ?? []).length} total games, ${missing.length} missing odds.\n`);

  const byDate = new Map<string, any[]>();
  for (const g of missing) {
    const arr = byDate.get(g.game_date) ?? [];
    arr.push(g);
    byDate.set(g.game_date, arr);
  }

  let totalFetched = 0;
  let datesWithNoMatch = 0;
  for (const [date, dayGames] of byDate) {
    const lookups = dayGames.map((g) => ({
      gameId: g.game_id,
      homeName: g.home_team_name,
      awayName: g.away_team_name,
      homeAbbr: g.home_team_abbr,
      awayAbbr: g.away_team_abbr,
    }));
    try {
      const fetched = await fetchOddsForDate(date, lookups);
      if (fetched.length === 0) {
        datesWithNoMatch++;
        console.log(`  · ${date}: no ESPN odds matched (${dayGames.length} games)`);
        continue;
      }
      const rows = fetched.map((o) => ({
        game_id: o.gameId,
        provider: o.provider,
        home_moneyline: o.homeMoneyLine,
        away_moneyline: o.awayMoneyLine,
        home_implied_prob: Number(o.homeImpliedProb.toFixed(4)),
        away_implied_prob: Number(o.awayImpliedProb.toFixed(4)),
        fetched_at: new Date().toISOString(),
      }));
      const { error: upErr } = await supabaseAdmin
        .from("game_odds")
        .upsert(rows, { onConflict: "game_id" });
      if (upErr) throw new Error(upErr.message);
      totalFetched += rows.length;
      console.log(`  ✅ ${date}: ${rows.length}/${dayGames.length} games matched`);
    } catch (err) {
      console.error(`  ❌ ${date}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `\n✅ Backfilled odds for ${totalFetched} games (${datesWithNoMatch} dates had no ESPN match).\n`,
  );
}

main().catch((err) => {
  console.error("\n💥 Odds backfill failed:", err);
  process.exit(1);
});
