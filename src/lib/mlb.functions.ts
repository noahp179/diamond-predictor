import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { buildPredictionsForDate, MODEL_VERSION, type PredictedGame } from "./mlb-core";

export type { PredictedGame } from "./mlb-core";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Read-side: prefer DB (populated by the cron); fall back to live MLB API.
export const getDailyGames = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data?.date ?? todayISO();

    const { data: rows } = await supabaseAdmin
      .from("games")
      .select(
        "game_id, game_time, status, venue, home_team_id, home_team_name, home_team_abbr, away_team_id, away_team_name, away_team_abbr, home_score, away_score, winner, predictions(home_win_prob, away_win_prob, home_win_pct, away_win_pct, home_pitcher_name, home_pitcher_era, away_pitcher_name, away_pitcher_era, rationale, correct, model_version)",
      )
      .eq("game_date", date)
      .order("game_time", { ascending: true });

    if (rows && rows.length > 0) {
      const games: PredictedGame[] = rows.map((r: any) => {
        const p = (r.predictions ?? []).find((x: any) => x.model_version === MODEL_VERSION) ?? r.predictions?.[0];
        return {
          gameId: r.game_id,
          date: r.game_time,
          status: r.status,
          venue: r.venue ?? "—",
          home: {
            id: r.home_team_id,
            name: r.home_team_name,
            abbreviation: r.home_team_abbr,
            record: "—",
            winPct: Number(p?.home_win_pct ?? 0.5),
            pitcher: p?.home_pitcher_name
              ? { id: null, name: p.home_pitcher_name, era: p.home_pitcher_era != null ? Number(p.home_pitcher_era) : null, wins: null, losses: null }
              : null,
          },
          away: {
            id: r.away_team_id,
            name: r.away_team_name,
            abbreviation: r.away_team_abbr,
            record: "—",
            winPct: Number(p?.away_win_pct ?? 0.5),
            pitcher: p?.away_pitcher_name
              ? { id: null, name: p.away_pitcher_name, era: p.away_pitcher_era != null ? Number(p.away_pitcher_era) : null, wins: null, losses: null }
              : null,
          },
          homeWinProb: Number(p?.home_win_prob ?? 0.5),
          awayWinProb: Number(p?.away_win_prob ?? 0.5),
          rationale: Array.isArray(p?.rationale) ? (p.rationale as string[]) : [],
          homeScore: r.home_score,
          awayScore: r.away_score,
          winner: r.winner,
          correct: p?.correct ?? null,
        };
      });
      return { date, games, source: "db" as const };
    }

    // Fallback: compute live (no persistence)
    const games = await buildPredictionsForDate(date);
    return { date, games, source: "live" as const };
  });

// Aggregate metrics for the dashboard
export const getMetrics = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: daily } = await supabaseAdmin
    .from("daily_metrics")
    .select("*")
    .eq("model_version", MODEL_VERSION)
    .order("metric_date", { ascending: true })
    .limit(60);

  const { data: totals } = await supabaseAdmin
    .from("predictions")
    .select("correct, brier, log_loss")
    .eq("model_version", MODEL_VERSION)
    .not("settled_at", "is", null);

  const settled = totals?.length ?? 0;
  const correct = totals?.filter((t: any) => t.correct).length ?? 0;
  const brier = settled > 0 ? totals!.reduce((a: number, t: any) => a + Number(t.brier ?? 0), 0) / settled : null;
  const logLoss = settled > 0 ? totals!.reduce((a: number, t: any) => a + Number(t.log_loss ?? 0), 0) / settled : null;

  return {
    modelVersion: MODEL_VERSION,
    settled,
    correct,
    accuracy: settled > 0 ? correct / settled : null,
    brier,
    logLoss,
    daily: daily ?? [],
  };
});

// Manual trigger from UI — same code path as the cron.
export const runPipeline = createServerFn({ method: "POST" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const { ingestAndPredict, settleFinished, recomputeDailyMetrics } = await import("./mlb-pipeline.server");
    const date = data?.date ?? todayISO();
    const ingest = await ingestAndPredict(date);
    const settle = await settleFinished();
    await recomputeDailyMetrics();
    return { date, ingest, settle };
  });