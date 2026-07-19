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
const MARKET_BLEND_W: Record<Sport, number> = { nba: 0.9, nfl: 0.8 };

function blendWithMarket(sport: Sport, modelHome: number, marketHome: number): number {
  const w = MARKET_BLEND_W[sport];
  return sigmoid((1 - w) * logit(modelHome) + w * logit(marketHome));
}

export type GameOdds = {
  provider: string;
  homeML: number;
  awayML: number;
  homeImplied: number;
  awayImplied: number;
  /** Devigged home win probability. */
  devigHome: number;
};

type OddsEntry = { at: number; odds: GameOdds | null };
const oddsCache = new Map<number, OddsEntry>();
const ODDS_TTL = 10 * 60 * 1000;

function coreOddsUrl(sport: Sport, eventId: number): string {
  const [seg, league] = ESPN_PATH[sport].split("/");
  return `https://sports.core.api.espn.com/v2/sports/${seg}/leagues/${league}/events/${eventId}/competitions/${eventId}/odds`;
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
        items?: { provider?: { name?: string }; homeTeamOdds?: unknown; awayTeamOdds?: unknown }[];
      };
      // Prefer the first provider that quotes both moneylines.
      for (const item of json.items ?? []) {
        const homeML = parseMoneyLine(item.homeTeamOdds);
        const awayML = parseMoneyLine(item.awayTeamOdds);
        if (homeML == null || awayML == null) continue;
        odds = {
          provider: item.provider?.name ?? "book",
          homeML,
          awayML,
          homeImplied: americanImplied(homeML),
          awayImplied: americanImplied(awayML),
          devigHome: devigHomeProb(homeML, awayML),
        };
        break;
      }
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
 *  confidence two ways — the market's own devigged line, and the model×market
 *  blend. Same "safest bets" framing as MLB (not a +EV claim). */
export async function bestOddsSlate(
  sport: Sport,
  date: string,
): Promise<{
  rows: OddsRow[];
  marketPicks: OddsRow[];
  blendPicks: OddsRow[];
  season: number;
  priced: number;
  blendWeight: number;
}> {
  const { games, season } = await predictSlate(sport, date);
  const oddsMap = await fetchOddsForEvents(
    sport,
    games.map((g) => g.gameId),
  );
  const rows: OddsRow[] = games.map((game) => {
    const odds = oddsMap.get(game.gameId) ?? null;
    const edge = odds ? game.homeWinProb - odds.devigHome : null;
    const blendHome = odds ? blendWithMarket(sport, game.homeWinProb, odds.devigHome) : null;
    return { game, odds, edge, blendHome };
  });
  const priced = rows.filter(
    (r): r is OddsRow & { odds: GameOdds; blendHome: number } => r.odds != null,
  );
  const marketPicks = [...priced]
    .sort((a, b) => pickConfidence(b.odds.devigHome) - pickConfidence(a.odds.devigHome))
    .slice(0, 5);
  const blendPicks = [...priced]
    .sort((a, b) => pickConfidence(b.blendHome) - pickConfidence(a.blendHome))
    .slice(0, 5);
  return {
    rows,
    marketPicks,
    blendPicks,
    season,
    priced: priced.length,
    blendWeight: MARKET_BLEND_W[sport],
  };
}

// -------------------------------------------------------------- track record

export type TrackGame = {
  date: string;
  home: string; // abbr
  away: string;
  homeScore: number;
  awayScore: number;
  pickHome: boolean; // model favored home
  pickProb: number; // confidence in the pick
  correct: boolean;
};

export type SeasonMetrics = {
  season: number;
  seasonLabel: string;
  n: number;
  accuracy: number;
  brier: number;
  logLoss: number;
};

/** Which recent seasons to score for the track record: the most recent
 *  completed season and, if it has games, the in-progress one. */
function trackSeasons(sport: Sport, today: string): number[] {
  const cur = ratingSeason(sport, today);
  const out: number[] = [];
  // the current season (if underway) plus the two most recent completed
  // seasons — a stable multi-season sample without an unbounded replay.
  for (let s = cur; s >= cur - 2; s--) out.push(s);
  return out.sort((a, b) => a - b);
}

/** Replay warmup + scored seasons, scoring every completed game the Elo model
 *  predicted point-in-time. */
export async function trackRecord(
  sport: Sport,
  today: string,
): Promise<{
  overall: SeasonMetrics;
  perSeason: SeasonMetrics[];
  recent: TrackGame[];
  running: { i: number; accuracy: number }[];
  seasonLabels: string[];
}> {
  const scored = trackSeasons(sport, today);
  const firstScored = scored[0];
  const warmupStart = firstScored - WARMUP_SEASONS;
  const teams = await fetchTeams(sport);
  const abbr = (id: string) => teams.get(id)?.abbr ?? id;

  const elo = new Elo(ELO[sport]);
  const perSeasonAcc = new Map<number, { n: number; correct: number; brier: number; ll: number }>();
  const all: (TrackGame & { season: number })[] = [];

  for (let s = warmupStart; s <= firstScored + (scored.length - 1); s++) {
    if (s > warmupStart) elo.carrySeason();
    const finals = await fetchSeasonFinals(sport, s);
    for (const g of finals) {
      if (scored.includes(s)) {
        const pHome = elo.prob(g.home, g.away, g.neutral);
        const result = g.hs > g.as ? 1 : 0;
        const pickHome = pHome >= 0.5;
        const correct = pickHome === (result === 1);
        const bucket = perSeasonAcc.get(s) ?? { n: 0, correct: 0, brier: 0, ll: 0 };
        bucket.n++;
        bucket.correct += correct ? 1 : 0;
        bucket.brier += (pHome - result) ** 2;
        const pc = Math.min(1 - 1e-9, Math.max(1e-9, pHome));
        bucket.ll += -(result * Math.log(pc) + (1 - result) * Math.log(1 - pc));
        perSeasonAcc.set(s, bucket);
        all.push({
          season: s,
          date: g.date,
          home: abbr(g.home),
          away: abbr(g.away),
          homeScore: g.hs,
          awayScore: g.as,
          pickHome,
          pickProb: pickConfidence(pHome),
          correct,
        });
      }
      elo.update(g.home, g.away, g.hs, g.as, g.neutral);
    }
  }

  const mk = (
    season: number,
    b: { n: number; correct: number; brier: number; ll: number },
  ): SeasonMetrics => ({
    season,
    seasonLabel:
      sport === "nba" ? `${season - 1}-${String(season % 100).padStart(2, "0")}` : `${season}`,
    n: b.n,
    accuracy: b.n ? b.correct / b.n : 0,
    brier: b.n ? b.brier / b.n : 0,
    logLoss: b.n ? b.ll / b.n : 0,
  });

  const perSeason = [...perSeasonAcc.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([s, b]) => mk(s, b));

  const totals = [...perSeasonAcc.values()].reduce(
    (acc, b) => ({
      n: acc.n + b.n,
      correct: acc.correct + b.correct,
      brier: acc.brier + b.brier,
      ll: acc.ll + b.ll,
    }),
    { n: 0, correct: 0, brier: 0, ll: 0 },
  );
  const overall = mk(0, totals);
  overall.seasonLabel = "All";

  // running cumulative accuracy over the scored sequence (in date order),
  // downsampled to ~60 points for a compact sparkline.
  all.sort((a, b) => a.date.localeCompare(b.date));
  const running: { i: number; accuracy: number }[] = [];
  let cum = 0;
  const step = Math.max(1, Math.floor(all.length / 60));
  all.forEach((g, i) => {
    cum += g.correct ? 1 : 0;
    if (i % step === 0 || i === all.length - 1) running.push({ i: i + 1, accuracy: cum / (i + 1) });
  });

  const recent = all
    .slice(-25)
    .reverse()
    .map(({ season: _s, ...g }) => g);

  return {
    overall,
    perSeason,
    recent,
    running,
    seasonLabels: perSeason.map((p) => p.seasonLabel),
  };
}
