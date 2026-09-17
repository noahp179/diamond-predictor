import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { todayET } from "./date";
import { bestOddsSlate, predictSlate, recommendedSlate, seasonOf, type Sport } from "./espn.server";
import type { ParlayCandidate } from "./td-parlay";

function seasonLabel(sport: Sport, season: number): string {
  return sport === "nba" ? `${season - 1}-${String(season % 100).padStart(2, "0")}` : `${season}`;
}

/** When the given date is in the offseason gap, a short human note about when
 *  the sport returns; null in-season. */
function offseasonNote(sport: Sport, date: string): string | null {
  if (seasonOf(sport, date) !== null) return null;
  if (sport === "nba")
    return "NBA is between seasons — the regular season tips off in late October. Power ratings below carry over from last season; the daily slate returns then.";
  if (sport === "cfb")
    return "College football is between seasons — Week 1 kicks off in late August. Power ratings below carry over from last season; the slate returns then.";
  return "The NFL is between seasons — Week 1 kicks off in early September. Power ratings below carry over from last season; the daily slate returns then.";
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
  .handler(async ({ data }) => buildSlate("nba", data?.date ?? todayET()));

export const getNflSlate = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildSlate("nfl", data?.date ?? todayET()));

export const getCfbSlate = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildSlate("cfb", data?.date ?? todayET()));

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
  .handler(async ({ data }) => buildRecommended("nba", data?.date ?? todayET()));

export const getNflRecommended = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildRecommended("nfl", data?.date ?? todayET()));

export const getCfbRecommended = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildRecommended("cfb", data?.date ?? todayET()));

// ------------------------------------------------------------------ Best Odds

async function buildBestOdds(sport: Sport, date: string) {
  try {
    const { rows, confidencePicks, marketPicks, blendPicks, season, priced, blendWeight } =
      await bestOddsSlate(sport, date);
    return {
      date,
      rows,
      confidencePicks,
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
      confidencePicks: [],
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
  .handler(async ({ data }) => buildBestOdds("nba", data?.date ?? todayET()));

export const getNflBestOdds = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildBestOdds("nfl", data?.date ?? todayET()));

export const getCfbBestOdds = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => buildBestOdds("cfb", data?.date ?? todayET()));

// --------------------------------------------------------------- Track Record

/**
 * The NFL and NBA Track Record used to be served from here, by replaying the
 * last three seasons and scoring them afterwards. That is a backtest, and
 * presenting it on a page called Track Record was the problem it looked like a
 * solution to. Both pages now read the forward ledger in tracking.server.ts —
 * rows written the morning of a game and scored once it finished — via
 * getTrackLedger, so there is nothing left to build here.
 */

// -------------------------------------------------------------- MLB Props

export const getMlbProps = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayET();
    try {
      const { propsSlate } = await import("./mlb-props.server");
      const { season, games, markets } = await propsSlate(date);
      return {
        date,
        games,
        markets,
        season,
        seasonLabel: season ? `${season}` : "",
        note: null as string | null,
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[mlbProps] failed:`, err);
      return {
        date,
        games: [],
        markets: [],
        season: 0,
        seasonLabel: "",
        note: "MLB Stats API is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

// --------------------------------------------------------------- MLB Stacks

export const getMlbStacks = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayET();
    try {
      const { stacksSlate } = await import("./mlb-stacks.server");
      const { season, teams, backtest } = await stacksSlate(date);
      return {
        date,
        teams,
        backtest,
        season,
        seasonLabel: season ? `${season}` : "",
        note: null as string | null,
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[mlbStacks] failed:`, err);
      return {
        date,
        teams: [] as Awaited<ReturnType<typeof import("./mlb-stacks.server").stacksSlate>>["teams"],
        backtest: null,
        season: 0,
        seasonLabel: "",
        note: "MLB Stats API is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

// ------------------------------------------------------------- MLB 2+ Bases

export const getMlbTwoBases = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayET();
    try {
      const { twoBaseSlate } = await import("./mlb-tb2.server");
      const slate = await twoBaseSlate(date);
      return {
        ...slate,
        seasonLabel: slate.season ? `${slate.season}` : "",
        note: null as string | null,
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[mlbTwoBases] failed:`, err);
      return {
        date,
        season: 0,
        picks: [] as Awaited<ReturnType<typeof import("./mlb-tb2.server").twoBaseSlate>>["picks"],
        byGame: [] as Awaited<ReturnType<typeof import("./mlb-tb2.server").twoBaseSlate>>["byGame"],
        lineupsPosted: 0,
        games: 0,
        model: null,
        seasonLabel: "",
        note: "MLB Stats API is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

// --------------------------------------------------------------- TD Scorers

/**
 * College touchdown picks.
 *
 * Unlike the NFL board this one chooses how many picks a game gets — one, or
 * two when the second clears the bar the backtest set. See cfb-td.server.ts.
 */
export const getCfbTdScorers = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayET();
    try {
      const { cfbTdSlate, CFB_TD_BACKTEST } = await import("./cfb-td.server");
      const { season, games, staleFeatures } = await cfbTdSlate(date);
      return {
        date,
        games,
        season: season ?? 0,
        seasonLabel: season ? `${season}` : "",
        staleFeatures,
        backtest: CFB_TD_BACKTEST,
        note: offseasonNote("cfb", date),
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[cfbTdScorers] failed:`, err);
      return {
        date,
        games: [] as Awaited<ReturnType<typeof import("./cfb-td.server").cfbTdSlate>>["games"],
        season: 0,
        seasonLabel: "",
        staleFeatures: false,
        backtest: null,
        note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

export const getNflTdScorers = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const date = data?.date ?? todayET();
    try {
      const { tdScorersSlate } = await import("./nfl-td.server");
      const { season, games } = await tdScorersSlate(date);
      return {
        date,
        games,
        season,
        seasonLabel: season ? `${season}` : "",
        note: offseasonNote("nfl", date),
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[nflTdScorers] failed:`, err);
      return {
        date,
        games: [],
        season: 0,
        seasonLabel: "",
        note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

// -------------------------------------------------------------- TD parlays

/**
 * Touchdown slips of 5, 10, 15 and 20 legs, for either football.
 *
 * Legs are drawn from the picks the board already shows, not from a separate
 * search — so every leg is a name a reader can find on the card above, with the
 * same probability and the same reasoning.
 *
 * `maxPerGame` is the reader's choice. One leg per game needs no correlation
 * correction; anything higher is priced rather than refused — see td-parlay.ts.
 * Zero means unrestricted, because Infinity does not survive JSON.
 */
export const getTdParlays = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      sport: z.enum(["cfb", "nfl"]),
      date: z.string().optional(),
      maxPerGame: z.number().int().min(0).max(10).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const date = data.date ?? todayET();
    const sport = data.sport;
    const maxPerGame = data.maxPerGame === 0 ? Infinity : (data.maxPerGame ?? undefined);
    try {
      const { buildTdParlays, PARLAY_SIZES, SIZE_EVIDENCE } = await import("./td-parlay");
      const candidates: ParlayCandidate[] = [];
      let games = 0;
      if (sport === "cfb") {
        const { cfbTdSlate } = await import("./cfb-td.server");
        const slate = await cfbTdSlate(date);
        games = slate.games.length;
        for (const g of slate.games) {
          if (g.started) continue;
          for (const p of g.picks)
            candidates.push({
              playerId: p.playerId,
              player: p.player,
              position: p.position,
              team: p.team,
              gameId: g.gameId,
              matchup: g.matchup,
              prob: p.prob,
              tier: p.tier,
              tierHit: p.tierHit,
              reasons: p.reasons,
              against: p.against,
            });
        }
      } else {
        const { tdScorersSlate } = await import("./nfl-td.server");
        const slate = await tdScorersSlate(date);
        games = slate.games.length;
        for (const g of slate.games) {
          if (g.started) continue;
          for (const p of g.picks.slice(0, 3))
            candidates.push({
              playerId: p.playerId,
              player: p.player,
              position: null,
              team: p.team,
              gameId: g.gameId,
              matchup: g.matchup,
              prob: p.prob,
              tier: null,
              tierHit: null,
              reasons: p.reasons,
              against: p.against,
            });
        }
      }
      return {
        date,
        sport,
        games,
        candidates: candidates.length,
        maxPerGame: Number.isFinite(maxPerGame ?? NaN) ? (maxPerGame as number) : 0,
        parlays: buildTdParlays(candidates, PARLAY_SIZES, maxPerGame),
        evidence: SIZE_EVIDENCE[sport] ?? {},
        note: offseasonNote(sport, date),
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[tdParlays] ${sport} ${date} failed:`, err);
      const { PARLAY_SIZES, SIZE_EVIDENCE } = await import("./td-parlay");
      return {
        date,
        sport,
        games: 0,
        candidates: 0,
        parlays: [] as Awaited<ReturnType<typeof import("./td-parlay").buildTdParlays>>,
        evidence: SIZE_EVIDENCE[sport] ?? {},
        sizes: PARLAY_SIZES,
        note: "The ESPN scoreboard is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });
