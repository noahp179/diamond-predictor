/**
 * soccer.server.ts — live slate and 1X2 predictions for the five leagues.
 *
 * Same shape as espn.server.ts does for NBA/NFL, with one structural
 * difference that changes everything downstream: football is a THREE-way
 * problem. A match ends home, draw or away, so the model cannot emit a single
 * win probability — it emits three that sum to one, and the metric that judges
 * it is the ranked probability score rather than Brier or log loss alone.
 *
 * The model is `elo_gd`, frozen in research/soccer/ship_soccer.py and read from
 * soccer-match-model.json:
 *
 *   1. Replay every completed match in the league, oldest first, updating an
 *      Elo rating with a goal-difference K multiplier.
 *   2. The signal for an upcoming match is (home rating + home advantage) −
 *      away rating.
 *   3. A per-league multinomial logistic turns that one number into H/D/A.
 *
 * Steps 1 and 2 are pure arithmetic over results, which is why this model ships
 * and the tree ensembles that edged it in the bake-off do not — they would need
 * a fitted sklearn object per league, and they overfit a 380-match season.
 * Step 3's coefficients are league-local because draw rates are not equal
 * across competitions.
 *
 * Ratings are cached per (league, season) at module scope: completed seasons
 * are immutable so they are cached forever, and the in-progress season carries
 * a short TTL so new results flow in.
 */

import matchModels from "./soccer-match-model.json";
import { leagueOf, type LeagueSlug } from "./soccer-leagues";
import { pickOf, scoreOutcome, type ScoredCall } from "./ledger-stats";

type MatchModel = {
  league: string;
  name: string;
  algorithm: string;
  elo: { init: number; k: number; hfa: number; gdExp: number; carry: number };
  calibration: { coef: number[]; intercept: number[] };
  backtest: {
    rps: number;
    logloss: number;
    brier: number;
    acc: number;
    n: number;
    seasons: number[];
    trainedThrough: number;
    bakeoffRank: number | null;
    bakeoffOf: number | null;
    rpsBehindBest: number | null;
  };
  priors: { home: number; draw: number; away: number; goals: number };
};

const MODELS = matchModels as Record<string, MatchModel>;

export function matchModelFor(slug: LeagueSlug): MatchModel {
  return MODELS[slug];
}

// ------------------------------------------------------------------- types

export type SoccerTeam = {
  id: string;
  abbr: string;
  name: string;
  logo?: string;
  record?: string;
};

export type SoccerMatch = {
  id: string;
  date: string; // ISO
  status: string;
  completed: boolean;
  venue: string;
  home: SoccerTeam;
  away: SoccerTeam;
  homeGoals: number | null;
  awayGoals: number | null;
  /** Model probabilities, summing to 1. Null before ratings exist for a side. */
  probs: { home: number; draw: number; away: number } | null;
  /** The Elo gap the probabilities came from, for display and debugging. */
  ratingGap: number | null;
  /** Actual result once played: "H" | "D" | "A". */
  result: "H" | "D" | "A" | null;
};

export type SoccerSlate = {
  league: LeagueSlug;
  date: string;
  matches: SoccerMatch[];
  season: number;
  /** Elo table after every completed match up to `date`. */
  table: { team: SoccerTeam; rating: number; played: number }[];
};

// ------------------------------------------------------------------- fetch

type EspnCompetitor = {
  homeAway: "home" | "away";
  score?: string;
  team: {
    id: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
    logo?: string;
  };
  records?: { type?: string; summary?: string }[];
};

type EspnEvent = {
  id: string;
  date: string;
  status: { type: { name?: string; state?: string; shortDetail?: string; completed?: boolean } };
  competitions: {
    venue?: { fullName?: string };
    competitors: EspnCompetitor[];
  }[];
};

const API = "https://site.api.espn.com/apis/site/v2/sports/soccer";

/**
 * Fetch a date range from the scoreboard, retrying a throttle.
 *
 * ESPN answers a burst of whole-season requests with a 403 rather than a 429 —
 * it looks like a permissions failure and is really a rate limit, which is why
 * this retries a status that would normally be pointless to retry. Two
 * attempts with a growing pause clears it; anything that survives that is a
 * real failure and is thrown.
 */
async function espnFetch(espn: string, dates: string): Promise<EspnEvent[]> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 1)));
    const res = await fetch(`${API}/${espn}/scoreboard?dates=${dates}&limit=1000`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = (await res.json()) as { events?: EspnEvent[] };
      return json.events ?? [];
    }
    last = String(res.status);
    if (res.status !== 403 && res.status !== 429 && res.status < 500) break;
  }
  throw new Error(`ESPN soccer ${espn} ${dates}: ${last}`);
}

function team(c: EspnCompetitor): SoccerTeam {
  return {
    id: c.team.id,
    abbr: c.team.abbreviation ?? c.team.shortDisplayName ?? "?",
    name: c.team.shortDisplayName ?? c.team.displayName ?? "?",
    logo: c.team.logo,
    record: c.records?.find((r) => r.type === "total")?.summary ?? c.records?.[0]?.summary,
  };
}

function sides(e: EspnEvent) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");
  return { comp, home, away };
}

/**
 * Team id → display metadata for the whole league.
 *
 * The power table needs every rated club, not just the ones playing today, so
 * it cannot be built from the day's fixtures alone — that showed four teams on
 * a two-match matchday. Cached for a day; the roster of a league changes once a
 * season.
 */
const teamsCache = new Map<string, { at: number; teams: Map<string, SoccerTeam> }>();
const TEAMS_TTL = 24 * 60 * 60 * 1000;

async function fetchTeams(espn: string): Promise<Map<string, SoccerTeam>> {
  const hit = teamsCache.get(espn);
  if (hit && Date.now() - hit.at < TEAMS_TTL) return hit.teams;
  const map = new Map<string, SoccerTeam>();
  try {
    const res = await fetch(`${API}/${espn}/teams?limit=100`, {
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
              logos?: { href?: string }[];
            };
          }[];
        }[];
      }[];
    };
    for (const t of json.sports?.[0]?.leagues?.[0]?.teams ?? []) {
      map.set(t.team.id, {
        id: t.team.id,
        abbr: t.team.abbreviation ?? t.team.shortDisplayName ?? "?",
        name: t.team.shortDisplayName ?? t.team.displayName ?? "?",
        logo: t.team.logos?.[0]?.href,
      });
    }
  } catch (err) {
    console.error(`[fetchTeams] soccer ${espn}:`, err);
  }
  teamsCache.set(espn, { at: Date.now(), teams: map });
  return map;
}

// ----------------------------------------------------------------- seasons

/**
 * ESPN labels a season by its opening year: 2025 means the 2025-26 campaign.
 * European seasons run August to May, so a date in January belongs to the
 * season that opened the previous August.
 */
export function seasonOf(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= 7 ? y : y - 1;
}

const seasonWindow = (season: number) => `${season}0701-${season + 1}0630`;

/** How many completed seasons to replay before the target so ratings arrive warm. */
const WARMUP_SEASONS = 2;

/**
 * How far back the scored replay reaches. A European season is about ten
 * months, so a year covers a full campaign plus the tail of the one before —
 * enough matches for a hit rate to mean something, recent enough that it is
 * still describing the model as it is shipped today.
 */
const HISTORY_DAYS = 365;
const HISTORY_TTL = 60 * 60 * 1000;
const historyCache = new Map<string, { at: number; calls: ScoredCall[] }>();

export type Final = {
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  season: number;
};

const finalsCache = new Map<string, { at: number; finals: Final[] }>();
const LIVE_TTL = 10 * 60 * 1000;

async function seasonFinals(espn: string, season: number, current: number): Promise<Final[]> {
  const key = `${espn}:${season}`;
  const hit = finalsCache.get(key);
  // A finished season never changes, so it is cached for the life of the
  // process. The season in progress gets a short TTL so results flow in.
  if (hit && (season < current || Date.now() - hit.at < LIVE_TTL)) return hit.finals;

  const events = await espnFetch(espn, seasonWindow(season));
  const finals: Final[] = [];
  for (const e of events) {
    const { home, away } = sides(e);
    if (!e.status?.type?.completed || !home || !away) continue;
    const hg = Number(home.score);
    const ag = Number(away.score);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    finals.push({
      date: e.date.slice(0, 10),
      home: home.team.id,
      away: away.team.id,
      hg,
      ag,
      season,
    });
  }
  finals.sort((a, b) => a.date.localeCompare(b.date));
  finalsCache.set(key, { at: Date.now(), finals });
  return finals;
}

// -------------------------------------------------------------------- elo

/**
 * Replay the league up to (but not including) `upTo`, returning each team's
 * rating.
 *
 * Exported for scripts/test-replay.ts, which asserts the observer fires before
 * the fold. That ordering cannot be checked from the outside — a leaked replay
 * of a season still lands within a few points of the honest one (measured: 55.4%
 * against 48.9% on the EPL) so no accuracy threshold separates them reliably.
 * The only decisive check is on the arithmetic itself. This is the same arithmetic as research/soccer/ship_soccer.py: the
 * constants live in the model file so the two cannot drift apart.
 */
export function replay(
  model: MatchModel,
  finals: Final[],
  upTo: string,
  /**
   * Called for each match immediately BEFORE it is folded into the ratings,
   * with the rating gap the model would have priced it at. That ordering is the
   * whole point: an observer that ran after the update would be looking at a
   * table that already knows the result, which is the classic way a replay
   * quietly turns into a fit.
   */
  onMatch?: (m: Final, ctx: { gap: number; known: boolean }) => void,
) {
  const { init, k, hfa, gdExp, carry } = model.elo;
  const elo = new Map<string, number>();
  const played = new Map<string, number>();
  const rate = (t: string) => elo.get(t) ?? init;
  let season: number | null = null;

  for (const m of finals) {
    if (m.date >= upTo) break;
    if (season !== null && m.season !== season) {
      // Between seasons, ratings are pulled back toward the mean.
      for (const [t, r] of elo) elo.set(t, init + carry * (r - init));
    }
    season = m.season;

    if (onMatch) {
      onMatch(m, {
        gap: rate(m.home) + hfa - rate(m.away),
        // Same test the slate uses: a club with no rating yet has nothing to be
        // right or wrong about, so it is not scored.
        known: elo.has(m.home) || elo.has(m.away),
      });
    }

    const gd = m.hg - m.ag;
    const res = gd > 0 ? 1 : gd === 0 ? 0.5 : 0;
    const exp = 1 / (1 + 10 ** (-(rate(m.home) + hfa - rate(m.away)) / 400));
    const d = k * (Math.abs(gd) + 1) ** gdExp * (res - exp);
    elo.set(m.home, rate(m.home) + d);
    elo.set(m.away, rate(m.away) - d);
    played.set(m.home, (played.get(m.home) ?? 0) + 1);
    played.set(m.away, (played.get(m.away) ?? 0) + 1);
  }
  return { elo, played, rate };
}

/** softmax over the calibrated 1-D rating gap → [home, draw, away]. */
function calibrate(model: MatchModel, gap: number) {
  const { coef, intercept } = model.calibration;
  const z = coef.map((c, i) => c * gap + intercept[i]);
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const s = e[0] + e[1] + e[2];
  return { home: e[0] / s, draw: e[1] / s, away: e[2] / s };
}

// --------------------------------------------------------------- the slate

export async function soccerSlate(slug: LeagueSlug, date: string): Promise<SoccerSlate> {
  const league = leagueOf(slug);
  const model = matchModelFor(slug);
  const season = seasonOf(date);
  const currentSeason = seasonOf(new Date().toISOString().slice(0, 10));

  // Ratings need this season plus a warm-up; the day's fixtures need the day.
  const seasons: number[] = [];
  for (let s = season - WARMUP_SEASONS; s <= season; s += 1) seasons.push(s);
  const [dayEvents, directory, ...history] = await Promise.all([
    espnFetch(league.espn, date.replace(/-/g, "")),
    fetchTeams(league.espn),
    ...seasons.map((s) => seasonFinals(league.espn, s, currentSeason)),
  ]);

  const finals = history.flat().sort((a, b) => a.date.localeCompare(b.date));
  const { elo, played, rate } = replay(model, finals, date);

  const matches: SoccerMatch[] = [];
  const seen = new Map<string, SoccerTeam>();
  for (const e of dayEvents) {
    const { comp, home, away } = sides(e);
    if (!home || !away) continue;
    const h = team(home);
    const a = team(away);
    seen.set(h.id, h);
    seen.set(a.id, a);

    const hg = Number(home.score);
    const ag = Number(away.score);
    const completed = Boolean(e.status?.type?.completed);
    const known = elo.has(h.id) || elo.has(a.id);
    const gap = rate(h.id) + model.elo.hfa - rate(a.id);

    matches.push({
      id: e.id,
      date: e.date,
      status: e.status?.type?.shortDetail ?? e.status?.type?.name ?? "Scheduled",
      completed,
      venue: comp?.venue?.fullName ?? "",
      home: h,
      away: a,
      homeGoals: completed && Number.isFinite(hg) ? hg : null,
      awayGoals: completed && Number.isFinite(ag) ? ag : null,
      probs: known ? calibrate(model, gap) : null,
      ratingGap: known ? gap : null,
      result:
        completed && Number.isFinite(hg) && Number.isFinite(ag)
          ? hg > ag
            ? "H"
            : hg === ag
              ? "D"
              : "A"
          : null,
    });
  }
  matches.sort((a, b) => a.date.localeCompare(b.date));

  // The Elo table, for the league page's power ranking. Names come from the
  // league directory first and the day's fixtures second, so every rated club
  // appears — not just the ones playing today. An id neither source can name is
  // a relegated club still carrying a rating; it is dropped rather than shown
  // as "?".
  const table = [...elo.entries()]
    .map(([id, rating]) => ({
      team: directory.get(id) ?? seen.get(id),
      rating,
      played: played.get(id) ?? 0,
    }))
    .filter((r): r is { team: SoccerTeam; rating: number; played: number } => Boolean(r.team))
    .sort((a, b) => b.rating - a.rating);

  return { league: slug, date, matches, season, table };
}

// ------------------------------------------------------------ the replay log

/**
 * Score the model over recent completed matches.
 *
 * The live ledger in tracking.server.ts is the honest forward record, but it
 * starts empty and fills at the rate the sport plays — for months a Track
 * Record page backed only by it can draw nothing at all. This fills that gap
 * with the one thing that is legitimately available immediately: the model run
 * over matches that have already happened, each priced with the ratings as they
 * stood BEFORE it.
 *
 * That is a backtest, not a forward record, and the page says so. It is exactly
 * what the NFL and NBA Track Record pages have always shown. The reason it is
 * worth showing is that the alternative — an empty page — tells a reader
 * nothing about whether the model works.
 *
 * No leakage: `replay` invokes the observer before folding the match in, so
 * every probability here was computable the morning of the match.
 */
export async function soccerHistory(
  slug: LeagueSlug,
  upTo: string,
  days = HISTORY_DAYS,
): Promise<ScoredCall[]> {
  const key = `${slug}:${upTo}:${days}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL) return hit.calls;

  const league = leagueOf(slug);
  const model = matchModelFor(slug);
  const currentSeason = seasonOf(new Date().toISOString().slice(0, 10));

  const from = new Date(`${upTo}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  const since = from.toISOString().slice(0, 10);

  // Warm-up seasons before the scored window, so the ratings are not still
  // sitting at their initial value when the first scored match arrives.
  const seasons: number[] = [];
  for (let s = seasonOf(since) - WARMUP_SEASONS; s <= seasonOf(upTo); s += 1) seasons.push(s);

  // Sequential, unlike the slate: this asks for up to four whole seasons at
  // once and ESPN throttles a burst of those. The seasons are cached after the
  // first call, so the cost is paid once an hour at most.
  const history: Final[][] = [];
  for (const s of seasons) history.push(await seasonFinals(league.espn, s, currentSeason));
  const finals = history.flat().sort((a, b) => a.date.localeCompare(b.date));

  const calls: ScoredCall[] = [];
  replay(model, finals, upTo, (m, { gap, known }) => {
    if (!known || m.date < since) return;
    const p = calibrate(model, gap);
    const probs = { a: p.home, draw: p.draw, b: p.away };
    const result: "a" | "draw" | "b" = m.hg > m.ag ? "a" : m.hg === m.ag ? "draw" : "b";
    const { pick, pickProb } = pickOf(probs);
    const { brier, logLoss, rps } = scoreOutcome(probs, result);
    calls.push({ date: m.date, pickProb, correct: pick === result, brier, logLoss, rps });
  });

  historyCache.set(key, { at: Date.now(), calls });
  return calls;
}
