// mlb-v3.ts — Model "sim-elo-v3" (a.k.a. Algorithm V2).
//
// Builds directly on top of the shipped sim-elo-v2 rather than replacing it:
// the Monte Carlo engine, the multi-season Elo, the logit-mean ensemble, the
// per-game seeds, and every calibration constant are reused untouched from
// mlb-sim.ts. What changes is *what the engine is fed* and one small additive
// term on the output:
//
//   1. Strength-of-schedule deconvolution (mlb-sos.ts). Team batting rates
//      are adjusted for the quality of the opposing pitching staffs actually
//      faced; staff lines and starter lines are adjusted for the strength of
//      the opposing batting schedules they drew (starter-level, BF-weighted
//      from his game log); and all observed rates are park-deconvolved so the
//      game-time park factor isn't applied on top of a park-inflated input.
//   2. A capped game-context logit delta (mlb-context.ts): win streak,
//      14-day scoring form beyond season level, rest, schedule density,
//      travel distance, time zones crossed, bullpen stress.
//   3. An optional global calibration scale (default 1 = off).
//
// Regression guarantee, enforced by tests: with every adjustment disabled the
// output is bit-identical to sim-elo-v2 (same inputs, same seeds, same sim).
//
// Point-in-time discipline: every helper takes the season game list + rate
// maps as arguments and filters strictly before the game's date, so the same
// pure core is used by the live builder, scripts/backtest-v3.ts, and tests.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import {
  computeElo,
  eloWinProb,
  fetchAllTeamRates,
  fetchSeasonResults,
  fetchStarterInfo,
  leagueRates,
  reshapeStaff,
  simulateMatchup,
  type BattingRates,
  type PitchingLine,
  type SeasonGameResult,
  type StarterInfo,
  type TeamRates,
} from "./mlb-sim";
import {
  adjustBattingRates,
  adjustPitchingLine,
  combineMultipliers,
  computeAllTeamSos,
  computeStarterSos,
  DEFAULT_SOS_TUNING,
  NEUTRAL_MULTIPLIERS,
  sosSummary,
  type EventMultipliers,
  type SeasonGame,
  type SosTuning,
  type StarterLogEntry,
  type TeamLines,
  type TeamSos,
} from "./mlb-sos";
import {
  computeTeamContext,
  contextLogitDelta,
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
  type ContextDelta,
  type TeamContext,
} from "./mlb-context";

export const MODEL_VERSION_V3 = "sim-elo-v3";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface SosConfig {
  /** Adjust team batting for the opposing pitching staffs faced. */
  adjustBatting: boolean;
  /** Adjust staff + starter lines for the opposing batting schedules faced. */
  adjustPitching: boolean;
  /** Park-deconvolve every observed rate. */
  adjustParks: boolean;
  /** Use per-starter game logs (falls back to team-level when a log is missing). */
  starterLevel: boolean;
  /** Estimation knobs (prior, damping λ, contamination debias). */
  tuning: SosTuning;
}

export interface V3Config {
  sos: SosConfig;
  context: ContextConfig;
  /** Global logit scale on the final probability; 1 = identity. */
  calScale: number;
}

export const DEFAULT_V3_CONFIG: V3Config = {
  sos: {
    adjustBatting: true,
    adjustPitching: true,
    adjustParks: true,
    starterLevel: true,
    tuning: DEFAULT_SOS_TUNING,
  },
  context: DEFAULT_CONTEXT_CONFIG,
  calScale: 1.0,
};

/** Everything off — must reproduce sim-elo-v2 exactly (see mlb-v3.test.ts). */
export const V3_AS_V2_CONFIG: V3Config = {
  sos: {
    adjustBatting: false,
    adjustPitching: false,
    adjustParks: false,
    starterLevel: false,
    tuning: DEFAULT_SOS_TUNING,
  },
  context: {
    ...DEFAULT_CONTEXT_CONFIG,
    enabled: {
      streak: false,
      form: false,
      rest: false,
      density: false,
      travel: false,
      tz: false,
      penStress: false,
    },
  },
  calScale: 1.0,
};

// ─── Pure per-game prediction core ────────────────────────────────────────────

export interface V3GameInput {
  gameId: number;
  /** Calendar date (YYYY-MM-DD) — the as-of morning for every feature. */
  date: string;
  /** Full ISO start time, echoed into the output. */
  gameDate: string;
  venue: string | null;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  homePitcherId: number | null;
  awayPitcherId: number | null;
}

export interface V3Env {
  /** Current-season finals (with venue/innings) — may contain future games; they are filtered per game date. */
  seasonGames: SeasonGame[];
  /** Per-team season-to-date batting + (reshaped) staff lines, as of the morning. */
  teamLines: Map<number, TeamLines>;
  league: BattingRates;
  elo: Map<number, number>;
  starterInfo: Map<number, StarterInfo | null>;
  starterLogs: Map<number, StarterLogEntry[]>;
  homeVenueOf: (teamId: number) => string | null;
  nSims?: number;
  config?: V3Config;
}

export interface V3Prediction {
  gameId: number;
  date: string;
  venue: string;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  simProb: number; // Monte Carlo on SOS-adjusted inputs
  eloProb: number;
  ensembleProb: number; // logit-mean of the two (pre-context)
  finalProb: number; // ensemble + context delta, calibrated — the headline
  contextDelta: ContextDelta;
  homeContext: TeamContext;
  awayContext: TeamContext;
  homeSos: TeamSos | null;
  awaySos: TeamSos | null;
  homeElo: number;
  awayElo: number;
  nSims: number;
  rationale: string[];
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

interface AdjustedSide {
  batting: BattingRates;
  staff: PitchingLine | null;
  starter: StarterInfo | null;
  sos: TeamSos | null;
  starterStarts: number;
}

/** Apply the configured SOS adjustments to one team's sim inputs. */
function adjustSide(
  teamId: number,
  pitcherId: number | null,
  env: V3Env,
  sosMap: Map<number, TeamSos>,
  cfg: V3Config,
): AdjustedSide {
  const lines = env.teamLines.get(teamId) ?? { batting: null, staff: null };
  const sos = sosMap.get(teamId) ?? null;
  const starterRaw = (pitcherId != null ? env.starterInfo.get(pitcherId) : null) ?? null;

  let batting = lines.batting ?? env.league;
  let staff = lines.staff;
  let starter = starterRaw;
  let starterStarts = 0;

  const anySos = cfg.sos.adjustBatting || cfg.sos.adjustPitching || cfg.sos.adjustParks;
  if (anySos && sos) {
    // Batting: divide out opposing-staff quality and the parks batted in.
    if (lines.batting) {
      let mult: EventMultipliers = { ...NEUTRAL_MULTIPLIERS };
      if (cfg.sos.adjustBatting) mult = combineMultipliers(mult, sos.oppPitching);
      if (cfg.sos.adjustParks) mult = combineMultipliers(mult, sos.park);
      batting = adjustBattingRates(lines.batting, mult);
    }
    // Staff: divide out opposing-batting strength and the parks pitched in.
    if (staff) {
      let mult: EventMultipliers = { ...NEUTRAL_MULTIPLIERS };
      if (cfg.sos.adjustPitching) mult = combineMultipliers(mult, sos.oppBatting);
      if (cfg.sos.adjustParks) mult = combineMultipliers(mult, sos.park);
      staff = adjustPitchingLine(staff, mult);
    }
    // Starter: his own BF-weighted schedule when a log exists, else the
    // team-level schedule as an unbiased approximation.
    if (starterRaw && cfg.sos.adjustPitching) {
      const log = pitcherId != null ? (env.starterLogs.get(pitcherId) ?? []) : [];
      let oppBatting = sos.oppBatting;
      let park = sos.park;
      if (cfg.sos.starterLevel && log.length > 0) {
        const s = computeStarterSos(
          log,
          teamId,
          env.teamLines,
          env.league,
          // per-game filtering happens at the call site via asOf below
          "9999-12-31",
          env.homeVenueOf,
          cfg.sos.tuning,
        );
        if (s.starts > 0) {
          oppBatting = s.oppBatting;
          park = s.park;
          starterStarts = s.starts;
        }
      }
      let mult: EventMultipliers = oppBatting;
      if (cfg.sos.adjustParks) mult = combineMultipliers(mult, park);
      starter = {
        line: adjustPitchingLine(starterRaw.line, mult),
        expectedOuts: starterRaw.expectedOuts,
      };
    }
  }

  return { batting, staff, starter, sos, starterStarts };
}

/**
 * Predict one game. Every feature is derived from `env` filtered to strictly
 * before `g.date` — passing a season list that extends past the game's date
 * must not change the output (no-lookahead; tested).
 */
export function predictV3Game(g: V3GameInput, env: V3Env): V3Prediction {
  const cfg = env.config ?? DEFAULT_V3_CONFIG;
  const nSims = env.nSims ?? 3000;

  // SOS multipliers as of this game's morning.
  const anySos = cfg.sos.adjustBatting || cfg.sos.adjustPitching || cfg.sos.adjustParks;
  const sosMap = anySos
    ? computeAllTeamSos(env.seasonGames, env.teamLines, env.league, g.date, cfg.sos.tuning)
    : new Map<number, TeamSos>();

  // Starter logs must respect the same as-of morning.
  const trimmedEnv: V3Env = {
    ...env,
    starterLogs: new Map(
      Array.from(env.starterLogs, ([id, log]) => [id, log.filter((e) => e.date < g.date)]),
    ),
  };

  const home = adjustSide(g.homeId, g.homePitcherId, trimmedEnv, sosMap, cfg);
  const away = adjustSide(g.awayId, g.awayPitcherId, trimmedEnv, sosMap, cfg);

  const simProb = simulateMatchup(
    {
      homeBatting: home.batting,
      awayBatting: away.batting,
      homeStarter: home.starter,
      awayStarter: away.starter,
      homeStaff: home.staff,
      awayStaff: away.staff,
      league: env.league,
      venue: g.venue,
    },
    nSims,
    1000 + g.gameId, // production seed convention (mlb-sim.ts)
  );

  const homeElo = env.elo.get(g.homeId) ?? 1500;
  const awayElo = env.elo.get(g.awayId) ?? 1500;
  const eloProb = eloWinProb(homeElo, awayElo);
  const ensembleLogit = (logit(clamp01(simProb)) + logit(clamp01(eloProb))) / 2;
  const ensembleProb = sigmoid(ensembleLogit);

  const homeContext = computeTeamContext(g.homeId, env.seasonGames, g.date, cfg.context);
  const awayContext = computeTeamContext(g.awayId, env.seasonGames, g.date, cfg.context);
  const contextDelta = contextLogitDelta(homeContext, awayContext, g.venue, g.date, cfg.context);

  const finalProb = sigmoid(cfg.calScale * (ensembleLogit + contextDelta.total));

  const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
  const rationale: string[] = [
    `Monte Carlo on schedule-adjusted rates (${nSims} sims): home wins ${pct(simProb)}`,
  ];
  if (home.sos && away.sos && anySos) {
    const tilt = (s: TeamSos) => `${(sosSummary(s.oppPitching) * 100).toFixed(1)}%`;
    rationale.push(
      `Opp-schedule strength (staffs faced vs lg): home ${tilt(home.sos)}, away ${tilt(away.sos)}`,
    );
  }
  rationale.push(
    `Elo ${homeElo.toFixed(0)} vs ${awayElo.toFixed(0)} → ${pct(eloProb)}`,
    `Ensemble (logit mean) → ${pct(ensembleProb)}`,
  );
  if (contextDelta.terms.length > 0) {
    const parts = contextDelta.terms
      .map((t) => `${t.name} ${t.value >= 0 ? "+" : ""}${t.value.toFixed(3)}`)
      .join(", ");
    rationale.push(
      `Context Δ ${contextDelta.total >= 0 ? "+" : ""}${contextDelta.total.toFixed(3)} logit (${parts})`,
    );
  }
  rationale.push(`Algorithm V2 (${MODEL_VERSION_V3}) → home ${pct(finalProb)}`);

  return {
    gameId: g.gameId,
    date: g.gameDate,
    venue: g.venue ?? "—",
    homeId: g.homeId,
    awayId: g.awayId,
    homeName: g.homeName,
    awayName: g.awayName,
    simProb,
    eloProb,
    ensembleProb,
    finalProb,
    contextDelta,
    homeContext,
    awayContext,
    homeSos: home.sos,
    awaySos: away.sos,
    homeElo,
    awayElo,
    nSims,
    rationale,
  };
}

// ─── Fetchers (live path; the backtest reconstructs these point-in-time) ─────

/**
 * Current-season finals with venue + innings (superset of fetchSeasonResults,
 * which stays untouched for sim-elo-v2). The `fields` filter keeps the
 * season-long linescore hydrate to a manageable payload; every field is
 * parsed defensively because `fields` support can vary — a missing venue or
 * linescore degrades that game to neutral park / 9 innings rather than failing.
 */
export async function fetchSeasonGames(season: number, beforeDate: string): Promise<SeasonGame[]> {
  const end = new Date(new Date(beforeDate + "T00:00:00Z").getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  const fields =
    "dates,date,games,gamePk,status,detailedState,teams,home,away,team,id,score,venue,name,linescore,currentInning";
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&startDate=${season}-03-01&endDate=${end}&hydrate=linescore&fields=${fields}`;
  const res = await fetchWithTimeout(url, 45_000);
  if (!res.ok) return [];
  const json: any = await res.json();
  const out: SeasonGame[] = [];
  for (const d of json?.dates ?? []) {
    for (const g of d?.games ?? []) {
      const status: string = g?.status?.detailedState ?? "";
      if (!/final|game over|completed/i.test(status)) continue;
      const hs = g?.teams?.home?.score;
      const as = g?.teams?.away?.score;
      if (typeof hs !== "number" || typeof as !== "number" || hs === as) continue;
      const inningsRaw = g?.linescore?.currentInning;
      out.push({
        date: d.date,
        home: g.teams.home.team.id,
        away: g.teams.away.team.id,
        homeScore: hs,
        awayScore: as,
        venue: g?.venue?.name ?? null,
        innings: typeof inningsRaw === "number" && inningsRaw > 0 ? inningsRaw : null,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** A starter's per-start log: opponent, home/away, batters faced. */
export async function fetchStarterGameLog(
  personId: number,
  season: number,
): Promise<StarterLogEntry[]> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const json: any = await res.json();
    const splits: any[] = json?.stats?.[0]?.splits ?? [];
    const out: StarterLogEntry[] = [];
    for (const s of splits) {
      const bf = s?.stat?.battersFaced;
      if (typeof bf !== "number" || bf <= 0) continue;
      out.push({
        date: s?.date ?? "",
        opponentTeamId: s?.opponent?.id ?? null,
        isHome: typeof s?.isHome === "boolean" ? s.isHome : null,
        battersFaced: bf,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Team id → home venue name (for locating a starter's away starts). */
export async function fetchTeamHomeVenues(season: number): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const res = await fetchWithTimeout(`${STATS_API}/teams?sportId=1&season=${season}`);
    if (!res.ok) return map;
    const json: any = await res.json();
    for (const t of json?.teams ?? []) {
      if (t?.id && t?.venue?.name) map.set(t.id, t.venue.name);
    }
  } catch {
    /* neutral park fallback */
  }
  return map;
}

/** Season TeamRates → TeamLines with the staff line reshaped to real 1B/2B/3B. */
export function toTeamLines(
  teamRates: Map<number, TeamRates>,
  lg: BattingRates,
): Map<number, TeamLines> {
  const out = new Map<number, TeamLines>();
  for (const [id, r] of teamRates) {
    out.set(id, { batting: r.batting, staff: reshapeStaff(r.staff, lg) });
  }
  return out;
}

// ─── Full date pipeline (live) ────────────────────────────────────────────────

/**
 * Predict every game on `date` with Algorithm V2. Mirrors
 * buildSimPredictionsForDate; extra cost over v2 is one game-log call per
 * probable starter, one /teams call, and the linescore hydrate on the season
 * schedule call.
 */
export async function buildV3PredictionsForDate(
  date: string,
  nSims = 3000,
  config: V3Config = DEFAULT_V3_CONFIG,
): Promise<V3Prediction[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue&startDate=${date}&endDate=${date}`;
  const [scheduleRes, prev2Results, prev1Results, seasonGames, teamRates, homeVenues] =
    await Promise.all([
      fetchWithTimeout(scheduleUrl),
      fetchSeasonResults(season - 2, `${season - 2}-12-01`),
      fetchSeasonResults(season - 1, `${season - 1}-12-01`),
      fetchSeasonGames(season, date),
      fetchAllTeamRates(season),
      fetchTeamHomeVenues(season),
    ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];

  // Elo replays the identical result stream sim-elo-v2 uses; SeasonGame is a
  // superset of SeasonGameResult so the current season list feeds it directly.
  const elo = computeElo([prev2Results, prev1Results, seasonGames as SeasonGameResult[]]);
  const lg = leagueRates(teamRates);
  const teamLines = toTeamLines(teamRates, lg);

  const pitcherIds = new Set<number>();
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }
  const starterInfo = new Map<number, StarterInfo | null>();
  const starterLogs = new Map<number, StarterLogEntry[]>();
  await batchedAll(
    Array.from(pitcherIds).flatMap((id) => [
      async () => {
        starterInfo.set(id, await fetchStarterInfo(id, season, lg));
      },
      async () => {
        starterLogs.set(id, await fetchStarterGameLog(id, season));
      },
    ]),
    8,
  );

  const env: V3Env = {
    seasonGames,
    teamLines,
    league: lg,
    elo,
    starterInfo,
    starterLogs,
    homeVenueOf: (id) => homeVenues.get(id) ?? null,
    nSims,
    config,
  };

  return games.map((g: any) =>
    predictV3Game(
      {
        gameId: g.gamePk,
        date,
        gameDate: g.gameDate ?? date,
        venue: g.venue?.name ?? null,
        homeId: g.teams.home.team.id,
        awayId: g.teams.away.team.id,
        homeName: g.teams.home.team.name,
        awayName: g.teams.away.team.name,
        homePitcherId: g.teams.home.probablePitcher?.id ?? null,
        awayPitcherId: g.teams.away.probablePitcher?.id ?? null,
      },
      env,
    ),
  );
}
