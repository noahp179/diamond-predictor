#!/usr/bin/env -S npx tsx
/**
 * Backtest: sim-recent-v1 (trailing-window form) vs the stored sim-elo-v2
 * predictions, on every settled game already in Supabase.
 *
 *   npx tsx scripts/backtest-recent-form.ts
 *
 * sim-recent-v1's own prediction function (buildRecentFormPredictionsForDate,
 * src/lib/mlb-recent-form.ts) is inherently point-in-time — it always fetches
 * team/starter rates for the window ending the day before the target date —
 * so re-running it against a past date reconstructs exactly what it would
 * have said that morning, no lookahead reconstruction needed (unlike
 * scripts/backtest-odds-blend.ts, which has to rebuild sim-elo-v2's
 * season-to-date inputs by hand for a past date).
 *
 * Read-only: never writes to Supabase. Makes one MLB Stats API call set per
 * distinct date in the settled window, so a multi-month backtest is slow —
 * this is a real cost of the trailing-window design, not a bug.
 */

import { buildRecentFormPredictionsForDate } from "../src/lib/mlb-recent-form";

try {
  process.loadEnvFile(".env");
} catch {
  /* env may already be set */
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY in .env");
  process.exit(1);
}

async function sbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as any[];
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

function metrics(pairs: Array<[number, number]>) {
  const eps = 1e-7;
  let acc = 0;
  let brier = 0;
  let ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = pairs.length || 1;
  return { n: pairs.length, acc: acc / n, brier: brier / n, logLoss: ll / n };
}

async function main() {
  console.log("Loading settled games + stored sim-elo-v2 predictions from Supabase…");
  const [games, preds] = await Promise.all([
    sbSelect(
      "games?select=game_id,game_date,home_team_id,away_team_id,winner&winner=not.is.null&order=game_date.asc",
    ),
    sbSelect("predictions?select=game_id,model_version,home_win_prob").then((rows) =>
      rows.filter((r) => r.model_version === "sim-elo-v2"),
    ),
  ]);
  console.log(`  ${games.length} settled games, ${preds.length} stored sim-elo-v2 predictions`);

  const simEloByGame = new Map<number, number>();
  for (const p of preds) simEloByGame.set(p.game_id, Number(p.home_win_prob));

  const winnerByGame = new Map<number, "home" | "away">();
  const dateByGame = new Map<number, string>();
  for (const g of games) {
    winnerByGame.set(g.game_id, g.winner);
    dateByGame.set(g.game_id, g.game_date);
  }

  const dates = Array.from(new Set(games.map((g) => g.game_date))).sort();
  console.log(`  ${dates.length} distinct dates (${dates[0]} → ${dates[dates.length - 1]})`);
  console.log("Recomputing sim-recent-v1 point-in-time for each date (this hits the live MLB API)…");

  const recentByGame = new Map<number, number>();
  let datesFailed = 0;
  for (const [i, date] of dates.entries()) {
    try {
      const preds = await buildRecentFormPredictionsForDate(date);
      for (const p of preds) recentByGame.set(p.gameId, p.ensembleProb);
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${dates.length} dates done`);
    } catch (err) {
      datesFailed++;
      console.error(`  ${date}: sim-recent-v1 failed — ${err instanceof Error ? err.message : err}`);
    }
  }
  if (datesFailed > 0) console.log(`  ${datesFailed} date(s) failed and were skipped`);

  const simEloPairs: Array<[number, number]> = [];
  const recentPairs: Array<[number, number]> = [];
  const blendPairs: Array<[number, number]> = [];
  let agree = 0;
  let disagree = 0;
  let compared = 0;

  for (const [gameId, winner] of winnerByGame) {
    const pElo = simEloByGame.get(gameId);
    const pRecent = recentByGame.get(gameId);
    if (pElo == null || pRecent == null) continue;
    const y = winner === "home" ? 1 : 0;
    simEloPairs.push([pElo, y]);
    recentPairs.push([pRecent, y]);
    const blended = sigmoid((logit(clamp01(pElo)) + logit(clamp01(pRecent))) / 2);
    blendPairs.push([blended, y]);
    compared++;
    const pickElo = pElo >= 0.5;
    const pickRecent = pRecent >= 0.5;
    if (pickElo === pickRecent) agree++;
    else disagree++;
  }

  console.log(`\n${compared} games with both sim-elo-v2 and sim-recent-v1 predictions.\n`);
  console.log(`Pick agreement: ${agree} same / ${disagree} different (${dates.length} dates)\n`);

  const rows: Array<[string, ReturnType<typeof metrics>]> = [
    ["sim-elo-v2 (stored)", metrics(simEloPairs)],
    ["sim-recent-v1 (recomputed)", metrics(recentPairs)],
    ["50/50 logit blend", metrics(blendPairs)],
  ];
  console.log("model                        n     acc     brier   logloss");
  for (const [name, m] of rows) {
    console.log(
      `${name.padEnd(28)} ${String(m.n).padStart(4)}  ${(m.acc * 100).toFixed(1).padStart(5)}%  ` +
        `${m.brier.toFixed(4)}  ${m.logLoss.toFixed(4)}`,
    );
  }
  console.log(
    "\nLower brier/logloss and higher acc = better. If sim-recent-v1 doesn't beat " +
      "sim-elo-v2 here, don't promote it — leave it tracked-but-ignored on Track Record.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
