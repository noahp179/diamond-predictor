// mlb-recent-form.ts — "sim-recent-v1"
//
// Same Monte Carlo + Elo ensemble engine as sim-elo-v2 (mlb-sim.ts) — this
// file adds no new simulation logic, it reuses simulateMatchup/computeElo/
// eloWinProb/leagueRates/reshapeStaff unchanged. The one thing that changes:
// team batting/staff rates and starter lines come from a trailing window
// (last 21 days for teams, last 45 for starters) via the MLB Stats API's
// `stats=byDateRange`, instead of full-season-to-date `stats=season`.
//
// The hypothesis being tested: recent form (hot/cold streaks, a bat coming
// back from IL, a rotation shuffle) is a better offense/pitching signal than
// a season-long average, especially as the season accumulates months of
// stale April/May data. Elo is left untouched (same multi-season replay
// sim-elo-v2 uses) so this isolates exactly one variable.
//
// This is a new tracked model (src/lib/mlb-models.ts), not a change to
// sim-elo-v2 — the two get recorded and scored side by side on Track Record,
// so recent-form only "wins" if it actually beats the headline model on real
// settled games. `stats=byDateRange` itself is a proven-working parameter —
// scripts/backtest-odds-blend.ts already uses it for point-in-time backtest
// features — this file just narrows the window from season-to-date to a
// trailing slice.
//
// UNVALIDATED AT SHIP TIME: no backtest has been run against this build.
// Run (or write) a backtest against real settled games before trusting this
// for anything beyond passive side-by-side tracking on Track Record.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import {
  computeElo,
  eloWinProb,
  fetchSeasonResults,
  leagueRates,
  reshapeStaff,
  simulateMatchup,
  type BattingRates,
  type PitchingLine,
  type StarterInfo,
  type TeamRates,
} from "./mlb-sim";
import { fetchAllRelieverLines } from "./mlb-bullpen";
import { fetchLineupBatting } from "./mlb-lineup";
import { MODEL_VERSION_RECENT, MODEL_VERSION_RECENT_V2 } from "./mlb-models";

export { MODEL_VERSION_RECENT, MODEL_VERSION_RECENT_V2 };

const TEAM_WINDOW_DAYS = 21; // offense/bullpen trailing form
const STARTER_WINDOW_DAYS = 45; // ~6-9 starts
const PEN_WINDOW_DAYS = 30; // relievers accumulate BF slowly → a touch wider than the team window
const LINEUP_WINDOW_DAYS = 30; // per-hitter recent form (regressed); wider than 21d to firm up small PA

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Team batting/staff rates over the trailing `windowDays` ending the day
 * before `date` (no lookahead). Mirrors fetchAllTeamRates (mlb-sim.ts) —
 * same parsing, same `stats=byDateRange` mechanism already proven against
 * the real API in scripts/backtest-odds-blend.ts, just a short window
 * instead of season-to-date.
 */
export async function fetchAllTeamRatesRecent(
  season: number,
  date: string,
  windowDays = TEAM_WINDOW_DAYS,
): Promise<Map<number, TeamRates>> {
  const endDate = addDaysISO(date, -1);
  const startDate = addDaysISO(date, -windowDays);
  const base = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=byDateRange&startDate=${startDate}&endDate=${endDate}`;
  const [hitRes, pitRes] = await Promise.all([
    fetchWithTimeout(`${base}&group=hitting`, 30_000),
    fetchWithTimeout(`${base}&group=pitching`, 30_000),
  ]);
  const map = new Map<number, TeamRates>();
  const init = (id: number) => {
    let r = map.get(id);
    if (!r) {
      r = { batting: null, staff: null };
      map.set(id, r);
    }
    return r;
  };
  if (hitRes.ok) {
    try {
      const j: any = await hitRes.json();
      for (const s of j?.stats?.[0]?.splits ?? []) {
        const id = s?.team?.id;
        const st = s?.stat;
        if (!id || !st) continue;
        const pa = st.plateAppearances ?? 0;
        if (pa < 100) continue;
        const h = st.hits ?? 0;
        const d2 = st.doubles ?? 0;
        const d3 = st.triples ?? 0;
        const hr = st.homeRuns ?? 0;
        init(id).batting = {
          pa,
          bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / pa,
          so: (st.strikeOuts ?? 0) / pa,
          b1: (h - d2 - d3 - hr) / pa,
          b2: d2 / pa,
          b3: d3 / pa,
          hr: hr / pa,
        };
      }
    } catch {
      // batting stays unset for affected teams → simulateMatchup falls back to league rates
    }
  }
  if (pitRes.ok) {
    try {
      const j: any = await pitRes.json();
      for (const s of j?.stats?.[0]?.splits ?? []) {
        const id = s?.team?.id;
        const st = s?.stat;
        if (!id || !st) continue;
        const bf = st.battersFaced ?? 0;
        if (bf < 100) continue;
        const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
        init(id).staff = {
          so: (st.strikeOuts ?? 0) / bf,
          bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / bf,
          hr: (st.homeRuns ?? 0) / bf,
          b1: hNonHr / bf, // total non-HR hit rate; reshaped by reshapeStaff
          b2: 0,
          b3: 0,
        };
      }
    } catch {
      // staff stays unset → reshapeStaff(null, lg) below returns null → league rates
    }
  }
  return map;
}

/** Combine duplicate split rows for a pitcher traded mid-window (mirrors scripts/backtest-odds-blend.ts's pickSplit). */
function pickSplit(splits: any[]): any | null {
  if (!splits || splits.length === 0) return null;
  const combined = splits.find((s) => (s.numTeams ?? 1) > 1);
  if (combined) return combined.stat;
  const byTeam = new Map<string, any>();
  for (const s of splits) byTeam.set(String(s?.team?.id ?? "?"), s.stat);
  const stats = Array.from(byTeam.values());
  if (stats.length === 1) return stats[0];
  const sum: any = {};
  const numeric = [
    "battersFaced",
    "strikeOuts",
    "baseOnBalls",
    "hitByPitch",
    "hits",
    "homeRuns",
    "gamesStarted",
  ];
  for (const k of numeric) sum[k] = stats.reduce((a, s) => a + (s[k] ?? 0), 0);
  let outs = 0;
  for (const s of stats) {
    const parts = String(s.inningsPitched ?? "0.0").split(".");
    outs += (parseInt(parts[0], 10) || 0) * 3 + (parts[1] ? parseInt(parts[1], 10) : 0);
  }
  sum.inningsPitched = `${Math.floor(outs / 3)}.${outs % 3}`;
  return sum;
}

/** Starter line over the trailing `windowDays` (mirrors fetchStarterInfo, mlb-sim.ts). */
export async function fetchStarterInfoRecent(
  personId: number,
  season: number,
  date: string,
  lg: BattingRates,
  windowDays = STARTER_WINDOW_DAYS,
): Promise<StarterInfo | null> {
  try {
    const endDate = addDaysISO(date, -1);
    const startDate = addDaysISO(date, -windowDays);
    const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=pitching&season=${season}&startDate=${startDate}&endDate=${endDate}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json: any = await res.json();
    const st = pickSplit(json?.stats?.[0]?.splits ?? []);
    if (!st) return null;
    const bf = st.battersFaced ?? 0;
    const PRIOR_BF = 70; // same regression-to-league-mean prior as the season version
    const reg = (count: number, lgRate: number) => (count + lgRate * PRIOR_BF) / (bf + PRIOR_BF);
    const lgHits = lg.b1 + lg.b2 + lg.b3;
    const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
    const hRate = reg(hNonHr, lgHits);
    const line: PitchingLine = {
      so: reg(st.strikeOuts ?? 0, lg.so),
      bb: reg((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0), lg.bb),
      hr: reg(st.homeRuns ?? 0, lg.hr),
      b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
      b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
      b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
    };
    const starts = st.gamesStarted ?? 0;
    const ipStr: string = st.inningsPitched ?? "0.0";
    const parts = ipStr.split(".");
    const outs = (parseInt(parts[0], 10) || 0) * 3 + (parts[1] ? parseInt(parts[1], 10) : 0);
    const expectedOuts =
      starts > 0 ? Math.min(21, Math.max(9, (outs + 15.5 * 3) / (starts + 3))) : 15.5;
    return { line, expectedOuts };
  } catch {
    return null;
  }
}

export interface RecentFormGamePrediction {
  gameId: number;
  homeId: number;
  awayId: number;
  recentSimProb: number;
  eloProb: number;
  ensembleProb: number;
  rationale: string[];
}

/**
 * Predict every game on `date` using trailing-window batting/staff/starter
 * rates blended with the same multi-season Elo sim-elo-v2 uses. Mirrors
 * buildSimPredictionsForDate's orchestration (mlb-sim.ts) with the
 * season-to-date rate fetches swapped for trailing-window ones.
 */
export async function buildRecentFormPredictionsForDate(
  date: string,
  nSims = 3000,
): Promise<RecentFormGamePrediction[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue&startDate=${date}&endDate=${date}`;
  const [scheduleRes, prev2Results, prev1Results, seasonResults, teamRates] = await Promise.all([
    fetchWithTimeout(scheduleUrl),
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
    fetchSeasonResults(season, date),
    fetchAllTeamRatesRecent(season, date),
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];

  const elo = computeElo([prev2Results, prev1Results, seasonResults]);
  const lg = leagueRates(teamRates);

  const pitcherIds = new Set<number>();
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }
  const starters = new Map<number, StarterInfo | null>();
  await Promise.all(
    Array.from(pitcherIds).map(async (id) => {
      starters.set(id, await fetchStarterInfoRecent(id, season, date, lg));
    }),
  );

  const logitFn = (p: number) => Math.log(p / (1 - p));
  const sigmoidFn = (x: number) => 1 / (1 + Math.exp(-x));
  const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

  return games.map((g: any): RecentFormGamePrediction => {
    const homeTeam = g.teams.home.team;
    const awayTeam = g.teams.away.team;
    const rates = (id: number): TeamRates => teamRates.get(id) ?? { batting: null, staff: null };
    const hRates = rates(homeTeam.id);
    const aRates = rates(awayTeam.id);
    const hp = g.teams.home.probablePitcher?.id;
    const ap = g.teams.away.probablePitcher?.id;
    const venue: string | null = g.venue?.name ?? null;

    const recentSimProb = simulateMatchup(
      {
        homeBatting: hRates.batting ?? lg,
        awayBatting: aRates.batting ?? lg,
        homeStarter: (hp && starters.get(hp)) || null,
        awayStarter: (ap && starters.get(ap)) || null,
        homeStaff: reshapeStaff(hRates.staff, lg),
        awayStaff: reshapeStaff(aRates.staff, lg),
        league: lg,
        venue,
      },
      nSims,
      2_000_000 + g.gamePk, // distinct seed space from sim-elo-v2's (1000+gamePk)
    );

    const homeElo = elo.get(homeTeam.id) ?? 1500;
    const awayElo = elo.get(awayTeam.id) ?? 1500;
    const eloProb = eloWinProb(homeElo, awayElo);
    const ensembleProb = sigmoidFn((logitFn(clamp01(recentSimProb)) + logitFn(clamp01(eloProb))) / 2);

    return {
      gameId: g.gamePk,
      homeId: homeTeam.id,
      awayId: awayTeam.id,
      recentSimProb,
      eloProb,
      ensembleProb,
      rationale: [
        `Recent-form Monte Carlo (last ${TEAM_WINDOW_DAYS}d, ${nSims} sims): home wins ${(recentSimProb * 100).toFixed(1)}%`,
        `Elo ${homeElo.toFixed(0)} vs ${awayElo.toFixed(0)} → ${(eloProb * 100).toFixed(1)}%`,
        `Ensemble (logit mean) → ${(ensembleProb * 100).toFixed(1)}%`,
      ],
    };
  });
}

// ─── sim-recent-v2 ───────────────────────────────────────────────────────────
//
// The next iteration of the sim-recent line: everything sim-recent-v1 does
// (trailing-window team form + multi-season Elo), with two inputs upgraded over
// the same recent-form philosophy —
//   · bullpen: a relievers-only line (mlb-bullpen.ts) over a 30-day window,
//     instead of the trailing full-staff line, and
//   · offense: a lineup-derived line (mlb-lineup.ts) — the nine hitters in the
//     posted batting order, their recent bats — instead of the team aggregate.
// Each falls back to the sim-recent-v1 input when it can't be reconstructed
// (thin pen sample, or no lineup posted yet at cron time). One model, the
// evolution of sim-recent — compared against sim-recent-v1 and the headline
// sim-elo-v2, never a separate parallel algorithm.

export interface RecentFormV2GamePrediction extends RecentFormGamePrediction {
  usedReliever: boolean; // a real reliever line was used for at least one side
  usedLineup: boolean; // a posted lineup was used for at least one side
}

/**
 * Predict every game on `date` with the sim-recent engine plus the relievers-
 * only pen and lineup-derived offense (both over trailing windows). Mirrors
 * buildRecentFormPredictionsForDate's orchestration; adds the pen + lineup
 * fetches and swaps them in, per input, with fallback to the v1 team lines.
 */
export async function buildRecentFormV2PredictionsForDate(
  date: string,
  nSims = 3000,
): Promise<RecentFormV2GamePrediction[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue&startDate=${date}&endDate=${date}`;
  const [scheduleRes, prev2Results, prev1Results, seasonResults, teamRates] = await Promise.all([
    fetchWithTimeout(scheduleUrl),
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
    fetchSeasonResults(season, date),
    fetchAllTeamRatesRecent(season, date),
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];

  const elo = computeElo([prev2Results, prev1Results, seasonResults]);
  const lg = leagueRates(teamRates);

  const teamIds = new Set<number>();
  const pitcherIds = new Set<number>();
  for (const g of games) {
    teamIds.add(g.teams.home.team.id);
    teamIds.add(g.teams.away.team.id);
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }

  const [starters, relievers, lineupByGame] = await Promise.all([
    (async () => {
      const m = new Map<number, StarterInfo | null>();
      await Promise.all(
        Array.from(pitcherIds).map(async (id) => {
          m.set(id, await fetchStarterInfoRecent(id, season, date, lg));
        }),
      );
      return m;
    })(),
    fetchAllRelieverLines(Array.from(teamIds), season, date, lg, PEN_WINDOW_DAYS),
    (async () => {
      const m = new Map<number, { home: BattingRates | null; away: BattingRates | null }>();
      await batchedAll(
        games.map((g) => async () => {
          m.set(g.gamePk, await fetchLineupBatting(g.gamePk, season, date, lg, LINEUP_WINDOW_DAYS));
        }),
        6,
      );
      return m;
    })(),
  ]);

  const logitFn = (p: number) => Math.log(p / (1 - p));
  const sigmoidFn = (x: number) => 1 / (1 + Math.exp(-x));
  const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

  return games.map((g: any): RecentFormV2GamePrediction => {
    const homeTeam = g.teams.home.team;
    const awayTeam = g.teams.away.team;
    const rates = (id: number): TeamRates => teamRates.get(id) ?? { batting: null, staff: null };
    const hRates = rates(homeTeam.id);
    const aRates = rates(awayTeam.id);
    const hp = g.teams.home.probablePitcher?.id;
    const ap = g.teams.away.probablePitcher?.id;
    const venue: string | null = g.venue?.name ?? null;

    const lineup = lineupByGame.get(g.gamePk) ?? { home: null, away: null };
    const homePen = relievers.get(homeTeam.id) ?? null;
    const awayPen = relievers.get(awayTeam.id) ?? null;

    const recentSimProb = simulateMatchup(
      {
        homeBatting: lineup.home ?? hRates.batting ?? lg,
        awayBatting: lineup.away ?? aRates.batting ?? lg,
        homeStarter: (hp && starters.get(hp)) || null,
        awayStarter: (ap && starters.get(ap)) || null,
        homeStaff: homePen ?? reshapeStaff(hRates.staff, lg),
        awayStaff: awayPen ?? reshapeStaff(aRates.staff, lg),
        league: lg,
        venue,
      },
      nSims,
      5_000_000 + g.gamePk, // distinct seed space from sim-elo-v2 / sim-recent-v1
    );

    const homeElo = elo.get(homeTeam.id) ?? 1500;
    const awayElo = elo.get(awayTeam.id) ?? 1500;
    const eloProb = eloWinProb(homeElo, awayElo);
    const ensembleProb = sigmoidFn((logitFn(clamp01(recentSimProb)) + logitFn(clamp01(eloProb))) / 2);

    return {
      gameId: g.gamePk,
      homeId: homeTeam.id,
      awayId: awayTeam.id,
      recentSimProb,
      eloProb,
      ensembleProb,
      usedReliever: homePen != null || awayPen != null,
      usedLineup: lineup.home != null || lineup.away != null,
      rationale: [
        `Recent-form Monte Carlo (last ${TEAM_WINDOW_DAYS}d form, relievers-only pen, lineup offense, ${nSims} sims): home wins ${(recentSimProb * 100).toFixed(1)}%`,
        `Elo ${homeElo.toFixed(0)} vs ${awayElo.toFixed(0)} → ${(eloProb * 100).toFixed(1)}%`,
        `Ensemble (logit mean) → ${(ensembleProb * 100).toFixed(1)}%`,
      ],
    };
  });
}
