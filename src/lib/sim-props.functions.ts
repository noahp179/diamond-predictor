/**
 * sim-props.functions.ts — the server call behind the simulation prop boards.
 *
 * Returns the date's games, which of them the scheduled jobs have already
 * played (and how many times), and every simulated player's raw chances. The
 * board applies the calibration and ranks in the browser (sim-props-shared),
 * so a game the jobs have not reached yet can be played right there and
 * folded in with exactly the same arithmetic.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { todayET } from "./date";
import type { SimPlayer } from "./sim-props-shared";
import type { SeasonLedgerRow, SimBandRow } from "./sim-props.server";

/** Every priced player at one line and band, summed over the stored games. */
export type PricedRow = { market: string; band: number; n: number; hits: number; said: number };

const League = z.enum(["nba", "nhl", "nfl", "cfb"]);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type SimBoardGame = {
  id: string;
  start: string;
  state: string;
  status: string;
  home: { id: string; abbr: string; name: string };
  away: { id: string; abbr: string; name: string };
  runs: number;
  generatedAt: string | null;
  basis: string | null;
};

export type SimBoardData = {
  date: string;
  games: SimBoardGame[];
  players: (SimPlayer & { gameId: string })[];
  error: string | null;
};

export const getSimPropsBoard = createServerFn({ method: "GET" })
  .inputValidator(z.object({ league: League, date: Day.optional() }))
  .handler(async ({ data }): Promise<SimBoardData> => {
    const date = data.date ?? todayET();
    const { buildSlate } = await import("./sim/build.server");
    const { readSimGames } = await import("./sim-props.server");
    try {
      const [slate, rows] = await Promise.all([
        buildSlate(data.league, date),
        readSimGames(data.league, date).catch(() => []),
      ]);
      const byId = new Map(rows.map((r) => [r.event_id, r]));
      const games: SimBoardGame[] = slate
        // The boards are regular-season (and playoff) boards.
        .filter((g) => !g.preseason)
        .map((g) => {
          const r = byId.get(g.id);
          return {
            id: g.id,
            start: g.date,
            state: g.state,
            status: g.status,
            home: { id: g.home.id, abbr: g.home.abbr, name: g.home.name },
            away: { id: g.away.id, abbr: g.away.abbr, name: g.away.name },
            runs: r?.runs ?? 0,
            generatedAt: r?.generated_at ?? null,
            basis: r?.basis ?? null,
          };
        })
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      const players = rows
        .filter((r) => games.some((g) => g.id === r.event_id))
        .flatMap((r) => r.players.map((p) => ({ ...p, gameId: r.event_id })));
      return { date, games, players, error: null };
    } catch (err) {
      console.error(`[sim-props] board ${data.league} ${date}:`, err);
      return {
        date,
        games: [],
        players: [],
        error: "ESPN's feed is unreachable right now. Try again in a moment.",
      };
    }
  });

/** The live record behind a league's Analytics board: every simulation pick,
 *  counted per market, confidence band and card rank. */
export const getSimAnalytics = createServerFn({ method: "GET" })
  .inputValidator(z.object({ league: League }))
  .handler(
    async ({
      data,
    }): Promise<{
      rows: SimBandRow[];
      note: string | null;
      season: SeasonLedgerRow[];
      priced: PricedRow[];
    }> => {
      const { readSimBands, readSeasonLedger, readPricedBands } =
        await import("./sim-props.server");
      try {
        const [bands, season, priced] = await Promise.all([
          readSimBands(data.league),
          readSeasonLedger(data.league).catch(() => []),
          readPricedBands(data.league).catch(() => []),
        ]);
        return { ...bands, season, priced };
      } catch (err) {
        console.error(`[sim-props] analytics ${data.league}:`, err);
        return {
          rows: [],
          note: "The live record could not be read just now.",
          season: [],
          priced: [],
        };
      }
    },
  );

/** Tracked games, newest first: what happened next to what the board said. */
export const getSimResults = createServerFn({ method: "GET" })
  .inputValidator(z.object({ league: League, offset: z.number().int().min(0).default(0) }))
  .handler(async ({ data }) => {
    const { readGameResults } = await import("./sim-props.server");
    try {
      return await readGameResults(data.league, data.offset);
    } catch (err) {
      console.error(`[sim-props] results ${data.league}:`, err);
      return {
        games: [] as import("./sim-props.server").ResultGame[],
        more: false,
        note: "The game results could not be read just now.",
      };
    }
  });
