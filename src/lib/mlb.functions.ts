import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { buildPredictionsForDate, MODEL_VERSION, type PredictedGame } from "./mlb-core";
import { buildSimPredictionsForDate, MODEL_VERSION_SIM } from "./mlb-sim";
import { fetchOddsForDate } from "./mlb-odds.server";
import { blendWithMarket, pickProb, MODEL_VERSION_BLEND, MARKET_BLEND_WEIGHT } from "./mlb-blend";

export type { PredictedGame } from "./mlb-core";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Overlay live sim-elo-v2 win probabilities onto baseline PredictedGame
 * objects (which carry the richer display metadata — records, pitcher,
 * score). Used only when the DB has no rows yet for a date (e.g. today,
 * before the cron has ingested it).
 */
function mergeSimIntoBaseline(
  baseGames: PredictedGame[],
  simGames: Awaited<ReturnType<typeof buildSimPredictionsForDate>>,
): PredictedGame[] {
  const simByGameId = new Map(simGames.map((g) => [g.gameId, g]));
  return baseGames.map((g) => {
    const sim = simByGameId.get(g.gameId);
    if (!sim) return g;
    const homeWinProb = sim.ensembleProb;
    const awayWinProb = 1 - sim.ensembleProb;
    const correct =
      g.winner &&
      typeof g.homeScore === "number" &&
      typeof g.awayScore === "number" &&
      g.homeScore !== g.awayScore
        ? (homeWinProb >= 0.5 ? "home" : "away") === g.winner
        : (g.correct ?? null);
    return { ...g, homeWinProb, awayWinProb, rationale: sim.rationale, correct };
  });
}

/**
 * Canonical game list for a date: DB rows preferring sim-elo-v2 (falling back
 * to baseline-v0.4 per game if a sim row is somehow missing), or — if the DB
 * has nothing for this date yet — a live computation using the same primary
 * model. Every page (Today's Slate, Recommended, Best Odds) reads through
 * this single function so they can never disagree about whose probabilities
 * they're showing.
 */
async function loadGamesForDate(
  date: string,
): Promise<{ games: PredictedGame[]; source: "db" | "live" }> {
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: rows } = await supabase
      .from("games")
      .select(
        "game_id, game_time, status, venue, home_team_id, home_team_name, home_team_abbr, away_team_id, away_team_name, away_team_abbr, home_score, away_score, winner, predictions(home_win_prob, away_win_prob, home_win_pct, away_win_pct, home_pitcher_name, home_pitcher_era, away_pitcher_name, away_pitcher_era, rationale, correct, model_version)",
      )
      .eq("game_date", date)
      .order("game_time", { ascending: true });

    if (rows && rows.length > 0) {
      const games: PredictedGame[] = rows.map((r: any) => {
        const preds: any[] = r.predictions ?? [];
        const p =
          preds.find((x: any) => x.model_version === MODEL_VERSION_SIM) ??
          preds.find((x: any) => x.model_version === MODEL_VERSION) ??
          preds[0];
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
              ? {
                  id: null,
                  name: p.home_pitcher_name,
                  era: p.home_pitcher_era != null ? Number(p.home_pitcher_era) : null,
                  wins: null,
                  losses: null,
                }
              : null,
          },
          away: {
            id: r.away_team_id,
            name: r.away_team_name,
            abbreviation: r.away_team_abbr,
            record: "—",
            winPct: Number(p?.away_win_pct ?? 0.5),
            pitcher: p?.away_pitcher_name
              ? {
                  id: null,
                  name: p.away_pitcher_name,
                  era: p.away_pitcher_era != null ? Number(p.away_pitcher_era) : null,
                  wins: null,
                  losses: null,
                }
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
      return { games, source: "db" };
    }
  } catch (err) {
    // Supabase unavailable or error; fall back to live computation
    console.error("[loadGamesForDate] Supabase error, falling back to live API:", err);
  }

  // Fallback: compute live (no persistence) — baseline for metadata, sim-elo-v2 for the probability
  const [baseGames, simGames] = await Promise.all([
    buildPredictionsForDate(date),
    buildSimPredictionsForDate(date).catch(() => []),
  ]);
  const games = simGames.length > 0 ? mergeSimIntoBaseline(baseGames, simGames) : baseGames;
  return { games, source: "live" };
}

// Read-side: prefer DB (populated by the cron); fall back to live MLB API.
export const getDailyGames = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayISO();
    const { games, source } = await loadGamesForDate(date);
    return { date, games, source };
  });

// Aggregate metrics for the dashboard
export const getMetrics = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: daily } = await supabase
      .from("daily_metrics")
      .select("*")
      .eq("model_version", MODEL_VERSION_SIM)
      .order("metric_date", { ascending: true })
      .limit(60);

    const { data: totals } = await supabase
      .from("predictions")
      .select("correct, brier, log_loss, model_version")
      .eq("model_version", MODEL_VERSION_SIM)
      .not("settled_at", "is", null);

    const settled = totals?.length ?? 0;
    const correct = totals?.filter((t: any) => t.correct).length ?? 0;
    const brier =
      settled > 0
        ? totals!.reduce((a: number, t: any) => a + Number(t.brier ?? 0), 0) / settled
        : null;
    const logLoss =
      settled > 0
        ? totals!.reduce((a: number, t: any) => a + Number(t.log_loss ?? 0), 0) / settled
        : null;

    return {
      modelVersion: MODEL_VERSION_SIM,
      settled,
      correct,
      accuracy: settled > 0 ? correct / settled : null,
      brier,
      logLoss,
      daily: daily ?? [],
    };
  } catch (err) {
    console.error("[getMetrics] Supabase error, returning empty metrics:", err);
    return {
      modelVersion: MODEL_VERSION_SIM,
      settled: 0,
      correct: 0,
      accuracy: null,
      brier: null,
      logLoss: null,
      daily: [],
    };
  }
});

// Fetch recent settled predictions for the history page
export const getSettledPredictions = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: predictions } = await supabase
      .from("predictions")
      .select(
        "game_id, home_win_prob, away_win_prob, correct, brier, log_loss, settled_at, rationale, games!inner(game_date, home_team_name, home_team_abbr, away_team_name, away_team_abbr, home_score, away_score, winner, status)",
      )
      .eq("model_version", MODEL_VERSION_SIM)
      .not("settled_at", "is", null)
      .order("settled_at", { ascending: false })
      .limit(100);
    return { predictions: (predictions ?? []) as any[] };
  } catch (err) {
    console.error("[getSettledPredictions] error:", err);
    return { predictions: [] as any[] };
  }
});

export interface SegmentTotals {
  n: number;
  correct: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
}

export interface SegmentDayRow {
  date: string;
  n: number;
  accuracy: number | null;
  brier: number | null;
}

export interface SegmentedGame {
  gameId: number;
  date: string;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  winner: string | null;
  predictedWinner: string;
  predictedProb: number;
  correct: boolean | null;
  brier: number | null;
  logLoss: number | null;
  edge: number | null;
  isRecommended: boolean;
  isBestOdds: boolean;
}

function emptyTotals(): SegmentTotals {
  return { n: 0, correct: 0, accuracy: null, brier: null, logLoss: null };
}

function finalizeTotals(
  t: SegmentTotals & { brierSum: number; logLossSum: number },
): SegmentTotals {
  return {
    n: t.n,
    correct: t.correct,
    accuracy: t.n > 0 ? t.correct / t.n : null,
    brier: t.n > 0 ? t.brierSum / t.n : null,
    logLoss: t.n > 0 ? t.logLossSum / t.n : null,
  };
}

/**
 * All-time accuracy for the primary model (sim-elo-v2), split into three
 * honest segments: every settled game, the subset that would have been a
 * "Recommended" top-3-by-confidence pick on its date, and the subset that
 * would have been a "Best Odds" top-3 pick on its date — ranked, like the
 * page, by odds-blend-v1 confidence (model ⊕ devigged market) and scored
 * with that blended probability (only dates with cached market odds
 * contribute). The ranking logic mirrors getRecommendedPicks /
 * getBestOddsPicks exactly, so history is reconstructed rather than
 * approximated.
 */
export const getTrackRecordSegments = createServerFn({ method: "GET" }).handler(async () => {
  const empty = {
    segments: { all: emptyTotals(), recommended: emptyTotals(), best_odds: emptyTotals() },
    daily: {
      all: [] as SegmentDayRow[],
      recommended: [] as SegmentDayRow[],
      best_odds: [] as SegmentDayRow[],
    },
    games: [] as SegmentedGame[],
    modelVersion: MODEL_VERSION_SIM,
    comparisonBrier: null as number | null,
  };
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: rows, error } = await supabase
      .from("games")
      .select(
        "game_id, game_date, home_team_abbr, away_team_abbr, home_score, away_score, winner, " +
          "predictions(model_version, home_win_prob, correct, brier, log_loss, settled_at), " +
          "game_odds(home_implied_prob, away_implied_prob)",
      )
      .not("winner", "is", null)
      .order("game_date", { ascending: true });
    if (error) throw error;

    type ByDate = {
      date: string;
      gameId: number;
      home: string;
      away: string;
      homeScore: number | null;
      awayScore: number | null;
      winner: string;
      homeWinProb: number;
      correct: boolean;
      brier: number;
      logLoss: number;
      confidence: number;
      edge: number | null;
      /** odds-blend-v1 numbers, scored against the outcome (null without market odds). */
      blendedProb: number | null;
      blendCorrect: boolean | null;
      blendBrier: number | null;
      blendLogLoss: number | null;
    };
    const settled: ByDate[] = [];
    for (const g of (rows ?? []) as any[]) {
      const pred = (g.predictions ?? []).find(
        (p: any) => p.model_version === MODEL_VERSION_SIM && p.settled_at != null,
      );
      if (!pred) continue;
      const homeWinProb = Number(pred.home_win_prob);
      const odds = g.game_odds ?? null;
      const edge =
        odds?.home_implied_prob != null ? homeWinProb - Number(odds.home_implied_prob) : null;
      const blendedProb =
        odds?.home_implied_prob != null
          ? blendWithMarket(homeWinProb, Number(odds.home_implied_prob))
          : null;
      const y = g.winner === "home" ? 1 : 0;
      const eps = 1e-6;
      const pc = blendedProb != null ? Math.min(1 - eps, Math.max(eps, blendedProb)) : null;
      settled.push({
        date: g.game_date,
        gameId: g.game_id,
        home: g.home_team_abbr,
        away: g.away_team_abbr,
        homeScore: g.home_score,
        awayScore: g.away_score,
        winner: g.winner,
        homeWinProb,
        correct: !!pred.correct,
        brier: Number(pred.brier ?? 0),
        logLoss: Number(pred.log_loss ?? 0),
        confidence: Math.abs(homeWinProb - 0.5) * 2,
        edge,
        blendedProb,
        blendCorrect: blendedProb != null ? blendedProb >= 0.5 === (y === 1) : null,
        blendBrier: blendedProb != null ? (blendedProb - y) ** 2 : null,
        blendLogLoss: pc != null ? -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc)) : null,
      });
    }
    if (settled.length === 0) return empty;

    const byDate = new Map<string, ByDate[]>();
    for (const s of settled) {
      const arr = byDate.get(s.date) ?? [];
      arr.push(s);
      byDate.set(s.date, arr);
    }

    const recommendedIds = new Set<number>();
    const bestOddsIds = new Set<number>();
    for (const dayGames of byDate.values()) {
      [...dayGames]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        .forEach((g) => recommendedIds.add(g.gameId));
      [...dayGames]
        .filter((g) => g.blendedProb != null)
        .sort((a, b) => pickProb(b.blendedProb!) - pickProb(a.blendedProb!))
        .slice(0, 3)
        .forEach((g) => bestOddsIds.add(g.gameId));
    }

    const acc = () => ({ ...emptyTotals(), brierSum: 0, logLossSum: 0 });
    const totals = { all: acc(), recommended: acc(), best_odds: acc() };
    const dayBuckets = {
      all: new Map<string, { n: number; correct: number; brierSum: number }>(),
      recommended: new Map<string, { n: number; correct: number; brierSum: number }>(),
      best_odds: new Map<string, { n: number; correct: number; brierSum: number }>(),
    };
    const bump = (
      bucket: Map<string, { n: number; correct: number; brierSum: number }>,
      date: string,
      correct: boolean,
      brier: number,
    ) => {
      const b = bucket.get(date) ?? { n: 0, correct: 0, brierSum: 0 };
      b.n += 1;
      if (correct) b.correct += 1;
      b.brierSum += brier;
      bucket.set(date, b);
    };

    const games: SegmentedGame[] = [];
    for (const s of settled) {
      const isRecommended = recommendedIds.has(s.gameId);
      const isBestOdds = bestOddsIds.has(s.gameId);
      totals.all.n++;
      totals.all.correct += s.correct ? 1 : 0;
      totals.all.brierSum += s.brier;
      totals.all.logLossSum += s.logLoss;
      bump(dayBuckets.all, s.date, s.correct, s.brier);
      if (isRecommended) {
        totals.recommended.n++;
        totals.recommended.correct += s.correct ? 1 : 0;
        totals.recommended.brierSum += s.brier;
        totals.recommended.logLossSum += s.logLoss;
        bump(dayBuckets.recommended, s.date, s.correct, s.brier);
      }
      if (isBestOdds && s.blendCorrect != null) {
        // Scored with the blended probability the Best Odds page shows,
        // not the raw model number.
        totals.best_odds.n++;
        totals.best_odds.correct += s.blendCorrect ? 1 : 0;
        totals.best_odds.brierSum += s.blendBrier!;
        totals.best_odds.logLossSum += s.blendLogLoss!;
        bump(dayBuckets.best_odds, s.date, s.blendCorrect, s.blendBrier!);
      }
      const predictedWinner = s.homeWinProb >= 0.5 ? s.home : s.away;
      const predictedProb = s.homeWinProb >= 0.5 ? s.homeWinProb : 1 - s.homeWinProb;
      games.push({
        gameId: s.gameId,
        date: s.date,
        home: s.home,
        away: s.away,
        homeScore: s.homeScore,
        awayScore: s.awayScore,
        winner: s.winner,
        predictedWinner,
        predictedProb,
        correct: s.correct,
        brier: s.brier,
        logLoss: s.logLoss,
        edge: s.edge,
        isRecommended,
        isBestOdds,
      });
    }

    const toDayRows = (
      m: Map<string, { n: number; correct: number; brierSum: number }>,
    ): SegmentDayRow[] =>
      Array.from(m.entries())
        .map(([date, b]) => ({
          date,
          n: b.n,
          accuracy: b.n > 0 ? b.correct / b.n : null,
          brier: b.n > 0 ? b.brierSum / b.n : null,
        }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));

    // Comparison baseline shown alongside the primary model's numbers.
    const { data: baselineTotals } = await supabase
      .from("predictions")
      .select("brier")
      .eq("model_version", MODEL_VERSION)
      .not("settled_at", "is", null);
    const comparisonBrier =
      baselineTotals && baselineTotals.length > 0
        ? baselineTotals.reduce((a: number, t: any) => a + Number(t.brier ?? 0), 0) /
          baselineTotals.length
        : null;

    return {
      segments: {
        all: finalizeTotals(totals.all),
        recommended: finalizeTotals(totals.recommended),
        best_odds: finalizeTotals(totals.best_odds),
      },
      daily: {
        all: toDayRows(dayBuckets.all),
        recommended: toDayRows(dayBuckets.recommended),
        best_odds: toDayRows(dayBuckets.best_odds),
      },
      games: games.sort((a, b) => (a.date < b.date ? 1 : -1)),
      modelVersion: MODEL_VERSION_SIM,
      comparisonBrier,
    };
  } catch (err) {
    console.error("[getTrackRecordSegments] error:", err);
    return empty;
  }
});

// Manual trigger from UI — same code path as the cron.
export const runPipeline = createServerFn({ method: "POST" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const { ingestAndPredict, settleFinished, recomputeDailyMetrics } =
      await import("./mlb-pipeline.server");
    const date = data?.date ?? todayISO();
    const ingest = await ingestAndPredict(date);
    const settle = await settleFinished();
    await recomputeDailyMetrics();
    return { date, ingest, settle };
  });

// Per-team performance leaderboard: actual W-L from games + model accuracy per team.
export const getTeamLeaderboard = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { supabase } = await import("@/integrations/supabase/client");

    const { data: games } = await supabase
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
        r = {
          id,
          name,
          abbr,
          wins: 0,
          losses: 0,
          runsFor: 0,
          runsAgainst: 0,
          predicted: 0,
          predictedCorrect: 0,
        };
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
      const p =
        (g.predictions ?? []).find((x: any) => x.model_version === MODEL_VERSION_SIM) ??
        g.predictions?.[0];
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

    return { teams, modelVersion: MODEL_VERSION_SIM };
  } catch (err) {
    console.error("[getTeamLeaderboard] Supabase error, returning empty teams:", err);
    return { teams: [], modelVersion: MODEL_VERSION_SIM };
  }
});

function confidenceOf(g: PredictedGame): number {
  return Math.abs(g.homeWinProb - 0.5) * 2;
}

// Top-3 highest-confidence picks for the next slate with games, sourced from
// the same canonical game list as Today's Slate and Best Odds (loadGamesForDate)
// so all three pages always agree on the underlying probabilities.
export const getRecommendedPicks = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayISO();
    const { games, source } = await loadGamesForDate(date);
    const picks = [...games].sort((a, b) => confidenceOf(b) - confidenceOf(a)).slice(0, 3);
    return { date, games, picks, source, modelVersion: MODEL_VERSION_SIM };
  });

export interface GameOdds {
  provider: string;
  homeMoneyLine: number;
  awayMoneyLine: number;
  homeImpliedProb: number;
  awayImpliedProb: number;
}

export interface GameWithOdds {
  game: PredictedGame;
  odds: GameOdds | null;
  /** Our probability minus the devigged market's, from the home side. Null with no market data. */
  edge: number | null;
  /** Home win prob blending sim-elo-v2 with the devigged market (odds-blend-v1). Null with no market data. */
  blendedHomeProb: number | null;
}

// Best Odds picks, ranked by confidence in the outcome (how likely the pick
// is to win), two ways: by the market's own devigged line alone, and by
// odds-blend-v1 — the market line blended with our sim-elo-v2 prediction.
// Market odds come from ESPN/DraftKings, cached in `game_odds` and refreshed
// here for any game that's missing or stale.
export const getBestOddsPicks = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayISO();
    const { games, source } = await loadGamesForDate(date);
    if (games.length === 0) {
      return {
        date,
        games: [] as GameWithOdds[],
        marketPicks: [] as GameWithOdds[],
        blendPicks: [] as GameWithOdds[],
        source,
        modelVersion: MODEL_VERSION_SIM,
        blendVersion: MODEL_VERSION_BLEND,
        blendWeight: MARKET_BLEND_WEIGHT,
      };
    }

    const STALE_MS = 6 * 60 * 60 * 1000;
    const oddsMap = new Map<number, GameOdds>();
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: rows } = await supabase
        .from("game_odds")
        .select(
          "game_id, provider, home_moneyline, away_moneyline, home_implied_prob, away_implied_prob, fetched_at",
        )
        .in(
          "game_id",
          games.map((g) => g.gameId),
        );
      const now = Date.now();
      for (const r of rows ?? []) {
        const fresh = now - new Date(r.fetched_at).getTime() < STALE_MS;
        // Final/in-progress games never need a re-fetch even if the cache is old.
        const g = games.find((x) => x.gameId === r.game_id);
        if (!fresh && g?.correct == null && g?.winner == null) continue;
        if (r.home_moneyline == null || r.away_moneyline == null) continue;
        oddsMap.set(r.game_id, {
          provider: r.provider,
          homeMoneyLine: r.home_moneyline,
          awayMoneyLine: r.away_moneyline,
          homeImpliedProb: Number(r.home_implied_prob),
          awayImpliedProb: Number(r.away_implied_prob),
        });
      }
    } catch (err) {
      console.error("[getBestOddsPicks] game_odds read failed:", err);
    }

    const missing = games.filter((g) => !oddsMap.has(g.gameId));
    if (missing.length > 0) {
      try {
        const fetched = await fetchOddsForDate(
          date,
          missing.map((g) => ({
            gameId: g.gameId,
            homeName: g.home.name,
            awayName: g.away.name,
            homeAbbr: g.home.abbreviation,
            awayAbbr: g.away.abbreviation,
          })),
        );
        for (const o of fetched) {
          oddsMap.set(o.gameId, {
            provider: o.provider,
            homeMoneyLine: o.homeMoneyLine,
            awayMoneyLine: o.awayMoneyLine,
            homeImpliedProb: o.homeImpliedProb,
            awayImpliedProb: o.awayImpliedProb,
          });
        }
      } catch (err) {
        console.error("[getBestOddsPicks] live odds fetch failed:", err);
      }
    }

    const withOdds: GameWithOdds[] = games.map((game) => {
      const odds = oddsMap.get(game.gameId) ?? null;
      const edge = odds ? game.homeWinProb - odds.homeImpliedProb : null;
      const blendedHomeProb = odds ? blendWithMarket(game.homeWinProb, odds.homeImpliedProb) : null;
      return { game, odds, edge, blendedHomeProb };
    });

    const priced = withOdds.filter((x): x is GameWithOdds & { odds: GameOdds } => x.odds != null);
    // Tab 1 — safest bets by the market's own line
    const marketPicks = [...priced]
      .sort((a, b) => pickProb(b.odds.homeImpliedProb) - pickProb(a.odds.homeImpliedProb))
      .slice(0, 3);
    // Tab 2 — safest bets once our prediction is blended in
    const blendPicks = [...priced]
      .sort((a, b) => pickProb(b.blendedHomeProb!) - pickProb(a.blendedHomeProb!))
      .slice(0, 3);

    return {
      date,
      games: withOdds,
      marketPicks,
      blendPicks,
      source,
      modelVersion: MODEL_VERSION_SIM,
      blendVersion: MODEL_VERSION_BLEND,
      blendWeight: MARKET_BLEND_WEIGHT,
    };
  });

// Backtest: run both models over recent historical dates and return metrics comparison.
// Fetches from MLB Stats API only — no Supabase required.
export const runBacktest = createServerFn({ method: "POST" })
  .inputValidator(z.object({ days: z.number().optional() }).optional())
  .handler(async ({ data }) => {
    const { buildPredictionsForDate } = await import("./mlb-core");
    const { buildPredictionsV4ForDate, MODEL_VERSION_V4 } = await import("./mlb-core-v4");
    const { offsetDate } = await import("./mlb-features");

    const days = Math.min(data?.days ?? 7, 14); // cap at 14 for performance
    const today = todayISO();
    const endDate = offsetDate(today, -1);
    const startDate = offsetDate(endDate, -(days - 1));

    // Build date list
    const dates: string[] = [];
    let cur = startDate;
    while (cur <= endDate) {
      dates.push(cur);
      cur = offsetDate(cur, 1);
    }

    interface GameResult {
      date: string;
      gameId: number;
      home: string;
      away: string;
      winner: string | null;
      v3HomeProb: number;
      v4HomeProb: number;
    }

    const allResults: GameResult[] = [];

    for (const date of dates) {
      try {
        const [v3Games, v4Games] = await Promise.all([
          buildPredictionsForDate(date).catch(() => []),
          buildPredictionsV4ForDate(date).catch(() => []),
        ]);
        const v4Map = new Map(v4Games.map((g: any) => [g.gameId, g]));
        for (const g of v3Games) {
          const v4 = v4Map.get(g.gameId) as any;
          if (!v4) continue;
          allResults.push({
            date,
            gameId: g.gameId,
            home: g.home.name,
            away: g.away.name,
            winner: g.winner ?? null,
            v3HomeProb: g.homeWinProb,
            v4HomeProb: v4.v4WinProb,
          });
        }
      } catch {
        // Skip dates that fail (off days, API timeouts)
      }
    }

    const settled = allResults.filter((r) => r.winner != null);
    if (settled.length === 0) {
      return {
        startDate,
        endDate,
        totalGames: allResults.length,
        settledGames: 0,
        v3: null,
        v4: null,
        modelV3: MODEL_VERSION,
        modelV4: MODEL_VERSION_V4,
      };
    }

    const eps = 1e-7;
    const score = (prob: number, winner: string | null) => {
      const y = winner === "home" ? 1 : 0;
      const p = Math.min(1 - eps, Math.max(eps, prob));
      return {
        correct: (prob >= 0.5 ? "home" : "away") === winner,
        brier: (prob - y) ** 2,
        logLoss: -(y * Math.log(p) + (1 - y) * Math.log(1 - p)),
      };
    };

    const v3Scores = settled.map((r) => score(r.v3HomeProb, r.winner));
    const v4Scores = settled.map((r) => score(r.v4HomeProb, r.winner));
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      startDate,
      endDate,
      totalGames: allResults.length,
      settledGames: settled.length,
      modelV3: MODEL_VERSION,
      modelV4: MODEL_VERSION_V4,
      v3: {
        correct: v3Scores.filter((s) => s.correct).length,
        accuracy: avg(v3Scores.map((s) => (s.correct ? 1 : 0))),
        brier: avg(v3Scores.map((s) => s.brier)),
        logLoss: avg(v3Scores.map((s) => s.logLoss)),
      },
      v4: {
        correct: v4Scores.filter((s) => s.correct).length,
        accuracy: avg(v4Scores.map((s) => (s.correct ? 1 : 0))),
        brier: avg(v4Scores.map((s) => s.brier)),
        logLoss: avg(v4Scores.map((s) => s.logLoss)),
      },
    };
  });
