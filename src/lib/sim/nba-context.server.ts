/**
 * nba-context.server.ts — the live NBA game's `ctx.nba`: what the two teams'
 * recent box scores and play-by-play say (each player's recent minutes,
 * starts, rates and rebound split, a return from absence, the defenses' shot
 * zones) and the schedule (rest, travel, altitude). The props backtest builds
 * the same object from stored box scores (scripts/props-backtest.ts), through
 * the same functions in nba-extras.ts.
 */
import { nbaDefZones, nbaPlayerExtras, nbaSideExtra } from "./nba-extras";
import { NBA_GEO } from "./nba-geo";
import { nbaRecentGames } from "./nba-recent.server";
import type { NbaGameExtra } from "./types";

/** Recent games read per team: the minutes window and the zone window. */
const READ = 10;

export async function nbaContext(
  home: { id: string; abbr: string; players: string[] },
  away: { id: string; abbr: string; players: string[] },
  date: string,
): Promise<NbaGameExtra> {
  const [hg, ag] = await Promise.all([
    nbaRecentGames(home.id, date, READ).catch(() => []),
    nbaRecentGames(away.id, date, READ).catch(() => []),
  ]);
  const out: NbaGameExtra = {
    players: { ...nbaPlayerExtras(hg, home.players), ...nbaPlayerExtras(ag, away.players) },
    home: nbaSideExtra(hg, date, home.abbr),
    away: nbaSideExtra(ag, date, home.abbr),
    altitude: Boolean(NBA_GEO[home.abbr]?.alt),
  };
  const hd = nbaDefZones(hg);
  const ad = nbaDefZones(ag);
  if (hd && out.home) out.home.def = hd;
  if (ad && out.away) out.away.def = ad;
  return out;
}
