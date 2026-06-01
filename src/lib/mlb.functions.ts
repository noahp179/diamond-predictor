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
    .order("metric_date", { ascending: true })
    .limit(60);

  const { data: totals } = await supabaseAdmin
    .from("predictions")
    .select("correct, brier, log_loss, model_version")
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

// Per-team performance leaderboard: actual W-L from games + model accuracy per team.
export const getTeamLeaderboard = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: games } = await supabaseAdmin
    .from("games")
    .select(
      "game_id, home_team_id, home_team_name, home_team_abbr, away_team_id, away_team_name, away_team_abbr, winner, home_score, away_score, status, predictions(home_win_prob, correct, model_version)",
    )
    .not("winner", "is", null);

  type Row = {
    id: number;
    name: string;
    abbr: string;
    wins: number;
    losses: number;
    runsFor: number;
    runsAgainst: number;
    predicted: number;
    predictedCorrect: number;
  };
  const map = new Map<number, Row>();
  const bump = (id: number, name: string, abbr: string): Row => {
    let r = map.get(id);
    if (!r) {
      r = { id, name, abbr, wins: 0, losses: 0, runsFor: 0, runsAgainst: 0, predicted: 0, predictedCorrect: 0 };
      map.set(id, r);
    }
    return r;
  };

  for (const g of (games ?? []) as any[]) {
    const home = bump(g.home_team_id, g.home_team_name, g.home_team_abbr);
    const away = bump(g.away_team_id, g.away_team_name, g.away_team_abbr);
    if (typeof g.home_score === "number" && typeof g.away_score === "number") {
      home.runsFor += g.home_score;
      home.runsAgainst += g.away_score;
      away.runsFor += g.away_score;
      away.runsAgainst += g.home_score;
    }
    if (g.winner === "home") {
      home.wins += 1;
      away.losses += 1;
    } else if (g.winner === "away") {
      away.wins += 1;
      home.losses += 1;
    }
    const p = (g.predictions ?? []).find((x: any) => x.model_version === MODEL_VERSION) ?? g.predictions?.[0];
    if (p && p.correct != null) {
      home.predicted += 1;
      away.predicted += 1;
      if (p.correct) {
        home.predictedCorrect += 1;
        away.predictedCorrect += 1;
      }
    }
  }

  const teams = Array.from(map.values())
    .map((t) => ({
      ...t,
      winPct: t.wins + t.losses > 0 ? t.wins / (t.wins + t.losses) : 0,
      runDiff: t.runsFor - t.runsAgainst,
      modelAccuracy: t.predicted > 0 ? t.predictedCorrect / t.predicted : null,
    }))
    .sort((a, b) => b.winPct - a.winPct || b.runDiff - a.runDiff);

  return { teams, modelVersion: MODEL_VERSION };
});