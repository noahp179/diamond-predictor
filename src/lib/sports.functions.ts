import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { predictSlate, seasonOf, type Sport } from "./espn.server";

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
