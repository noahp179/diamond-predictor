import { supabaseAdmin as _supabaseAdmin } from "@/integrations/supabase/client.server";

const supabaseAdmin = _supabaseAdmin!;

/**
 * True when the service-role client exists (SUPABASE_SERVICE_ROLE_KEY is in
 * the server environment). Read paths use this to decide whether they can
 * opportunistically ingest/settle; local dev without the key stays read-only.
 */
export function canWrite(): boolean {
  return Boolean(_supabaseAdmin);
}

/**
 * Every write entry point below calls this first. Without it, a missing/
 * misconfigured SUPABASE_SERVICE_ROLE_KEY surfaces as a bare
 * "Cannot read properties of undefined (reading 'from')" — which is what the
 * cron job has been throwing since it stopped writing on 2026-06-15, with no
 * indication of what's actually wrong.
 */
function assertWritable(): void {
  if (!canWrite()) {
    throw new Error(
      "supabaseAdmin is undefined — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing or " +
        "invalid in this server environment. Set them in Vercel → Project Settings → " +
        "Environment Variables (server-side, not VITE_-prefixed) and redeploy.",
    );
  }
}

/**
 * The full daily cycle: self-heal every date missed since the last
 * successful run (capped at 10 days so a long-stale DB can't trigger a
 * runaway backfill), settle any finished games, recompute daily_metrics,
 * then ingest/predict today's slate. This is "what a pipeline run does" —
 * the Vercel cron route and the opportunistic self-heal below both call
 * this single implementation instead of duplicating it.
 */
export async function runFullPipelineCycle() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const missing = await findMissingDates(yesterday);
  const ingestResults: Record<string, unknown> = {};
  const ingestErrors: Record<string, string> = {};
  for (const date of missing) {
    try {
      ingestResults[date] = await ingestAndPredict(date);
    } catch (err) {
      // One bad date (API hiccup, off-day) shouldn't abort the whole catch-up.
      ingestErrors[date] = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] ingest failed for ${date}`, err);
    }
  }
  const settle = await settleFinished();
  const metrics = await recomputeDailyMetrics();
  // Pre-load today's schedule so the front-end can read from the DB quickly.
  const ingestToday = await ingestAndPredict(today).catch((err) => {
    console.error("[pipeline] ingest failed for today", err);
    return null;
  });
  return {
    yesterday,
    today,
    backfilledDates: missing,
    ingestResults,
    ingestErrors,
    ingestToday,
    settle,
    metrics,
  };
}

let lastPipelineAttempt = 0;

/**
 * Runs the full pipeline cycle at most once per `minIntervalMs` per server
 * instance. Called opportunistically from every read path that renders
 * scores/predictions (index, metrics, track record, history, team
 * leaderboard) so a day's predictions get recorded and finished games get
 * scored purely from ordinary site traffic — no cron, no manual trigger
 * required. Debounced so page traffic can't stampede the MLB API; a run
 * that fails is logged and swallowed so it never breaks the page's own read.
 */
export async function runPipelineIfDue(minIntervalMs = 2 * 60_000) {
  if (!canWrite()) return null;
  const now = Date.now();
  if (now - lastPipelineAttempt < minIntervalMs) return null;
  lastPipelineAttempt = now;
  try {
    return await runFullPipelineCycle();
  } catch (err) {
    console.error("[runPipelineIfDue] pipeline failed", err);
    return null;
  }
}

import { buildPredictionsForDate, MODEL_VERSION, STATS_API } from "./mlb-core";
import { buildSimPredictionsForDate, MODEL_VERSION_SIM } from "./mlb-sim";
import { buildRecentFormPredictionsForDate } from "./mlb-recent-form";
import { fetchOddsForDate } from "./mlb-odds.server";
import { blendWithMarket, MODEL_VERSION_BLEND, MARKET_BLEND_WEIGHT } from "./mlb-blend";
import { MODEL_VERSION_MARKET, MODEL_VERSION_RECENT } from "./mlb-models";

/**
 * Insert prediction rows that don't already exist for `modelVersion`,
 * keeping any original (earlier) prediction. Returns how many were new.
 */
async function insertFreshPredictions(
  rows: Array<{ game_id: number } & Record<string, unknown>>,
  modelVersion: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.game_id);
  const { data: existing } = await supabaseAdmin
    .from("predictions")
    .select("game_id")
    .eq("model_version", modelVersion)
    .in("game_id", ids);
  const existingSet = new Set((existing ?? []).map((r) => r.game_id));
  const fresh = rows.filter((r) => !existingSet.has(r.game_id));
  if (fresh.length === 0) return 0;
  const { error } = await supabaseAdmin.from("predictions").insert(fresh as never[]);
  if (error) throw new Error(error.message);
  return fresh.length;
}

/** Games in these states have started (or ended) — never "predict" them. */
const STARTED_RE = /final|game over|completed|in progress|suspended/i;

/** Most recent `game_date` already in the DB, or null if the table is empty. */
export async function getLastIngestedDate(): Promise<string | null> {
  assertWritable();
  const { data, error } = await supabaseAdmin
    .from("games")
    .select("game_date")
    .order("game_date", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].game_date as string;
}

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Every date strictly after the last ingested one, up through `throughDate`
 * (inclusive), capped at `maxDays` so a long-stale DB can't trigger an
 * unbounded backfill from a single cron tick. Self-heals gaps left by a
 * missed or failed cron run without needing manual intervention.
 */
export async function findMissingDates(throughDate: string, maxDays = 10): Promise<string[]> {
  const last = await getLastIngestedDate();
  const start = last ? addDaysISO(last, 1) : addDaysISO(throughDate, -maxDays + 1);
  const dates: string[] = [];
  let cur = start;
  while (cur <= throughDate && dates.length < maxDays) {
    dates.push(cur);
    cur = addDaysISO(cur, 1);
  }
  return dates;
}

export async function ingestAndPredict(date: string) {
  assertWritable();
  const games = await buildPredictionsForDate(date);
  if (games.length === 0) return { date, inserted: 0 };

  const gameRows = games.map((g) => ({
    game_id: g.gameId,
    game_date: date,
    game_time: g.date,
    status: g.status,
    venue: g.venue,
    home_team_id: g.home.id,
    home_team_name: g.home.name,
    home_team_abbr: g.home.abbreviation,
    away_team_id: g.away.id,
    away_team_name: g.away.name,
    away_team_abbr: g.away.abbreviation,
    home_score: g.homeScore ?? null,
    away_score: g.awayScore ?? null,
    winner: g.winner ?? null,
  }));

  const { error: gErr } = await supabaseAdmin
    .from("games")
    .upsert(gameRows, { onConflict: "game_id" });
  if (gErr) throw new Error(`games upsert: ${gErr.message}`);

  // Predictions are only recorded for games that haven't started. The
  // self-heal backfill re-ingests past dates after downtime — games and odds
  // are facts and always land, but writing "predictions" for games that were
  // already final would be hindsight and would corrupt the track record.
  const predictable = games.filter((g) => !STARTED_RE.test(g.status ?? ""));
  const predictableIds = new Set(predictable.map((g) => g.gameId));

  const predRows = predictable.map((g) => ({
    game_id: g.gameId,
    model_version: MODEL_VERSION,
    home_win_prob: Number(g.homeWinProb.toFixed(4)),
    away_win_prob: Number(g.awayWinProb.toFixed(4)),
    home_win_pct: Number(g.home.winPct.toFixed(4)),
    away_win_pct: Number(g.away.winPct.toFixed(4)),
    home_pitcher_id: g.home.pitcher?.id ?? null,
    home_pitcher_name: g.home.pitcher?.name ?? null,
    home_pitcher_era: g.home.pitcher?.era ?? null,
    away_pitcher_id: g.away.pitcher?.id ?? null,
    away_pitcher_name: g.away.pitcher?.name ?? null,
    away_pitcher_era: g.away.pitcher?.era ?? null,
    rationale: g.rationale,
  }));
  const newPreds = await insertFreshPredictions(predRows, MODEL_VERSION);

  // Primary model: sim-elo-v2 (Monte Carlo + multi-season Elo ensemble). Stored
  // alongside baseline-v0.4 (kept as the comparison model on Track Record).
  // Pitcher/record metadata is copied from the baseline game objects — those
  // are real-world facts (who's starting, season W/L), not model-specific —
  // so pages reading only the sim-elo-v2 row still have full display data.
  // Failures here never block baseline ingestion.
  let newSimPreds = 0;
  const simProbByGame = new Map<number, number>();
  try {
    const baselineByGameId = new Map(games.map((g) => [g.gameId, g]));
    const simGames = await buildSimPredictionsForDate(date);
    for (const g of simGames) simProbByGame.set(g.gameId, g.ensembleProb);
    const simRows = simGames
      .filter((g) => predictableIds.has(g.gameId))
      .map((g) => {
        const base = baselineByGameId.get(g.gameId);
        return {
          game_id: g.gameId,
          model_version: MODEL_VERSION_SIM,
          home_win_prob: Number(g.ensembleProb.toFixed(4)),
          away_win_prob: Number((1 - g.ensembleProb).toFixed(4)),
          home_win_pct: base ? Number(base.home.winPct.toFixed(4)) : null,
          away_win_pct: base ? Number(base.away.winPct.toFixed(4)) : null,
          home_pitcher_id: base?.home.pitcher?.id ?? null,
          home_pitcher_name: base?.home.pitcher?.name ?? null,
          home_pitcher_era: base?.home.pitcher?.era ?? null,
          away_pitcher_id: base?.away.pitcher?.id ?? null,
          away_pitcher_name: base?.away.pitcher?.name ?? null,
          away_pitcher_era: base?.away.pitcher?.era ?? null,
          rationale: g.rationale,
        };
      });
    newSimPreds = await insertFreshPredictions(simRows, MODEL_VERSION_SIM);
  } catch (err) {
    console.error("[ingestAndPredict] sim-elo-v2 predictions failed:", err);
  }

  // Experimental: sim-recent-v1 — the sim-elo-v2 engine fed trailing-window
  // form instead of season rates (src/lib/mlb-recent-form.ts). Recorded
  // side by side with sim-elo-v2 on Track Record so it can prove itself (or
  // not) against real settled games. Never blocks anything else.
  let newRecentPreds = 0;
  try {
    const baselineByGameId = new Map(games.map((g) => [g.gameId, g]));
    const recentGames = await buildRecentFormPredictionsForDate(date);
    const recentRows = recentGames
      .filter((g) => predictableIds.has(g.gameId))
      .map((g) => {
        const base = baselineByGameId.get(g.gameId);
        return {
          game_id: g.gameId,
          model_version: MODEL_VERSION_RECENT,
          home_win_prob: Number(g.ensembleProb.toFixed(4)),
          away_win_prob: Number((1 - g.ensembleProb).toFixed(4)),
          home_win_pct: base ? Number(base.home.winPct.toFixed(4)) : null,
          away_win_pct: base ? Number(base.away.winPct.toFixed(4)) : null,
          home_pitcher_id: base?.home.pitcher?.id ?? null,
          home_pitcher_name: base?.home.pitcher?.name ?? null,
          home_pitcher_era: base?.home.pitcher?.era ?? null,
          away_pitcher_id: base?.away.pitcher?.id ?? null,
          away_pitcher_name: base?.away.pitcher?.name ?? null,
          away_pitcher_era: base?.away.pitcher?.era ?? null,
          rationale: g.rationale,
        };
      });
    newRecentPreds = await insertFreshPredictions(recentRows, MODEL_VERSION_RECENT);
  } catch (err) {
    console.error("[ingestAndPredict] sim-recent-v1 predictions failed:", err);
  }

  // Real market odds (ESPN, free/keyless). Best-effort and never blocks game
  // or prediction ingestion — odds may not be posted yet for far-future dates,
  // and the endpoint is unofficial.
  let newOdds = 0;
  const marketProbByGame = new Map<number, number>(); // devigged home implied prob
  try {
    const lookups = games.map((g) => ({
      gameId: g.gameId,
      homeName: g.home.name,
      awayName: g.away.name,
      homeAbbr: g.home.abbreviation,
      awayAbbr: g.away.abbreviation,
    }));
    const fetched = await fetchOddsForDate(date, lookups);
    if (fetched.length > 0) {
      const oddsRows = fetched.map((o) => ({
        game_id: o.gameId,
        provider: o.provider,
        home_moneyline: o.homeMoneyLine,
        away_moneyline: o.awayMoneyLine,
        home_implied_prob: Number(o.homeImpliedProb.toFixed(4)),
        away_implied_prob: Number(o.awayImpliedProb.toFixed(4)),
        fetched_at: new Date().toISOString(),
      }));
      const { error: oErr } = await supabaseAdmin
        .from("game_odds")
        .upsert(oddsRows, { onConflict: "game_id" });
      if (oErr) throw new Error(oErr.message);
      newOdds = oddsRows.length;
      for (const o of fetched) marketProbByGame.set(o.gameId, o.homeImpliedProb);
    }
  } catch (err) {
    console.error("[ingestAndPredict] odds fetch failed:", err);
  }

  // If the live fetch missed a game the cache already has (e.g. a re-run
  // after a partial failure), use the cached line for the odds-based models.
  try {
    const uncovered = Array.from(predictableIds).filter((id) => !marketProbByGame.has(id));
    if (uncovered.length > 0) {
      const { data: cached } = await supabaseAdmin
        .from("game_odds")
        .select("game_id, home_implied_prob")
        .in("game_id", uncovered);
      for (const r of cached ?? []) {
        if (r.home_implied_prob != null)
          marketProbByGame.set(r.game_id, Number(r.home_implied_prob));
      }
    }
  } catch (err) {
    console.error("[ingestAndPredict] cached odds lookup failed:", err);
  }

  // Odds-based models, tracked alongside the rest on Track Record:
  //   market-devig   — the devigged DraftKings line itself (the benchmark)
  //   odds-blend-v1  — sim-elo-v2 blended with that line (Best Odds tab 2)
  // Rows exist only for games whose odds were posted at prediction time.
  let newMarketPreds = 0;
  let newBlendPreds = 0;
  try {
    const marketRows: Array<{ game_id: number } & Record<string, unknown>> = [];
    const blendRows: Array<{ game_id: number } & Record<string, unknown>> = [];
    for (const g of predictable) {
      const market = marketProbByGame.get(g.gameId);
      if (market == null) continue;
      marketRows.push({
        game_id: g.gameId,
        model_version: MODEL_VERSION_MARKET,
        home_win_prob: Number(market.toFixed(4)),
        away_win_prob: Number((1 - market).toFixed(4)),
        rationale: [`DraftKings devigged line: home ${(market * 100).toFixed(1)}%`],
      });
      const sim = simProbByGame.get(g.gameId);
      if (sim == null) continue;
      const blended = blendWithMarket(sim, market);
      blendRows.push({
        game_id: g.gameId,
        model_version: MODEL_VERSION_BLEND,
        home_win_prob: Number(blended.toFixed(4)),
        away_win_prob: Number((1 - blended).toFixed(4)),
        rationale: [
          `sim-elo-v2 ${(sim * 100).toFixed(1)}% ⊕ market ${(market * 100).toFixed(1)}% ` +
            `(w=${MARKET_BLEND_WEIGHT}) → home ${(blended * 100).toFixed(1)}%`,
        ],
      });
    }
    newMarketPreds = await insertFreshPredictions(marketRows, MODEL_VERSION_MARKET);
    newBlendPreds = await insertFreshPredictions(blendRows, MODEL_VERSION_BLEND);
  } catch (err) {
    console.error("[ingestAndPredict] odds-based model predictions failed:", err);
  }

  return {
    date,
    games: games.length,
    predictable: predictable.length,
    newPredictions: newPreds,
    newSimPredictions: newSimPreds,
    newRecentPredictions: newRecentPreds,
    newBlendPredictions: newBlendPreds,
    newMarketPredictions: newMarketPreds,
    newOdds,
  };
}

export async function settleFinished() {
  assertWritable();
  // Find unsettled predictions whose game is final — across every model version
  // so shadow models (sim-elo-v1) get scored alongside the baseline.
  const { data: rows, error } = await supabaseAdmin
    .from("predictions")
    .select(
      "game_id, model_version, home_win_prob, away_win_prob, games!inner(status, winner, home_score, away_score, game_date)",
    )
    .is("settled_at", null);
  if (error) throw new Error(`settle query: ${error.message}`);

  let settled = 0;
  // Several model versions share each game — fetch/refresh a game at most
  // once per run, not once per prediction row.
  const liveByGame = new Map<number, Awaited<ReturnType<typeof fetchGameFinal>>>();
  for (const r of rows ?? []) {
    const g: any = (r as any).games;
    if (!g) continue;
    // Only settle on truly final games. Refresh from MLB to confirm.
    const isFinal = /final|game over|completed/i.test(g.status ?? "");
    let winner: "home" | "away" | null = isFinal ? (g.winner ?? null) : null;

    if (!winner) {
      const gameId = (r as any).game_id as number;
      let live = liveByGame.get(gameId);
      if (live === undefined) {
        live = await fetchGameFinal(gameId);
        liveByGame.set(gameId, live);
        if (live) {
          await supabaseAdmin
            .from("games")
            .update({
              status: live.status,
              home_score: live.homeScore,
              away_score: live.awayScore,
              winner: live.winner,
            })
            .eq("game_id", gameId);
        }
      }
      if (!live?.winner) continue;
      winner = live.winner;
    }

    const pHome = Number((r as any).home_win_prob);
    const y = winner === "home" ? 1 : 0;
    const brier = (pHome - y) ** 2;
    const eps = 1e-6;
    const pClamped = Math.min(1 - eps, Math.max(eps, pHome));
    const logLoss = -(y * Math.log(pClamped) + (1 - y) * Math.log(1 - pClamped));
    const correct = (pHome >= 0.5 ? 1 : 0) === y;

    await supabaseAdmin
      .from("predictions")
      .update({
        correct,
        brier: Number(brier.toFixed(5)),
        log_loss: Number(logLoss.toFixed(4)),
        settled_at: new Date().toISOString(),
      })
      .eq("game_id", (r as any).game_id)
      .eq("model_version", (r as any).model_version);
    settled++;
  }
  return { settled };
}

async function fetchGameFinal(gameId: number) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${STATS_API}/schedule?sportId=1&gamePk=${gameId}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json: any = await res.json();
    const g = json?.dates?.[0]?.games?.[0];
    if (!g) return null;
    const status: string = g.status?.detailedState ?? "Scheduled";
    const homeScore = g.teams?.home?.score ?? null;
    const awayScore = g.teams?.away?.score ?? null;
    let winner: "home" | "away" | null = null;
    if (
      status.toLowerCase().includes("final") &&
      typeof homeScore === "number" &&
      typeof awayScore === "number" &&
      homeScore !== awayScore
    ) {
      winner = homeScore > awayScore ? "home" : "away";
    }
    return { status, homeScore, awayScore, winner };
  } catch {
    return null;
  }
}

export async function recomputeDailyMetrics() {
  assertWritable();
  // Aggregate per (game_date, model_version) from predictions joined to games
  const { data, error } = await supabaseAdmin
    .from("predictions")
    .select("model_version, correct, brier, log_loss, games!inner(game_date)")
    .not("settled_at", "is", null);
  if (error) throw new Error(`metrics query: ${error.message}`);

  const buckets = new Map<
    string,
    { games: number; settled: number; correct: number; brier: number; logLoss: number }
  >();
  for (const r of data ?? []) {
    const d = (r as any).games.game_date as string;
    const key = `${d}|${(r as any).model_version}`;
    const b = buckets.get(key) ?? { games: 0, settled: 0, correct: 0, brier: 0, logLoss: 0 };
    b.games += 1;
    b.settled += 1;
    if ((r as any).correct) b.correct += 1;
    b.brier += Number((r as any).brier ?? 0);
    b.logLoss += Number((r as any).log_loss ?? 0);
    buckets.set(key, b);
  }

  const rows = Array.from(buckets.entries()).map(([key, b]) => ({
    metric_date: key.split("|")[0],
    model_version: key.split("|")[1],
    games: b.games,
    settled: b.settled,
    correct: b.correct,
    accuracy: b.settled > 0 ? Number((b.correct / b.settled).toFixed(4)) : null,
    brier: b.settled > 0 ? Number((b.brier / b.settled).toFixed(5)) : null,
    log_loss: b.settled > 0 ? Number((b.logLoss / b.settled).toFixed(4)) : null,
  }));

  if (rows.length > 0) {
    const { error: upErr } = await supabaseAdmin
      .from("daily_metrics")
      .upsert(rows, { onConflict: "metric_date,model_version" });
    if (upErr) throw new Error(`metrics upsert: ${upErr.message}`);
  }
  return { days: rows.length };
}
