import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { buildPredictionsForDate, MODEL_VERSION, type PredictedGame } from "./mlb-core";
import { buildSimPredictionsForDate, MODEL_VERSION_SIM } from "./mlb-sim";
import {
  buildRecentFormPredictionsForDate,
  buildRecentFormV2PredictionsForDate,
} from "./mlb-recent-form";
import { fetchOddsForDate } from "./mlb-odds.server";
import { blendWithMarket, pickProb, MODEL_VERSION_BLEND, MARKET_BLEND_WEIGHT } from "./mlb-blend";
import {
  TRACK_RECORD_START,
  TRACKED_MODELS,
  MODEL_VERSION_RECENT,
  MODEL_VERSION_RECENT_V2,
  MODEL_LABELS,
} from "./mlb-models";

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

// The two secondary models shown beneath the primary (v1) number, in order.
const ALT_ORDER = [MODEL_LABELS[MODEL_VERSION_RECENT], MODEL_LABELS[MODEL_VERSION_RECENT_V2]]; // ["v2","v3"]

function sortAlt(alt: PredictedGame["altModels"]): PredictedGame["altModels"] {
  if (!alt) return alt;
  return [...alt].sort((a, b) => ALT_ORDER.indexOf(a.label) - ALT_ORDER.indexOf(b.label));
}

/**
 * Attach one secondary model's win probabilities to each game as an extra
 * (altModels) display number under the given `label`. Used on the live fallback
 * path so today's slate shows every model even before the cron has stored rows,
 * and to backfill the DB path for games whose stored row for that model is
 * missing. A game that already carries an entry for `label` (a stored row) is
 * left untouched. Point-in-time safe and, thanks to the models' deterministic
 * per-game seeds, identical to the number the cron will later store.
 */
function attachAltModel(
  games: PredictedGame[],
  built: Array<{ gameId: number; ensembleProb: number }>,
  label: string,
): PredictedGame[] {
  if (built.length === 0) return games;
  const byId = new Map(built.map((g) => [g.gameId, g]));
  return games.map((g) => {
    if (g.altModels?.some((m) => m.label === label)) return g;
    const r = byId.get(g.gameId);
    if (!r) return g;
    return {
      ...g,
      altModels: sortAlt([
        ...(g.altModels ?? []),
        { label, homeWinProb: r.ensembleProb, awayWinProb: 1 - r.ensembleProb },
      ]),
    };
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
        const recent = preds.find((x: any) => x.model_version === MODEL_VERSION_RECENT);
        const recentV2 = preds.find((x: any) => x.model_version === MODEL_VERSION_RECENT_V2);
        const altModels: NonNullable<PredictedGame["altModels"]> = [];
        if (recent && recent.home_win_prob != null) {
          altModels.push({
            label: MODEL_LABELS[MODEL_VERSION_RECENT],
            homeWinProb: Number(recent.home_win_prob),
            awayWinProb: Number(recent.away_win_prob),
          });
        }
        if (recentV2 && recentV2.home_win_prob != null) {
          altModels.push({
            label: MODEL_LABELS[MODEL_VERSION_RECENT_V2],
            homeWinProb: Number(recentV2.home_win_prob),
            awayWinProb: Number(recentV2.away_win_prob),
          });
        }
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
          altModels,
        };
      });
      // The stored v2/v3 rows only exist for games predicted pre-game after
      // each model shipped; older games — and any slate where the heavy
      // recent-form steps didn't finish before rows were written — have none,
      // so those cards would render only the primary percentage. When any game
      // on this date is missing v2 or v3, compute that model live purely for
      // display so all three numbers show. Never persisted (the track record
      // stays hindsight-free); point-in-time safe (trailing windows ending the
      // day before `date`); and, thanks to the models' deterministic per-game
      // seeds, identical to the numbers the cron will later store.
      const v2Label = MODEL_LABELS[MODEL_VERSION_RECENT];
      const v3Label = MODEL_LABELS[MODEL_VERSION_RECENT_V2];
      const needV2 = games.some((g) => !g.altModels?.some((m) => m.label === v2Label));
      const needV3 = games.some((g) => !g.altModels?.some((m) => m.label === v3Label));
      if (needV2 || needV3) {
        const [recentGames, recentV2Games] = await Promise.all([
          needV2 ? buildRecentFormPredictionsForDate(date).catch(() => []) : Promise.resolve([]),
          needV3 ? buildRecentFormV2PredictionsForDate(date).catch(() => []) : Promise.resolve([]),
        ]);
        let out = attachAltModel(games, recentGames, v2Label);
        out = attachAltModel(out, recentV2Games, v3Label);
        return { games: out, source: "db" };
      }
      return { games, source: "db" };
    }
  } catch (err) {
    // Supabase unavailable or error; fall back to live computation
    console.error("[loadGamesForDate] Supabase error, falling back to live API:", err);
  }

  // Fallback: compute live (no persistence) — baseline for metadata, sim-elo-v2
  // for the primary (v1) probability, sim-recent-v1 (v2) and sim-recent-v2 (v3)
  // for the two secondary display numbers.
  const [baseGames, simGames, recentGames, recentV2Games] = await Promise.all([
    buildPredictionsForDate(date),
    buildSimPredictionsForDate(date).catch(() => []),
    buildRecentFormPredictionsForDate(date).catch(() => []),
    buildRecentFormV2PredictionsForDate(date).catch(() => []),
  ]);
  const merged = simGames.length > 0 ? mergeSimIntoBaseline(baseGames, simGames) : baseGames;
  let games = attachAltModel(merged, recentGames, MODEL_LABELS[MODEL_VERSION_RECENT]);
  games = attachAltModel(games, recentV2Games, MODEL_LABELS[MODEL_VERSION_RECENT_V2]);
  return { games, source: "live" };
}

// Read-side: prefer DB (populated by the cron); fall back to live MLB API.
export const getDailyGames = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const { runPipelineIfDue } = await import("./mlb-pipeline.server");
    await runPipelineIfDue().catch((err) => console.error("[getDailyGames] runPipelineIfDue failed:", err));
    const date = data?.date ?? todayISO();
    const { games, source } = await loadGamesForDate(date);
    return { date, games, source };
  });

// Aggregate metrics for the dashboard
export const getMetrics = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { runPipelineIfDue } = await import("./mlb-pipeline.server");
    await runPipelineIfDue().catch((err) => console.error("[getMetrics] runPipelineIfDue failed:", err));
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
    const { runPipelineIfDue } = await import("./mlb-pipeline.server");
    await runPipelineIfDue().catch((err) =>
      console.error("[getSettledPredictions] runPipelineIfDue failed:", err),
    );
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

/** One model's settled numbers (or pending prediction) on one game. */
export interface ModelGameScore {
  prob: number; // home win probability
  correct: boolean | null; // null = not settled yet
  brier: number | null;
  logLoss: number | null;
}

export interface TrackedGame {
  gameId: number;
  date: string;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  winner: string | null;
  /** Stored (last pre-game) moneylines — null when no line was cached. */
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  isRecommended: boolean;
  isBestOdds: boolean;
  /** Scores keyed by model version — only versions with a row on this game. */
  models: Record<string, ModelGameScore>;
}

export interface ModelTrack {
  version: string;
  settled: SegmentTotals;
  /** Predictions recorded but not yet settled (today's slate). */
  pending: number;
  daily: SegmentDayRow[];
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
 * Track record from TRACK_RECORD_START forward, for every model version the
 * pipeline stores (sim-elo-v2, odds-blend-v1, market-devig, baseline-v0.4),
 * each scored identically at settlement. Games before the start date are the
 * baseline-only era (cron outage, no odds cached) and are excluded so the
 * models compare on the same slate.
 *
 * Also reconstructs the primary model's page-pick segments within the window:
 * "Recommended" (top-3 by sim-elo-v2 confidence per day) and "Best Odds"
 * (top-3 by stored odds-blend-v1 confidence per day, scored with the blend's
 * own numbers) — mirroring getRecommendedPicks / getBestOddsPicks.
 */
export const getTrackRecord = createServerFn({ method: "GET" }).handler(async () => {
  const empty = {
    trackingSince: TRACK_RECORD_START,
    primaryModel: MODEL_VERSION_SIM,
    models: [] as ModelTrack[],
    segments: { all: emptyTotals(), recommended: emptyTotals(), best_odds: emptyTotals() },
    games: [] as TrackedGame[],
  };
  try {
    const { runPipelineIfDue } = await import("./mlb-pipeline.server");
    await runPipelineIfDue().catch((err) => console.error("[getTrackRecord] runPipelineIfDue failed:", err));
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: rows, error } = await supabase
      .from("games")
      .select(
        "game_id, game_date, home_team_abbr, away_team_abbr, home_score, away_score, winner, " +
          "game_odds(home_moneyline, away_moneyline), " +
          "predictions(model_version, home_win_prob, correct, brier, log_loss, settled_at)",
      )
      .gte("game_date", TRACK_RECORD_START)
      .order("game_date", { ascending: true });
    if (error) throw error;

    type Acc = SegmentTotals & { brierSum: number; logLossSum: number };
    const mkAcc = (): Acc => ({ ...emptyTotals(), brierSum: 0, logLossSum: 0 });
    const bumpAcc = (a: Acc, s: ModelGameScore) => {
      a.n++;
      if (s.correct) a.correct++;
      a.brierSum += s.brier ?? 0;
      a.logLossSum += s.logLoss ?? 0;
    };

    const perModel = new Map<
      string,
      {
        totals: Acc;
        pending: number;
        days: Map<string, { n: number; correct: number; brierSum: number }>;
      }
    >();
    const ensureModel = (v: string) => {
      let m = perModel.get(v);
      if (!m) {
        m = { totals: mkAcc(), pending: 0, days: new Map() };
        perModel.set(v, m);
      }
      return m;
    };
    for (const m of TRACKED_MODELS) ensureModel(m.version);

    const games: TrackedGame[] = [];
    for (const g of (rows ?? []) as any[]) {
      const winner: string | null = g.winner ?? null;
      const scores: Record<string, ModelGameScore> = {};
      for (const p of (g.predictions ?? []) as any[]) {
        const m = ensureModel(p.model_version);
        if (p.settled_at != null && winner) {
          const s: ModelGameScore = {
            prob: Number(p.home_win_prob),
            correct: !!p.correct,
            brier: p.brier != null ? Number(p.brier) : null,
            logLoss: p.log_loss != null ? Number(p.log_loss) : null,
          };
          scores[p.model_version] = s;
          bumpAcc(m.totals, s);
          const day = m.days.get(g.game_date) ?? { n: 0, correct: 0, brierSum: 0 };
          day.n++;
          if (s.correct) day.correct++;
          day.brierSum += s.brier ?? 0;
          m.days.set(g.game_date, day);
        } else if (p.settled_at == null) {
          m.pending++;
          scores[p.model_version] = {
            prob: Number(p.home_win_prob),
            correct: null,
            brier: null,
            logLoss: null,
          };
        }
      }
      // game_odds is one row per game; PostgREST returns the embed as an
      // object, but tolerate the array shape too.
      const odds = Array.isArray(g.game_odds) ? g.game_odds[0] : g.game_odds;
      games.push({
        gameId: g.game_id,
        date: g.game_date,
        home: g.home_team_abbr,
        away: g.away_team_abbr,
        homeScore: g.home_score,
        awayScore: g.away_score,
        winner,
        homeMoneyline: odds?.home_moneyline ?? null,
        awayMoneyline: odds?.away_moneyline ?? null,
        isRecommended: false,
        isBestOdds: false,
        models: scores,
      });
    }

    // ── Page-pick segments for the primary model, reconstructed per day.
    const byDate = new Map<string, TrackedGame[]>();
    for (const tg of games) {
      if (tg.winner == null) continue; // picks are judged on settled games
      const arr = byDate.get(tg.date) ?? [];
      arr.push(tg);
      byDate.set(tg.date, arr);
    }
    const recommendedIds = new Set<number>();
    const bestOddsIds = new Set<number>();
    for (const dayGames of byDate.values()) {
      dayGames
        .filter((tg) => tg.models[MODEL_VERSION_SIM]?.correct != null)
        .sort(
          (a, b) =>
            pickProb(b.models[MODEL_VERSION_SIM].prob) - pickProb(a.models[MODEL_VERSION_SIM].prob),
        )
        .slice(0, 3)
        .forEach((tg) => recommendedIds.add(tg.gameId));
      dayGames
        .filter((tg) => tg.models[MODEL_VERSION_BLEND]?.correct != null)
        .sort(
          (a, b) =>
            pickProb(b.models[MODEL_VERSION_BLEND].prob) -
            pickProb(a.models[MODEL_VERSION_BLEND].prob),
        )
        .slice(0, 3)
        .forEach((tg) => bestOddsIds.add(tg.gameId));
    }

    const segTotals = { all: mkAcc(), recommended: mkAcc(), best_odds: mkAcc() };
    for (const tg of games) {
      tg.isRecommended = recommendedIds.has(tg.gameId);
      tg.isBestOdds = bestOddsIds.has(tg.gameId);
      const sim = tg.models[MODEL_VERSION_SIM];
      if (sim?.correct != null) {
        bumpAcc(segTotals.all, sim);
        if (tg.isRecommended) bumpAcc(segTotals.recommended, sim);
      }
      // Best Odds picks are scored with the blend's own stored numbers.
      const blend = tg.models[MODEL_VERSION_BLEND];
      if (tg.isBestOdds && blend?.correct != null) bumpAcc(segTotals.best_odds, blend);
    }

    const knownVersions = TRACKED_MODELS.map((m) => m.version);
    const orderedVersions = [
      ...knownVersions,
      ...Array.from(perModel.keys()).filter((v) => !knownVersions.includes(v)),
    ];
    const models: ModelTrack[] = orderedVersions
      .map((version) => {
        const m = perModel.get(version)!;
        return {
          version,
          settled: finalizeTotals(m.totals),
          pending: m.pending,
          daily: Array.from(m.days.entries())
            .map(([date, b]) => ({
              date,
              n: b.n,
              accuracy: b.n > 0 ? b.correct / b.n : null,
              brier: b.n > 0 ? b.brierSum / b.n : null,
            }))
            .sort((a, b) => (a.date < b.date ? -1 : 1)),
        };
      })
      // Hide versions with no activity in the window (e.g. retired baselines).
      .filter((m) => m.settled.n > 0 || m.pending > 0 || knownVersions.includes(m.version));

    return {
      trackingSince: TRACK_RECORD_START,
      primaryModel: MODEL_VERSION_SIM,
      models,
      segments: {
        all: finalizeTotals(segTotals.all),
        recommended: finalizeTotals(segTotals.recommended),
        best_odds: finalizeTotals(segTotals.best_odds),
      },
      games: games
        .filter((tg) => Object.keys(tg.models).length > 0)
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  } catch (err) {
    console.error("[getTrackRecord] error:", err);
    return empty;
  }
});

// Per-team performance leaderboard: actual W-L from games + model accuracy per
// team. Windowed to TRACK_RECORD_START like the Track Record page — games
// before the reset belong to the old-model era and would misstate how the
// current models do against each club.
export const getTeamLeaderboard = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { runPipelineIfDue } = await import("./mlb-pipeline.server");
    await runPipelineIfDue().catch((err) =>
      console.error("[getTeamLeaderboard] runPipelineIfDue failed:", err),
    );
    const { supabase } = await import("@/integrations/supabase/client");

    const { data: games } = await supabase
      .from("games")
      .select(
        "game_id, home_team_id, home_team_name, home_team_abbr, away_team_id, away_team_name, away_team_abbr, winner, home_score, away_score, status, predictions(home_win_prob, correct, model_version)",
      )
      .gte("game_date", TRACK_RECORD_START)
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

    return { teams, modelVersion: MODEL_VERSION_SIM, trackingSince: TRACK_RECORD_START };
  } catch (err) {
    console.error("[getTeamLeaderboard] Supabase error, returning empty teams:", err);
    return { teams: [], modelVersion: MODEL_VERSION_SIM, trackingSince: TRACK_RECORD_START };
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
