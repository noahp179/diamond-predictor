import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { buildPredictionsForDate, MODEL_VERSION, STATS_API } from "./mlb-core";

export async function ingestAndPredict(date: string) {
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

  const { error: gErr } = await supabaseAdmin.from("games").upsert(gameRows, { onConflict: "game_id" });
  if (gErr) throw new Error(`games upsert: ${gErr.message}`);

  const predRows = games.map((g) => ({
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

  // Only insert predictions that don't already exist — keep the original prediction.
  const ids = predRows.map((p) => p.game_id);
  const { data: existing } = await supabaseAdmin
    .from("predictions")
    .select("game_id")
    .eq("model_version", MODEL_VERSION)
    .in("game_id", ids);
  const existingSet = new Set((existing ?? []).map((r) => r.game_id));
  const newPreds = predRows.filter((p) => !existingSet.has(p.game_id));
  if (newPreds.length > 0) {
    const { error: pErr } = await supabaseAdmin.from("predictions").insert(newPreds);
    if (pErr) throw new Error(`predictions insert: ${pErr.message}`);
  }

  return { date, games: games.length, newPredictions: newPreds.length };
}

export async function settleFinished() {
  // Find unsettled predictions whose game is final.
  const { data: rows, error } = await supabaseAdmin
    .from("predictions")
    .select("game_id, home_win_prob, away_win_prob, games!inner(status, winner, home_score, away_score, game_date)")
    .is("settled_at", null)
    .eq("model_version", MODEL_VERSION);
  if (error) throw new Error(`settle query: ${error.message}`);

  let settled = 0;
  for (const r of rows ?? []) {
    const g: any = (r as any).games;
    if (!g) continue;
    // Refresh status from MLB if not yet final
    let winner: "home" | "away" | null = g.winner ?? null;
    let status: string = g.status;
    let homeScore: number | null = g.home_score;
    let awayScore: number | null = g.away_score;

    if (!winner) {
      const live = await fetchGameFinal((r as any).game_id);
      if (!live) continue;
      status = live.status;
      homeScore = live.homeScore;
      awayScore = live.awayScore;
      winner = live.winner;
      await supabaseAdmin
        .from("games")
        .update({ status, home_score: homeScore, away_score: awayScore, winner })
        .eq("game_id", (r as any).game_id);
      if (!winner) continue;
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
      .eq("model_version", MODEL_VERSION);
    settled++;
  }
  return { settled };
}

async function fetchGameFinal(gameId: number) {
  try {
    const res = await fetch(`${STATS_API}/schedule?sportId=1&gamePk=${gameId}`);
    if (!res.ok) return null;
    const json: any = await res.json();
    const g = json?.dates?.[0]?.games?.[0];
    if (!g) return null;
    const status: string = g.status?.detailedState ?? "Scheduled";
    const homeScore = g.teams?.home?.score ?? null;
    const awayScore = g.teams?.away?.score ?? null;
    let winner: "home" | "away" | null = null;
    if (status.toLowerCase().includes("final") && typeof homeScore === "number" && typeof awayScore === "number" && homeScore !== awayScore) {
      winner = homeScore > awayScore ? "home" : "away";
    }
    return { status, homeScore, awayScore, winner };
  } catch {
    return null;
  }
}

export async function recomputeDailyMetrics() {
  // Aggregate per game_date from predictions joined to games
  const { data, error } = await supabaseAdmin
    .from("predictions")
    .select("correct, brier, log_loss, games!inner(game_date)")
    .eq("model_version", MODEL_VERSION)
    .not("settled_at", "is", null);
  if (error) throw new Error(`metrics query: ${error.message}`);

  const buckets = new Map<string, { games: number; settled: number; correct: number; brier: number; logLoss: number }>();
  for (const r of data ?? []) {
    const d = (r as any).games.game_date as string;
    const b = buckets.get(d) ?? { games: 0, settled: 0, correct: 0, brier: 0, logLoss: 0 };
    b.games += 1;
    b.settled += 1;
    if ((r as any).correct) b.correct += 1;
    b.brier += Number((r as any).brier ?? 0);
    b.logLoss += Number((r as any).log_loss ?? 0);
    buckets.set(d, b);
  }

  const rows = Array.from(buckets.entries()).map(([metric_date, b]) => ({
    metric_date,
    model_version: MODEL_VERSION,
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