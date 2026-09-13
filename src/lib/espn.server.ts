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

import { etDateOf } from "./date";
import type { PredictedGame, TeamSide } from "./mlb-core";

export type Sport = "nba" | "nfl" | "cfb";

const ESPN_PATH: Record<Sport, string> = {
  nba: "basketball/nba",
  nfl: "football/nfl",
  cfb: "football/college-football",
};

/**
 * College football has ~700 teams across every division. `groups=80` is ESPN's
 * code for FBS, and it is what makes the scoreboard a slate rather than a phone
 * book. FBS-hosts-FCS games still come back (the FBS side is in the group),
 * which is right: they are on the slate, so the model has to price them.
 */
const SCOREBOARD_GROUP: Partial<Record<Sport, string>> = { cfb: "80" };

/**
 * Every team that is not FBS shares one rating.
 *
 * About a hundred games a season are an FBS team hosting an FCS one. Those
 * visitors never appear again, so a rating of their own would never be worth
 * anything — and, worse, beating an unrated opponent would hand the FBS team a
 * free rating change off no information. Pooling them means the model learns
 * one honest thing instead: what beating an FCS team is worth.
 */
const FCS_POOL = "__FCS__";

// Margin-of-victory Elo, frozen from the dev-tuned research configuration.
// NBA and NFL differ only in K, home-field points, and season carry.
const ELO: Record<Sport, { k: number; hfa: number; carry: number }> = {
  nba: { k: 8, hfa: 80, carry: 0.75 },
  nfl: { k: 20, hfa: 55, carry: 0.5 },
  // College is its own animal: twelve games instead of seventeen, schedules
  // that never overlap, and a roster that turns over every year. K is double
  // the NFL's because each result has to carry more, and carry is higher than
  // the NFL's because programs — unlike pro rosters — stay good.
  // Grid-searched on 2021-24 and held out on 2025-26: 76.0% accuracy against a
  // 67.4% always-pick-the-home-team baseline. See research/cfb/elo_backtest.py.
  cfb: { k: 40, hfa: 55, carry: 0.6 },
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
    odds?: { overUnder?: number; spread?: number }[];
  }[];
};

/**
 * Page size for the scoreboard.
 *
 * This was 1000, which ESPN does not reject — it quietly ignores the parameter
 * and serves its default page of 25. Harmless for the NFL, where a month has
 * 60 games. Silently fatal for college: a 71-game Saturday came back as 25, and
 * the Elo replay saw 304 games of a season instead of 900, so every rating on
 * the page was wrong and nothing anywhere said so.
 *
 * 500 is honoured, and comfortably above the biggest window anything here asks
 * for (a November of college football is ~293 games). The guard below catches
 * it if that ever stops being true.
 */
const SCOREBOARD_LIMIT = 500;

async function espnFetch(sport: Sport, dates: string): Promise<EspnEvent[]> {
  const group = SCOREBOARD_GROUP[sport] ? `&groups=${SCOREBOARD_GROUP[sport]}` : "";
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/scoreboard?dates=${dates}${group}&limit=${SCOREBOARD_LIMIT}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ESPN ${sport} ${dates}: ${res.status}`);
  const json = (await res.json()) as { events?: EspnEvent[] };
  const events = json.events ?? [];
  // A full page means there may be more behind it, and a truncated replay is
  // wrong in a way that looks exactly like a correct one.
  if (events.length >= SCOREBOARD_LIMIT)
    console.warn(`[espn] ${sport} ${dates}: ${events.length} events hit the page limit`);
  return events;
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
  const group = SCOREBOARD_GROUP[sport] ? `&groups=${SCOREBOARD_GROUP[sport]}` : "";
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/teams?limit=400${group}`;
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
  date: string; // YYYY-MM-DD, US Eastern (the day the league played it)
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
  /** ESPN's own lifecycle for the game: scheduled, in progress, finished. The
   *  authoritative answer to "has this kicked off", which the score is not. */
  state: "pre" | "in" | "post";
  /** Posted total and home spread, when the scoreboard carries them.
   *
   *  These ride along because the scoreboard already has them. Reading a total
   *  from the per-game summary endpoint instead costs a 500KB response per
   *  game — 35MB and half a minute for a college Saturday — to display one
   *  number that is usually absent anyway. ESPN drops the odds block once a
   *  game is final, so both are null for anything already played. */
  total: number | null;
  homeSpread: number | null;
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
  const completed = ev.status.type.completed === true || ev.status.type.state === "post";
  const state: "pre" | "in" | "post" =
    ev.status.type.state === "post" || completed
      ? "post"
      : ev.status.type.state === "in"
        ? "in"
        : "pre";
  // A scheduled game is served with score "0", not an empty string — in every
  // sport. Reading that as a score meant an upcoming game was indistinguishable
  // from a 0-0 one, which rendered "0–0" on every card that had not kicked off
  // and, worse, made the tracking cron's "only record games that have not
  // started" filter (`homeScore == null`) unsatisfiable: it silently recorded
  // nothing, for any sport, for as long as it has existed. Before kickoff there
  // is no score, so there is no number here.
  const parse = (v: string | undefined) =>
    state !== "pre" && v != null && v !== "" ? Number(v) : null;
  const hs = parse(home.score);
  const as = parse(away.score);
  let winner: "home" | "away" | null = null;
  if (completed && hs != null && as != null && hs !== as) winner = hs > as ? "home" : "away";
  const posted = comp.odds?.[0];
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
    state,
    total: typeof posted?.overUnder === "number" ? posted.overUnder : null,
    homeSpread: typeof posted?.spread === "number" ? posted.spread : null,
  };
}

// -------------------------------------------------------------- season code

/** ESPN season year: NBA uses the season-END year (2025-26 → 2026); NFL and
 *  college football use the START year (2025 season → 2025). Returns the season
 *  a date belongs to, or null in the offseason gap. */
export function seasonOf(sport: Sport, date: string): number | null {
  const [y, m] = date.split("-").map(Number);
  if (sport === "nba") {
    if (m >= 10) return y + 1; // Oct–Dec → next-year season
    if (m <= 6) return y; // Jan–Jun → this-year season
    return null; // Jul–Sep offseason
  }
  if (sport === "cfb") {
    // Week 0 is the last weekend of August and the title game is mid-January.
    if (m >= 8) return y; // Aug–Dec
    if (m === 1) return y - 1; // Jan bowls/playoff → previous start-year season
    return null; // Feb–Jul offseason
  }
  if (m >= 9) return y; // Sep–Dec
  if (m <= 2) return y - 1; // Jan–Feb → previous start-year season
  return null; // Mar–Aug offseason
}

/** The season a date is closest to for rating purposes (offseason → the
 *  upcoming season, so power ratings still resolve). */
function ratingSeason(sport: Sport, date: string): number {
  const s = seasonOf(sport, date);
  if (s !== null) return s;
  const [y, m] = date.split("-").map(Number);
  if (sport === "nba") return y + 1; // Jul–Sep → upcoming end-year season
  if (sport === "cfb") return m === 1 ? y - 1 : y; // Feb–Jul → upcoming season
  return m <= 2 ? y - 1 : y; // NFL Mar–Aug → upcoming season (start year)
}

/** The calendar months (YYYYMM) a season spans, in order. */
function seasonMonths(sport: Sport, season: number): string[] {
  const mm = (y: number, m: number) => `${y}${String(m).padStart(2, "0")}`;
  if (sport === "nba")
    return [10, 11, 12]
      .map((m) => mm(season - 1, m))
      .concat([1, 2, 3, 4, 5, 6].map((m) => mm(season, m)));
  if (sport === "cfb")
    return [8, 9, 10, 11, 12].map((m) => mm(season, m)).concat([mm(season + 1, 1)]);
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
  // month strictly after the last game: NBA ~June(season), NFL ~Feb(season+1),
  // college ~Jan(season+1)
  const endMonth = sport === "nba" ? 7 : sport === "cfb" ? 2 : 3;
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
        // ET, not UTC: a Sunday-night game is stamped 00:20Z Monday, and
        // filing it under Monday hides it from Monday's point-in-time replay.
        date: etDateOf(g.date),
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

/**
 * The rating key for a team. Everywhere but college this is just the team id.
 *
 * In college, anyone outside FBS is folded into one pooled opponent — see
 * FCS_POOL. `rated` is the set of teams that have their own rating; it is built
 * from ESPN's FBS team list, and when that list fails to load the map comes
 * back empty and every team gets its own rating, which is the old behaviour and
 * a safe thing to fall back to.
 */
function ratingKey(sport: Sport, teamId: string, rated: Map<string, unknown>): string {
  if (sport !== "cfb" || rated.size === 0) return teamId;
  return rated.has(teamId) ? teamId : FCS_POOL;
}

/** Replay warmup seasons + the target season up to (but not including) `date`. */
async function computeRatingsAsOf(
  sport: Sport,
  date: string,
): Promise<{ elo: Elo; season: number; gamesReplayed: number }> {
  const season = ratingSeason(sport, date);
  const elo = new Elo(ELO[sport]);
  const rated = await fetchTeams(sport);
  let replayed = 0;
  const firstSeason = season - WARMUP_SEASONS;
  for (let s = firstSeason; s <= season; s++) {
    if (s > firstSeason) elo.carrySeason(); // between-season regression before each new season
    const finals = await fetchSeasonFinals(sport, s);
    for (const g of finals) {
      if (s === season && g.date >= date) break; // strictly point-in-time within the target season
      elo.update(
        ratingKey(sport, g.home, rated),
        ratingKey(sport, g.away, rated),
        g.hs,
        g.as,
        g.neutral,
      );
      replayed++;
    }
  }
  return { elo, season, gamesReplayed: replayed };
}

/**
 * Everything a per-player model needs to know about game context, as of a date.
 *
 * The touchdown model wants two things the Elo replay has already paid for: a
 * rating for each side (its read on game shape) and each team's scoring for and
 * against so far (the stand-in for a market total, since ESPN keeps no
 * historical college lines). Both fall out of the same season finals this
 * module already fetches and caches, so exposing them here costs nothing —
 * whereas rebuilding them in the touchdown module would mean fetching the whole
 * season a second time.
 *
 * Strictly point-in-time: only games played before `date` are counted.
 */
export type TeamForm = { gp: number; pointsFor: number; pointsAgainst: number; elo: number };

export async function teamFormAsOf(
  sport: Sport,
  date: string,
): Promise<{ form: Map<string, TeamForm>; season: number; ratingOf: (id: string) => number }> {
  const season = ratingSeason(sport, date);
  const [{ elo }, rated] = await Promise.all([computeRatingsAsOf(sport, date), fetchTeams(sport)]);
  const form = new Map<string, TeamForm>();
  const bump = (id: string, pf: number, pa: number) => {
    const cur = form.get(id) ?? { gp: 0, pointsFor: 0, pointsAgainst: 0, elo: 0 };
    cur.gp += 1;
    cur.pointsFor += pf;
    cur.pointsAgainst += pa;
    form.set(id, cur);
  };
  for (const g of await fetchSeasonFinals(sport, season)) {
    if (g.date >= date) break; // finals are sorted by date
    bump(g.home, g.hs, g.as);
    bump(g.away, g.as, g.hs);
  }
  const ratingOf = (id: string) => elo.rating(ratingKey(sport, id, rated));
  for (const [id, f] of form) f.elo = ratingOf(id);
  return { form, season, ratingOf };
}

/** Home-field advantage in rating points, for callers projecting a margin. */
export function homeEdge(sport: Sport): number {
  return ELO[sport].hfa;
}

// ------------------------------------------------------------ public surface

const SPORT_LABEL: Record<Sport, string> = { nba: "NBA", nfl: "NFL", cfb: "College Football" };

/** Fetch and normalize one day's games (schedule + any finals). */
export async function fetchScoreboard(sport: Sport, date: string): Promise<SlateGame[]> {
  const events = await espnFetch(sport, date.replace(/-/g, ""));
  return events
    .map(toSlateGame)
    .filter((g): g is SlateGame => g !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type PowerRow = { rank: number; abbr: string; name: string; elo: number };

/** How many rows the power ranking shows, where showing all of them is silly. */
const POWER_ROWS: Partial<Record<Sport, number>> = { cfb: 25 };

/** Build PredictedGame cards for a date: fetch the slate, replay Elo, predict.
 *  Also fetches live odds so each game carries a SEPARATE confidence (the
 *  market's read on the model's pick) and returns the odds map (so the Best
 *  Odds page can reuse it) plus a full Elo power ranking. */
export async function predictSlate(
  sport: Sport,
  date: string,
): Promise<{
  games: PredictedGame[];
  season: number;
  gamesReplayed: number;
  power: PowerRow[];
  oddsMap: Map<number, GameOdds>;
}> {
  const [slate, ratings, teams] = await Promise.all([
    fetchScoreboard(sport, date),
    computeRatingsAsOf(sport, date),
    fetchTeams(sport),
  ]);
  const { elo, season, gamesReplayed } = ratings;

  // The pooled FCS rating is filtered out here for free: it is not a real team
  // id, so it is not in `teams`.
  const power: PowerRow[] = elo
    .entries()
    .map(([id, r]) => ({ id, elo: Math.round(r) }))
    .filter((t) => teams.has(t.id))
    .sort((a, b) => b.elo - a.elo)
    .map((t, i) => {
      const meta = teams.get(t.id)!;
      return { rank: i + 1, abbr: meta.abbr, name: meta.name, elo: t.elo };
    })
    // Every FBS team is a list of 130-odd; the sport's own idiom is a Top 25,
    // and nobody scrolls to 97th anyway.
    .slice(0, POWER_ROWS[sport] ?? Infinity);

  // separate confidence: the market's own probability for the model's pick
  const oddsMap = await fetchOddsForEvents(
    sport,
    slate.map((g) => g.id),
  );

  const games = slate.map((g): PredictedGame => {
    const hk = ratingKey(sport, g.home.id, teams);
    const ak = ratingKey(sport, g.away.id, teams);
    const homeWinProb = elo.prob(hk, ak, g.neutral);
    const awayWinProb = 1 - homeWinProb;
    const correct = g.winner != null ? (homeWinProb >= 0.5 ? "home" : "away") === g.winner : null;
    const eloH = Math.round(elo.rating(hk));
    const eloA = Math.round(elo.rating(ak));
    const odds = oddsMap.get(g.id) ?? null;
    const pickConfidence = odds ? (homeWinProb >= 0.5 ? odds.devigHome : 1 - odds.devigHome) : null;
    return {
      gameId: g.id,
      date: g.date,
      status: g.status,
      venue: g.venue,
      home: toTeamSide(g.home, eloH),
      away: toTeamSide(g.away, eloA),
      homeWinProb,
      awayWinProb,
      pickConfidence,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      winner: g.winner,
      state: g.state,
      correct,
      rationale: [
        `${SPORT_LABEL[sport]} margin-of-victory Elo, replayed point-in-time (${gamesReplayed.toLocaleString()} games through ${date}).`,
        `Elo ${g.home.abbr} ${eloH} vs ${g.away.abbr} ${eloA}${g.neutral ? " · neutral site" : ` · +${ELO[sport].hfa} home edge`}.`,
        ...(hk === FCS_POOL || ak === FCS_POOL
          ? [
              `${hk === FCS_POOL ? g.home.abbr : g.away.abbr} is not FBS, so it carries the pooled non-FBS rating rather than one of its own.`,
            ]
          : []),
        odds
          ? `Confidence = ${odds.fromSpread ? "the market's spread, converted" : "the market's read on the pick"} (${g.home.abbr} ${Math.round(odds.devigHome * 100)}% / ${g.away.abbr} ${Math.round((1 - odds.devigHome) * 100)}%), independent of the Elo model.`
          : `No market line available, so no separate confidence for this game.`,
      ],
    };
  });

  return { games, season, gamesReplayed, power, oddsMap };
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

// ------------------------------------------------------------- Recommended

/** The confidence in a pick's outcome (how likely the favored side is to win). */
export function pickConfidence(homeWinProb: number): number {
  return Math.max(homeWinProb, 1 - homeWinProb);
}

/** Today's slate ranked by model confidence — the Recommended surface.
 *  Reuses predictSlate; no extra fetches. */
export async function recommendedSlate(
  sport: Sport,
  date: string,
): Promise<{ games: PredictedGame[]; picks: PredictedGame[]; season: number }> {
  const { games, season } = await predictSlate(sport, date);
  const upcoming = games; // include finals too so the page can score itself
  const picks = [...upcoming]
    .sort((a, b) => pickConfidence(b.homeWinProb) - pickConfidence(a.homeWinProb))
    .slice(0, 5);
  return { games, picks, season };
}

// ------------------------------------------------------------------ odds

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
};

/** American odds → implied probability (vig included). */
function americanImplied(ml: number): number {
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

/** Proportional devig of a two-way market → P(home). */
function devigHomeProb(homeML: number, awayML: number): number {
  const qh = americanImplied(homeML);
  const qa = americanImplied(awayML);
  return qh / (qh + qa);
}

// Research-frozen market blend weight per sport (NBA-NFL-ANALYSIS.md §4/§5).
// College gets less weight than the pros. The market is thinner here — many
// games never get a moneyline at all — and where a line does exist it is often
// read off the spread rather than quoted directly, so leaning on it as hard as
// the NFL blend does would be borrowing confidence the number has not earned.
const MARKET_BLEND_W: Record<Sport, number> = { nba: 0.9, nfl: 0.8, cfb: 0.65 };

function blendWithMarket(sport: Sport, modelHome: number, marketHome: number): number {
  const w = MARKET_BLEND_W[sport];
  return sigmoid((1 - w) * logit(modelHome) + w * logit(marketHome));
}

export type GameOdds = {
  provider: string;
  /** Null when the book has the moneyline off and only a spread is posted. */
  homeML: number | null;
  awayML: number | null;
  homeImplied: number | null;
  awayImplied: number | null;
  /** Home win probability: devigged from the moneyline, or read off the spread
   *  when there isn't one. `fromSpread` says which, because they are not the
   *  same kind of number and the page should not imply they are. */
  devigHome: number;
  fromSpread: boolean;
  /** The posted home spread, where the book gives one. */
  homeSpread: number | null;
};

/**
 * A point spread, as a win probability.
 *
 * College needs this and the pro leagues do not. When a team is favoured by
 * forty the book simply takes the moneyline down — ESPN returns "OFF" — so on a
 * typical Saturday most games have a spread and no moneyline at all. Without
 * this the Best Odds page would have a market column that is empty for two
 * thirds of the slate.
 *
 * The conversion is the standard normal model, P = Phi(-spread / sigma), with
 * sigma fitted rather than assumed: research/cfb/spread_prob.py searches it
 * against six seasons of results and lands on 12.0, which holds up on the
 * held-out seasons (log loss 0.4805, and a stated 85% wins 88%). It puts a
 * 3-point favourite at 60%, a touchdown favourite at 72% and a two-touchdown
 * favourite at 88% — which is where the college market actually prices them.
 *
 * It is fitted against the model's own expected margin, because ESPN does not
 * keep historical college lines to fit against a real closing spread. Treat it
 * as a good approximation of the market's view, not a quote from it — which is
 * why `fromSpread` travels with it.
 */
const SPREAD_SIGMA = 12.0;

/** Standard normal CDF, via erf — no dependency needed for one function. */
function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26, accurate to ~1e-7, which is four more digits
  // than a win probability is ever quoted to.
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Home win probability implied by a posted home spread (-7 = home by 7).
 *
 * Clamped away from the ends. The normal model saturates hard — a 52.5-point
 * favourite comes out at 0.999994, which the page would round to "100%", and
 * no football game is 100%. Ohio State -52.5 is about as sure as college gets
 * and 99% is the most that should ever be claimed for it.
 */
const SPREAD_PROB_CAP = 0.99;

export function spreadToHomeProb(homeSpread: number): number {
  const p = normalCdf(-homeSpread / SPREAD_SIGMA);
  return Math.min(SPREAD_PROB_CAP, Math.max(1 - SPREAD_PROB_CAP, p));
}

type OddsEntry = { at: number; odds: GameOdds | null };
const oddsCache = new Map<number, OddsEntry>();
const ODDS_TTL = 10 * 60 * 1000;

function coreOddsUrl(sport: Sport, eventId: number): string {
  const [seg, league] = ESPN_PATH[sport].split("/");
  return `https://sports.core.api.espn.com/v2/sports/${seg}/leagues/${league}/events/${eventId}/competitions/${eventId}/odds`;
}

/** Once a game kicks off ESPN adds an in-play book alongside the pre-game one
 *  ("DraftKings" and "DraftKings - Live Odds"), and by the fourth quarter they
 *  disagree completely — a 24-7 game reads -910 live against +180 pre-game. The
 *  card's Elo prediction is strictly point-in-time, so pairing it with an
 *  in-play number would put a pre-game pick next to a mid-game confidence and
 *  call both "the market". Only the pre-game line belongs here; relying on the
 *  feed listing it first is not the same as saying so. */
function isLiveProvider(name: string | undefined): boolean {
  return /\blive\b|\bin[- ]?play\b/i.test(name ?? "");
}

function parseSpread(item: unknown): number | null {
  if (!item || typeof item !== "object") return null;
  const it = item as { spread?: number; pointSpread?: { home?: { close?: { line?: string } } } };
  if (typeof it.spread === "number" && Math.abs(it.spread) <= 80) return it.spread;
  const line = it.pointSpread?.home?.close?.line;
  if (line) {
    const n = Number(String(line).replace(/[^-\d.]/g, ""));
    if (Number.isFinite(n) && Math.abs(n) <= 80) return n;
  }
  return null;
}

function parseMoneyLine(side: unknown): number | null {
  if (!side || typeof side !== "object") return null;
  const s = side as {
    moneyLine?: number;
    current?: { moneyLine?: { american?: string } };
  };
  if (typeof s.moneyLine === "number" && Math.abs(s.moneyLine) >= 100) return s.moneyLine;
  const am = s.current?.moneyLine?.american;
  if (am) {
    const n = Number(am.replace(/[^-\d.]/g, ""));
    if (Number.isFinite(n) && Math.abs(n) >= 100) return Math.round(n);
  }
  return null;
}

async function fetchOneEventOdds(sport: Sport, eventId: number): Promise<GameOdds | null> {
  const cached = oddsCache.get(eventId);
  if (cached && Date.now() - cached.at < ODDS_TTL) return cached.odds;
  let odds: GameOdds | null = null;
  try {
    const res = await fetch(coreOddsUrl(sport, eventId), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        items?: {
          provider?: { name?: string };
          homeTeamOdds?: unknown;
          awayTeamOdds?: unknown;
          spread?: number;
        }[];
      };
      // Prefer the first pre-game provider quoting both moneylines. Failing
      // that, take a spread: in college it is routinely the only thing posted,
      // and a converted spread beats an empty column. A moneyline anywhere on
      // the board still wins over a spread — hence the two passes.
      let spreadOnly: GameOdds | null = null;
      for (const item of json.items ?? []) {
        if (isLiveProvider(item.provider?.name)) continue;
        const provider = item.provider?.name ?? "book";
        const homeSpread = parseSpread(item);
        const homeML = parseMoneyLine(item.homeTeamOdds);
        const awayML = parseMoneyLine(item.awayTeamOdds);
        if (homeML != null && awayML != null) {
          odds = {
            provider,
            homeML,
            awayML,
            homeImplied: americanImplied(homeML),
            awayImplied: americanImplied(awayML),
            devigHome: devigHomeProb(homeML, awayML),
            fromSpread: false,
            homeSpread,
          };
          break;
        }
        if (spreadOnly == null && homeSpread != null) {
          spreadOnly = {
            provider,
            homeML: null,
            awayML: null,
            homeImplied: null,
            awayImplied: null,
            devigHome: spreadToHomeProb(homeSpread),
            fromSpread: true,
            homeSpread,
          };
        }
      }
      odds = odds ?? spreadOnly;
    }
  } catch (err) {
    console.error(`[odds] ${sport} ${eventId}:`, err);
  }
  oddsCache.set(eventId, { at: Date.now(), odds });
  return odds;
}

async function fetchOddsForEvents(sport: Sport, ids: number[]): Promise<Map<number, GameOdds>> {
  const map = new Map<number, GameOdds>();
  const results = await Promise.all(ids.map((id) => fetchOneEventOdds(sport, id)));
  ids.forEach((id, i) => {
    const o = results[i];
    if (o) map.set(id, o);
  });
  return map;
}

export type OddsRow = {
  game: PredictedGame;
  odds: GameOdds | null;
  /** Model minus devigged-market home probability; null with no market. */
  edge: number | null;
  /** sim×market blend home probability; null with no market. */
  blendHome: number | null;
};

/** Best Odds surface: today's slate priced with live ESPN odds, ranked by
 *  confidence three ways — the model on its own, the market's devigged line,
 *  and the model×market blend. Same "safest bets" framing as MLB (not a +EV
 *  claim). */
export async function bestOddsSlate(
  sport: Sport,
  date: string,
): Promise<{
  rows: OddsRow[];
  confidencePicks: OddsRow[];
  marketPicks: OddsRow[];
  blendPicks: OddsRow[];
  season: number;
  priced: number;
  blendWeight: number;
}> {
  const { games, season, oddsMap } = await predictSlate(sport, date);
  const rows: OddsRow[] = games.map((game) => {
    const odds = oddsMap.get(game.gameId) ?? null;
    const edge = odds ? game.homeWinProb - odds.devigHome : null;
    const blendHome = odds ? blendWithMarket(sport, game.homeWinProb, odds.devigHome) : null;
    return { game, odds, edge, blendHome };
  });
  const priced = rows.filter(
    (r): r is OddsRow & { odds: GameOdds; blendHome: number } => r.odds != null,
  );
  // Highest model confidence, whatever it pays — the only ranking that works
  // without a posted line, so it covers the whole slate.
  const confidencePicks = [...rows]
    .sort((a, b) => pickConfidence(b.game.homeWinProb) - pickConfidence(a.game.homeWinProb))
    .slice(0, 5);
  const marketPicks = [...priced]
    .sort((a, b) => pickConfidence(b.odds.devigHome) - pickConfidence(a.odds.devigHome))
    .slice(0, 5);
  const blendPicks = [...priced]
    .sort((a, b) => pickConfidence(b.blendHome) - pickConfidence(a.blendHome))
    .slice(0, 5);
  return {
    rows,
    confidencePicks,
    marketPicks,
    blendPicks,
    season,
    priced: priced.length,
    blendWeight: MARKET_BLEND_W[sport],
  };
}

// -------------------------------------------------------------- track record
//
// `trackRecord()` lived here: it replayed the last three seasons and scored
// every completed game point-in-time, which is a legitimate backtest and was
// never a track record. The NFL and NBA Track Record pages now read the forward
// ledger (tracking.server.ts) like every other sport, so it has been removed
// rather than left behind for something to start rendering again.
