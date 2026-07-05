// mlb-odds.server.ts
// Real market moneylines from ESPN's public (free, keyless) scoreboard/summary
// endpoints. Verified to return live pre-game odds AND historical odds for
// completed games (same code path serves the live Best Odds page and the
// historical backfill). Unofficial API — if ESPN changes it, every call here
// degrades to `null` rather than throwing, so callers always have a fallback.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const TIMEOUT_MS = 10_000;

async function fetchJson(url: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface EspnEvent {
  id: string;
  homeName: string;
  awayName: string;
  homeAbbr: string;
  awayAbbr: string;
}

/** All ESPN MLB events on `date` (YYYY-MM-DD). */
export async function fetchEspnEventsForDate(date: string): Promise<EspnEvent[]> {
  const compact = date.replaceAll("-", "");
  const json = await fetchJson(`${ESPN_BASE}/scoreboard?dates=${compact}`);
  const events: any[] = json?.events ?? [];
  return events
    .map((e): EspnEvent | null => {
      const comp = e?.competitions?.[0];
      const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
      const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
      if (!home || !away) return null;
      return {
        id: e.id,
        homeName: home.team?.displayName ?? "",
        awayName: away.team?.displayName ?? "",
        homeAbbr: home.team?.abbreviation ?? "",
        awayAbbr: away.team?.abbreviation ?? "",
      };
    })
    .filter((e): e is EspnEvent => e !== null);
}

/**
 * Match our MLB Stats API game to an ESPN event. Full team names are
 * identical between the two sources (verified across a full slate, including
 * relocated/renamed franchises like "Athletics"), so name equality is the
 * primary key; abbreviation is a fallback for the rare mismatch. Returns null
 * rather than guessing when nothing lines up.
 */
export function matchEspnEvent(
  events: EspnEvent[],
  homeName: string,
  awayName: string,
  homeAbbr?: string,
  awayAbbr?: string,
): EspnEvent | null {
  const byName = events.find((e) => e.homeName === homeName && e.awayName === awayName);
  if (byName) return byName;
  if (homeAbbr && awayAbbr) {
    const byAbbr = events.find((e) => e.homeAbbr === homeAbbr && e.awayAbbr === awayAbbr);
    if (byAbbr) return byAbbr;
  }
  return null;
}

export interface Moneyline {
  provider: string;
  homeMoneyLine: number;
  awayMoneyLine: number;
}

/** Odds for a single ESPN event, or null if not yet posted / event has none. */
export async function fetchMoneylineForEvent(eventId: string): Promise<Moneyline | null> {
  const json = await fetchJson(`${ESPN_BASE}/summary?event=${eventId}`);
  const line = json?.pickcenter?.[0];
  const home = line?.homeTeamOdds?.moneyLine;
  const away = line?.awayTeamOdds?.moneyLine;
  if (typeof home !== "number" || typeof away !== "number") return null;
  return {
    provider: (line?.provider?.name ?? "market").toLowerCase(),
    homeMoneyLine: home,
    awayMoneyLine: away,
  };
}

/** American moneyline → raw (vig-inclusive) implied probability. */
export function moneylineToImpliedProb(ml: number): number {
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

export interface DevigOdds {
  homeImpliedProb: number;
  awayImpliedProb: number;
}

/** Remove the sportsbook's vig by normalizing both sides to sum to 1. */
export function devig(homeMoneyLine: number, awayMoneyLine: number): DevigOdds {
  const rawHome = moneylineToImpliedProb(homeMoneyLine);
  const rawAway = moneylineToImpliedProb(awayMoneyLine);
  const total = rawHome + rawAway;
  return { homeImpliedProb: rawHome / total, awayImpliedProb: rawAway / total };
}

export interface GameOddsLookup {
  gameId: number;
  homeName: string;
  awayName: string;
  homeAbbr?: string;
  awayAbbr?: string;
}

export interface FetchedGameOdds extends Moneyline {
  gameId: number;
  homeImpliedProb: number;
  awayImpliedProb: number;
}

/**
 * Fetch odds for every game on `date` in one shot: one scoreboard call, then
 * one summary call per matched event. Games ESPN doesn't have odds for yet
 * (or that fail to match) are simply absent from the result — callers treat
 * that as "not posted yet," not an error.
 */
export async function fetchOddsForDate(
  date: string,
  games: GameOddsLookup[],
): Promise<FetchedGameOdds[]> {
  const events = await fetchEspnEventsForDate(date);
  if (events.length === 0) return [];

  const matches = games
    .map((g) => ({
      game: g,
      event: matchEspnEvent(events, g.homeName, g.awayName, g.homeAbbr, g.awayAbbr),
    }))
    .filter((m): m is { game: GameOddsLookup; event: EspnEvent } => m.event !== null);

  const results = await Promise.all(
    matches.map(async ({ game, event }) => {
      const ml = await fetchMoneylineForEvent(event.id);
      if (!ml) return null;
      const { homeImpliedProb, awayImpliedProb } = devig(ml.homeMoneyLine, ml.awayMoneyLine);
      return { gameId: game.gameId, ...ml, homeImpliedProb, awayImpliedProb };
    }),
  );
  return results.filter((r): r is FetchedGameOdds => r !== null);
}
