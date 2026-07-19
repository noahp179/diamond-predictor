import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  bestOddsSlate,
  predictSlate,
  recommendedSlate,
  seasonOf,
  trackRecord,
  type Sport,
} from "./espn.server";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function seasonLabel(sport: Sport, season: number): string {
  return sport === "nba" ? `${season - 1}-${String(season % 100).padStart(2, "0")}` : `${season}`;
}

/** When the given date is in the offseason gap, a short human note about when
 *  the sport returns; null in-season. */
function offseasonNote(sport: Sport, date: string): string | null {
  if (seasonOf(sport, date) !== null) return null;
  return sport === "nba"
    ? "NBA is between seasons — the regular season tips off in late October. Power ratings below carry over from last season; the daily slate returns then."
    : "The NFL is between seasons — Week 1 kicks off in early September. Power ratings below carry over from last season; the daily slate returns then.";
}

async function buildSlate(sport: Sport, date: string) {
  try {
    const { games, season, gamesReplayed, power } = await predictSlate(sport, date);
    return {
      date,
      games,
      power,
      season,
      seasonLabel: seasonLabel(sport, season),
      gamesReplayed,
      note: offseasonNote(sport, date),
      source: "live" as const,
    };
  } catch (err) {
    console.error(`[${sport}Slate] failed:`, err);
    return {
      date,
      games: [],
      power: [],
      season: 0,
      seasonLabel: "",
      gamesReplayed: 0,
      note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
      source: "error" as const,
    };
  }
}

export const getNbaSlate = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildSlate("nba", data?.date ?? todayISO()));

export const getNflSlate = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildSlate("nfl", data?.date ?? todayISO()));

// ---------------------------------------------------------------- Recommended

async function buildRecommended(sport: Sport, date: string) {
  try {
    const { games, picks, season } = await recommendedSlate(sport, date);
    return {
      date,
      games,
      picks,
      season,
      seasonLabel: seasonLabel(sport, season),
      note: offseasonNote(sport, date),
      source: "live" as const,
    };
  } catch (err) {
    console.error(`[${sport}Recommended] failed:`, err);
    return {
      date,
      games: [],
      picks: [],
      season: 0,
      seasonLabel: "",
      note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
      source: "error" as const,
    };
  }
}

export const getNbaRecommended = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildRecommended("nba", data?.date ?? todayISO()));

export const getNflRecommended = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildRecommended("nfl", data?.date ?? todayISO()));

// ------------------------------------------------------------------ Best Odds

async function buildBestOdds(sport: Sport, date: string) {
  try {
    const { rows, marketPicks, blendPicks, season, priced, blendWeight } = await bestOddsSlate(
      sport,
      date,
    );
    return {
      date,
      rows,
      marketPicks,
      blendPicks,
      priced,
      blendWeight,
      season,
      seasonLabel: seasonLabel(sport, season),
      note: offseasonNote(sport, date),
      source: "live" as const,
    };
  } catch (err) {
    console.error(`[${sport}BestOdds] failed:`, err);
    return {
      date,
      rows: [],
      marketPicks: [],
      blendPicks: [],
      priced: 0,
      blendWeight: 0,
      season: 0,
      seasonLabel: "",
      note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
      source: "error" as const,
    };
  }
}

export const getNbaBestOdds = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildBestOdds("nba", data?.date ?? todayISO()));

export const getNflBestOdds = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildBestOdds("nfl", data?.date ?? todayISO()));

// --------------------------------------------------------------- Track Record

async function buildTrackRecord(sport: Sport) {
  const today = todayISO();
  try {
    const tr = await trackRecord(sport, today);
    return { ...tr, source: "live" as const, note: null as string | null };
  } catch (err) {
    console.error(`[${sport}TrackRecord] failed:`, err);
    return {
      overall: { season: 0, seasonLabel: "All", n: 0, accuracy: 0, brier: 0, logLoss: 0 },
      perSeason: [],
      recent: [],
      running: [],
      seasonLabels: [],
      source: "error" as const,
      note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
    };
  }
}

export const getNbaTrackRecord = createServerFn({ method: "GET" }).handler(async () =>
  buildTrackRecord("nba"),
);

export const getNflTrackRecord = createServerFn({ method: "GET" }).handler(async () =>
  buildTrackRecord("nfl"),
);
