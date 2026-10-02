/**
 * sim.functions.ts — the simulator's three server calls.
 *
 * The server only gathers and shapes data; every game is played in the
 * browser. That keeps a ten-thousand-game batch off the server entirely and
 * means the page can re-run a what-if (bench a star, start the backup) without
 * a round trip.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { todayET } from "../date";
import { buildMatchup, buildSlate, listTeams } from "./build.server";
import { nextGameDay } from "./espn-stats.server";

const League = z.enum(["nfl", "nba", "nhl", "mlb"]);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reason = (err: unknown) =>
  err instanceof Error && /ESPN \d+/.test(err.message)
    ? "ESPN's feed returned an error. Try again in a moment."
    : "ESPN's feed is unreachable right now. Try again in a moment.";

export const getSimSlate = createServerFn({ method: "GET" })
  .inputValidator(z.object({ league: League, date: Day.optional() }))
  .handler(async ({ data }) => {
    const date = data.date ?? todayET();
    try {
      const games = await buildSlate(data.league, date);
      // Nothing today: say when the next games are.
      const next = games.length ? null : await nextGameDay(data.league, date).catch(() => null);
      return { date, games, next, error: null as string | null };
    } catch (err) {
      console.error(`[sim] slate ${data.league} ${date}:`, err);
      return { date, games: [], next: null as string | null, error: reason(err) };
    }
  });

export const getSimTeams = createServerFn({ method: "GET" })
  .inputValidator(z.object({ league: League }))
  .handler(async ({ data }) => {
    try {
      return { teams: await listTeams(data.league), error: null as string | null };
    } catch (err) {
      console.error(`[sim] teams ${data.league}:`, err);
      return { teams: [], error: reason(err) };
    }
  });

export const getSimMatchup = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      league: League,
      homeId: z.string().min(1).max(12),
      awayId: z.string().min(1).max(12),
      date: Day.optional(),
      gameId: z.string().max(20).nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    if (data.homeId === data.awayId) throw new Error("Pick two different teams.");
    try {
      return await buildMatchup({
        league: data.league,
        homeId: data.homeId,
        awayId: data.awayId,
        date: data.date ?? todayET(),
        gameId: data.gameId ?? null,
      });
    } catch (err) {
      console.error(`[sim] matchup ${data.league} ${data.awayId}@${data.homeId}:`, err);
      throw new Error(reason(err));
    }
  });
