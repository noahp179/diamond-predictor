/**
 * espn.server.ts — live NBA/NFL slate + a self-contained margin-of-victory Elo,
 * the engine the research expedition validated (see NBA-NFL-ANALYSIS.md). Server
 * only: it reads the public ESPN scoreboard API and never touches Supabase.
 *
 * Two responsibilities:
 *   1. `fetchScoreboard` — normalize one day's games for display.
 *   2. `computeRatingsAsOf` — replay the season(s) up to a date to get current
 *      Elo ratings, then `predictSlate` turns them into win probabilities.
 *
 * Season finals are cached per (sport, season) at module scope so a full replay
 * costs one cold fetch pass and is instant afterward; the in-progress season is
 * cached with a short TTL so new results flow in.
 */

import type { PredictedGame, TeamSide } from "./mlb-core";

export type Sport = "nba" | "nfl";

const ESPN_PATH: Record<Sport, string> = {
  nba: "basketball/nba",
  nfl: "football/nfl",
};

// Margin-of-victory Elo, frozen from the dev-tuned research configuration.
// NBA and NFL differ only in K, home-field points, and season carry.
const ELO: Record<Sport, { k: number; hfa: number; carry: number }> = {
  nba: { k: 8, hfa: 80, carry: 0.75 },
  nfl: { k: 20, hfa: 55, carry: 0.5 },
};
const ELO_MEAN = 1505;
const ELO_INIT = 1300;

// How many completed seasons to replay before the target season so ratings
// enter it warm. Two is plenty with between-season carry (the research warmed
// from decades, but ratings stabilize within a season or two of carry).
const WARMUP_SEASONS = 2;

// ------------------------------------------------------------------- fetch

type EspnCompetitor = {
  homeAway: "home" | "away";
  team: {
    id: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
    location?: string;
    name?: string;
  };
  score?: string;
  winner?: boolean;
  records?: { type: string; summary: string }[];
};

type EspnEvent = {
  id: string;
  date: string;
  status: { type: { name: string; state: string; shortDetail?: string; completed?: boolean } };
  competitions: {
    neutralSite?: boolean;
    venue?: { fullName?: string };
    competitors: EspnCompetitor[];
  }[];
};

async function espnFetch(sport: Sport, dates: string): Promise<EspnEvent[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/scoreboard?dates=${dates}&limit=1000`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ESPN ${sport} ${dates}: ${res.status}`);
  const json = (await res.json()) as { events?: EspnEvent[] };
  return json.events ?? [];
}

// Team id → display metadata, for the power ranking (finals carry ids only).
const teamsCache = new Map<
  Sport,
  { at: number; teams: Map<string, { abbr: string; name: string }> }
>();
const TEAMS_TTL = 24 * 60 * 60 * 1000;

async function fetchTeams(sport: Sport): Promise<Map<string, { abbr: string; name: string }>> {
  const cached = teamsCache.get(sport);
  if (cached && Date.now() - cached.at < TEAMS_TTL) return cached.teams;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/teams?limit=100`;
  const map = new Map<string, { abbr: string; name: string }>();
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const json = (await res.json()) as {
      sports?: {
        leagues?: {
          teams?: {
            team: {
              id: string;
              abbreviation?: string;
              shortDisplayName?: string;
              displayName?: string;
            };
          }[];
        }[];
      }[];
    };
    for (const t of json.sports?.[0]?.leagues?.[0]?.teams ?? []) {
      const team = t.team;
      map.set(team.id, {
        abbr: team.abbreviation ?? team.shortDisplayName ?? "?",
        name: team.shortDisplayName ?? team.displayName ?? "?",
      });
    }
  } catch (err) {
    console.error(`[fetchTeams] ${sport}:`, err);
  }
  teamsCache.set(sport, { at: Date.now(), teams: map });
  return map;
}

// -------------------------------------------------------------- normalized

/** A completed game used for the Elo replay. */
type Final = {
  date: string; // YYYY-MM-DD
  home: string; // team id
  away: string;
  hs: number;
  as: number;
  neutral: boolean;
};

/** One scheduled/played game for display + prediction. */
export type SlateGame = {
  id: number;
  date: string; // ISO
  status: string;
  completed: boolean;
  venue: string;
  neutral: boolean;
  home: EspnTeam;
  away: EspnTeam;
  homeScore: number | null;
  awayScore: number | null;
  winner: "home" | "away" | null;
};

type EspnTeam = {
  id: string;
  abbr: string;
  name: string;
  record: string;
  winPct: number;
};

function parseTeam(c: EspnCompetitor): EspnTeam {
  const overall = c.records?.find((r) => r.type === "total")?.summary ?? "";
  const [w, l] = overall.split("-").map((n) => Number(n));
  const winPct = Number.isFinite(w) && Number.isFinite(l) && w + l > 0 ? w / (w + l) : 0;
  return {
    id: c.team.id,
    abbr: c.team.abbreviation ?? c.team.shortDisplayName ?? "?",
    name: c.team.shortDisplayName ?? c.team.name ?? c.team.location ?? c.team.displayName ?? "?",
    record: overall,
    winPct,
  };
}

function toSlateGame(ev: EspnEvent): SlateGame | null {
  const comp = ev.competitions[0];
  if (!comp) return null;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return null;
  const hs = home.score != null && home.score !== "" ? Number(home.score) : null;
  const as = away.score != null && away.score !== "" ? Number(away.score) : null;
  const completed = ev.status.type.completed === true || ev.status.type.state === "post";
  let winner: "home" | "away" | null = null;
  if (completed && hs != null && as != null && hs !== as) winner = hs > as ? "home" : "away";
  return {
    id: Number(ev.id),
    date: ev.date,
    status: ev.status.type.shortDetail ?? ev.status.type.name,
    completed,
    venue: comp.venue?.fullName ?? (comp.neutralSite ? "Neutral site" : ""),
    neutral: comp.neutralSite === true,
    home: parseTeam(home),
    away: parseTeam(away),
    homeScore: hs,
    awayScore: as,
    winner,
  };
}

// -------------------------------------------------------------- season code

/** ESPN season year: NBA uses the season-END year (2025-26 → 2026); NFL uses
 *  the START year (2025 season → 2025). Returns the season a date belongs to,
 *  or null in the offseason gap. */
export function seasonOf(sport: Sport, date: string): number | null {
  const [y, m] = date.split("-").map(Number);
  if (sport === "nba") {
    if (m >= 10) return y + 1; // Oct–Dec → next-year season
    if (m <= 6) return y; // Jan–Jun → this-year season
    return null; // Jul–Sep offseason
  } else {
    if (m >= 9) return y; // Sep–Dec
    if (m <= 2) return y - 1; // Jan–Feb → previous start-year season
    return null; // Mar–Aug offseason
  }
}

/** The season a date is closest to for rating purposes (offseason → the
 *  upcoming season, so power ratings still resolve). */
function ratingSeason(sport: Sport, date: string): number {
  const s = seasonOf(sport, date);
  if (s !== null) return s;
  const [y, m] = date.split("-").map(Number);
  if (sport === "nba") return y + 1; // Jul–Sep → upcoming end-year season
  return y; // NFL Mar–Aug → upcoming season (start year)
}

/** The calendar months (YYYYMM) a season spans, in order. */
function seasonMonths(sport: Sport, season: number): string[] {
  const mm = (y: number, m: number) => `${y}${String(m).padStart(2, "0")}`;
  if (sport === "nba")
    return [10, 11, 12]
      .map((m) => mm(season - 1, m))
      .concat([1, 2, 3, 4, 5, 6].map((m) => mm(season, m)));
  return [9, 10, 11, 12].map((m) => mm(season, m)).concat([1, 2].map((m) => mm(season + 1, m)));
}

// ---------------------------------------------------------------- caching

type CacheEntry = { at: number; finals: Final[] };
const finalsCache = new Map<string, CacheEntry>();
const CURRENT_TTL = 20 * 60 * 1000; // in-progress season refreshes every 20 min

function isCompleteSeason(sport: Sport, season: number): boolean {
  // A season is "complete" (immutable, cache forever) once we are well past its
  // end month: NBA ends ~June(season), NFL ends ~Feb(season+1).
  const now = new Date();
  const endYear = sport === "nba" ? season : season + 1;
  const endMonth = sport === "nba" ? 7 : 3; // month strictly after the finals
  const cutoff = new Date(Date.UTC(endYear, endMonth - 1, 1));
  return now >= cutoff;
}

async function fetchSeasonFinals(sport: Sport, season: number): Promise<Final[]> {
  const key = `${sport}:${season}`;
  const cached = finalsCache.get(key);
  const complete = isCompleteSeason(sport, season);
  if (cached && (complete || Date.now() - cached.at < CURRENT_TTL)) return cached.finals;

  const finals: Final[] = [];
  const seen = new Set<number>();
  for (const month of seasonMonths(sport, season)) {
    let events: EspnEvent[];
    try {
      events = await espnFetch(sport, month);
    } catch {
      continue; // a single month failing shouldn't sink the replay
    }
    for (const ev of events) {
      const g = toSlateGame(ev);
      if (!g || !g.completed || g.homeScore == null || g.awayScore == null) continue;
      if (g.homeScore === g.awayScore) continue; // ties don't move Elo meaningfully here
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      finals.push({
        date: g.date.slice(0, 10),
        home: g.home.id,
        away: g.away.id,
        hs: g.homeScore,
        as: g.awayScore,
        neutral: g.neutral,
      });
    }
  }
  finals.sort((a, b) => a.date.localeCompare(b.date));
  finalsCache.set(key, { at: Date.now(), finals });
  return finals;
}

// -------------------------------------------------------------------- Elo

class Elo {
  private r = new Map<string, number>();
  constructor(private cfg: { k: number; hfa: number; carry: number }) {}

  rating(t: string) {
    return this.r.get(t) ?? ELO_INIT;
  }

  entries() {
    return [...this.r.entries()];
  }

  carrySeason() {
    for (const [t, v] of this.r) this.r.set(t, ELO_MEAN + this.cfg.carry * (v - ELO_MEAN));
  }

  prob(home: string, away: string, neutral: boolean) {
    const diff = this.rating(home) - this.rating(away) + (neutral ? 0 : this.cfg.hfa);
    return 1 / (1 + Math.pow(10, -diff / 400));
  }

  update(home: string, away: string, hs: number, as: number, neutral: boolean) {
    const p = this.prob(home, away, neutral);
    const result = hs > as ? 1 : 0;
    const diff = this.rating(home) - this.rating(away) + (neutral ? 0 : this.cfg.hfa);
    const winnerDiff = (result === 1 ? 1 : -1) * diff;
    let mult = Math.log(Math.abs(hs - as) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    if (!Number.isFinite(mult) || mult < 0) mult = 1;
    const delta = this.cfg.k * mult * (result - p);
    this.r.set(home, this.rating(home) + delta);
    this.r.set(away, this.rating(away) - delta);
  }
}

/** Replay warmup seasons + the target season up to (but not including) `date`. */
async function computeRatingsAsOf(
  sport: Sport,
  date: string,
): Promise<{ elo: Elo; season: number; gamesReplayed: number }> {
  const season = ratingSeason(sport, date);
  const elo = new Elo(ELO[sport]);
  let replayed = 0;
  const firstSeason = season - WARMUP_SEASONS;
  for (let s = firstSeason; s <= season; s++) {
    if (s > firstSeason) elo.carrySeason(); // between-season regression before each new season
    const finals = await fetchSeasonFinals(sport, s);
    for (const g of finals) {
      if (s === season && g.date >= date) break; // strictly point-in-time within the target season
      elo.update(g.home, g.away, g.hs, g.as, g.neutral);
      replayed++;
    }
  }
  return { elo, season, gamesReplayed: replayed };
}

// ------------------------------------------------------------ public surface

const SPORT_LABEL: Record<Sport, string> = { nba: "NBA", nfl: "NFL" };

/** Fetch and normalize one day's games (schedule + any finals). */
export async function fetchScoreboard(sport: Sport, date: string): Promise<SlateGame[]> {
  const events = await espnFetch(sport, date.replace(/-/g, ""));
  return events
    .map(toSlateGame)
    .filter((g): g is SlateGame => g !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type PowerRow = { rank: number; abbr: string; name: string; elo: number };

/** Build PredictedGame cards for a date: fetch the slate, replay Elo, predict.
 *  Also returns a full Elo power ranking (useful in the offseason gap). */
export async function predictSlate(
  sport: Sport,
  date: string,
): Promise<{ games: PredictedGame[]; season: number; gamesReplayed: number; power: PowerRow[] }> {
  const [slate, ratings, teams] = await Promise.all([
    fetchScoreboard(sport, date),
    computeRatingsAsOf(sport, date),
    fetchTeams(sport),
  ]);
  const { elo, season, gamesReplayed } = ratings;

  const power: PowerRow[] = elo
    .entries()
    .map(([id, r]) => ({ id, elo: Math.round(r) }))
    .filter((t) => teams.has(t.id))
    .sort((a, b) => b.elo - a.elo)
    .map((t, i) => {
      const meta = teams.get(t.id)!;
      return { rank: i + 1, abbr: meta.abbr, name: meta.name, elo: t.elo };
    });

  const games = slate.map((g): PredictedGame => {
    const homeWinProb = elo.prob(g.home.id, g.away.id, g.neutral);
    const awayWinProb = 1 - homeWinProb;
    const correct = g.winner != null ? (homeWinProb >= 0.5 ? "home" : "away") === g.winner : null;
    const eloH = Math.round(elo.rating(g.home.id));
    const eloA = Math.round(elo.rating(g.away.id));
    return {
      gameId: g.id,
      date: g.date,
      status: g.status,
      venue: g.venue,
      home: toTeamSide(g.home, eloH),
      away: toTeamSide(g.away, eloA),
      homeWinProb,
      awayWinProb,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      winner: g.winner,
      correct,
      rationale: [
        `${SPORT_LABEL[sport]} margin-of-victory Elo, replayed point-in-time (${gamesReplayed.toLocaleString()} games through ${date}).`,
        `Elo ${g.home.abbr} ${eloH} vs ${g.away.abbr} ${eloA}${g.neutral ? " · neutral site" : ` · +${ELO[sport].hfa} home edge`}.`,
        `Win probability from the 400-point Elo logistic; no injuries, rest, or market inputs.`,
      ],
    };
  });

  return { games, season, gamesReplayed, power };
}

function toTeamSide(t: EspnTeam, elo: number): TeamSide {
  return {
    id: Number(t.id),
    name: t.name,
    abbreviation: t.abbr,
    record: t.record || "0-0",
    winPct: t.winPct,
    pitcher: null,
    // stash the Elo on the pitcher-less side via a synthetic field is avoided;
    // the rating is surfaced in the rationale instead.
  };
}
