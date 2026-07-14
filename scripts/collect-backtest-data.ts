#!/usr/bin/env -S npx tsx
/**
 * Collector for the Round-7 factor study: one heavy, resumable pass over a date
 * range that records, per settled game, everything the model analyzer needs —
 * so candidate models become pure math over a local file instead of API sweeps.
 *
 *   npx tsx scripts/collect-backtest-data.ts [--start 2026-04-20] [--end 2026-07-11]
 *                                            [--sims 3000] [--out .backtest-cache/records.jsonl]
 *
 * Per game it stores (all strictly point-in-time, production seeds):
 *   - The three tracked models' Monte-Carlo components and ensembles:
 *       v1 sim-elo-v2      season rates + season starter          (seed 1000    + pk)
 *       v2 sim-recent-v1   trailing rates + trailing starter      (seed 2000000 + pk)
 *       v3 sim-recent-v2   v2 + leverage-tiered relievers pen     (seed 5000000 + pk)
 *     plus the shared multi-season Elo probability.
 *   - The devigged DraftKings moneyline via ESPN (doubleheader-safe matching).
 *   - Schedule/context factors computed from season results (no extra calls):
 *     rest days, games in last 7, last-10 win%, win streak, trailing-30d runs
 *     scored/allowed, road-trip length.
 *   - Starter context from game logs (globally cached): days since last start,
 *     runs-per-out over the last 3 starts.
 *   - Game start hour (UTC) for day/night splits.
 *
 * Resumable: dates already present in the output JSONL are skipped, so a
 * network hiccup only costs the in-flight date. Read-only against MLB/ESPN;
 * never touches Supabase.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  computeElo,
  eloWinProb,
  fetchSeasonResults,
  leagueRates,
  reshapeStaff,
  simulateMatchup,
  type BattingRates,
  type PitchingLine,
  type SeasonGameResult,
  type StarterInfo,
  type TeamRates,
} from "../src/lib/mlb-sim";
import { fetchAllTeamRatesRecent, fetchStarterInfoRecent } from "../src/lib/mlb-recent-form";
import { fetchAllBullpens, type Appearance } from "../src/lib/mlb-bullpen";
import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";
import { devig, fetchMoneylineForEvent } from "../src/lib/mlb-odds.server";

const PEN_WINDOW_DAYS = 30; // must match mlb-recent-form.ts

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const ensemble = (pSim: number, pElo: number) =>
  sigmoid((logit(clamp01(pSim)) + logit(clamp01(pElo))) / 2);

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dayBefore = (d: string) => addDaysISO(d, -1);

function daysBetween(aISO: string, bISO: string): number {
  return Math.round(
    (new Date(bISO + "T00:00:00Z").getTime() - new Date(aISO + "T00:00:00Z").getTime()) / 86400000,
  );
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ─── Point-in-time season-to-date rates + starter (copied from backtest-shadow-models) ─

async function fetchAllTeamRatesAsOf(season: number, endDate: string): Promise<Map<number, TeamRates>> {
  const base = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=byDateRange&startDate=${season}-03-01&endDate=${endDate}`;
  const [hitRes, pitRes] = await Promise.all([
    fetchWithTimeout(`${base}&group=hitting`, 30_000),
    fetchWithTimeout(`${base}&group=pitching`, 30_000),
  ]);
  const map = new Map<number, TeamRates>();
  const init = (id: number) => {
    let r = map.get(id);
    if (!r) map.set(id, (r = { batting: null, staff: null }));
    return r;
  };
  if (hitRes.ok) {
    const j: any = await hitRes.json();
    for (const s of j?.stats?.[0]?.splits ?? []) {
      const id = s?.team?.id, st = s?.stat;
      if (!id || !st) continue;
      const pa = st.plateAppearances ?? 0;
      if (pa < 100) continue;
      const h = st.hits ?? 0, d2 = st.doubles ?? 0, d3 = st.triples ?? 0, hr = st.homeRuns ?? 0;
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
  }
  if (pitRes.ok) {
    const j: any = await pitRes.json();
    for (const s of j?.stats?.[0]?.splits ?? []) {
      const id = s?.team?.id, st = s?.stat;
      if (!id || !st) continue;
      const bf = st.battersFaced ?? 0;
      if (bf < 100) continue;
      const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
      init(id).staff = {
        so: (st.strikeOuts ?? 0) / bf,
        bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / bf,
        hr: (st.homeRuns ?? 0) / bf,
        b1: hNonHr / bf,
        b2: 0,
        b3: 0,
      };
    }
  }
  return map;
}

function pickSplit(splits: any[]): any | null {
  if (!splits || splits.length === 0) return null;
  const combined = splits.find((s) => (s.numTeams ?? 1) > 1);
  if (combined) return combined.stat;
  const byTeam = new Map<string, any>();
  for (const s of splits) byTeam.set(String(s?.team?.id ?? "?"), s.stat);
  const stats = Array.from(byTeam.values());
  if (stats.length === 1) return stats[0];
  const sum: any = {};
  for (const k of ["battersFaced", "strikeOuts", "baseOnBalls", "hitByPitch", "hits", "homeRuns", "gamesStarted"])
    sum[k] = stats.reduce((a, s) => a + (s[k] ?? 0), 0);
  let outs = 0;
  for (const s of stats) {
    const p = String(s.inningsPitched ?? "0.0").split(".");
    outs += (parseInt(p[0], 10) || 0) * 3 + (p[1] ? parseInt(p[1], 10) : 0);
  }
  sum.inningsPitched = `${Math.floor(outs / 3)}.${outs % 3}`;
  return sum;
}

async function fetchStarterInfoAsOf(
  personId: number,
  season: number,
  endDate: string,
  lg: BattingRates,
): Promise<StarterInfo | null> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=pitching&season=${season}&startDate=${season}-03-01&endDate=${endDate}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const st = pickSplit((await res.json())?.stats?.[0]?.splits ?? []);
    if (!st) return null;
    const bf = st.battersFaced ?? 0;
    const PRIOR_BF = 70;
    const reg = (c: number, r: number) => (c + r * PRIOR_BF) / (bf + PRIOR_BF);
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
    const p = String(st.inningsPitched ?? "0.0").split(".");
    const outs = (parseInt(p[0], 10) || 0) * 3 + (p[1] ? parseInt(p[1], 10) : 0);
    const expectedOuts = starts > 0 ? Math.min(21, Math.max(9, (outs + 15.5 * 3) / (starts + 3))) : 15.5;
    return { line, expectedOuts };
  } catch {
    return null;
  }
}

// ─── Settled games (with names/venue/time for odds matching + factors) ────────

interface Game {
  gamePk: number;
  date: string;
  gameDate: string; // ISO datetime
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  venue: string | null;
  hp: number | null;
  ap: number | null;
  y: number;
}

async function fetchSettledGames(start: string, end: string): Promise<Game[]> {
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher,team,venue&startDate=${start}&endDate=${end}`;
  const res = await fetchWithTimeout(url, 45_000);
  if (!res.ok) throw new Error(`schedule ${res.status}`);
  const json: any = await res.json();
  const out: Game[] = [];
  for (const d of json?.dates ?? []) {
    for (const g of d?.games ?? []) {
      const status: string = g?.status?.detailedState ?? "";
      if (!/final|game over|completed/i.test(status)) continue;
      const hs = g?.teams?.home?.score, as = g?.teams?.away?.score;
      if (typeof hs !== "number" || typeof as !== "number" || hs === as) continue;
      out.push({
        gamePk: g.gamePk,
        date: d.date,
        gameDate: g.gameDate ?? "",
        homeId: g.teams.home.team.id,
        awayId: g.teams.away.team.id,
        homeName: g.teams.home.team.name ?? "",
        awayName: g.teams.away.team.name ?? "",
        venue: g.venue?.name ?? null,
        hp: g.teams.home.probablePitcher?.id ?? null,
        ap: g.teams.away.probablePitcher?.id ?? null,
        y: hs > as ? 1 : 0,
      });
    }
  }
  return out;
}

// ─── ESPN odds (doubleheader-safe matching, from backtest-odds-blend) ─────────

interface EspnEventFull {
  id: string;
  date: string;
  homeName: string;
  awayName: string;
}

async function fetchEspnEventsFull(date: string): Promise<EspnEventFull[]> {
  const compact = date.replaceAll("-", "");
  try {
    const res = await fetchWithTimeout(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${compact}`,
      15_000,
    );
    if (!res.ok) return [];
    const json: any = await res.json();
    const out: EspnEventFull[] = [];
    for (const e of json?.events ?? []) {
      const comp = e?.competitions?.[0];
      const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
      const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
      if (!home || !away) continue;
      out.push({
        id: e.id,
        date: e.date ?? "",
        homeName: home.team?.displayName ?? "",
        awayName: away.team?.displayName ?? "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Schedule/context factors from season results (no extra API calls) ────────

interface TeamDayFactors {
  rest: number | null; // full days off before this date (yesterday = 0), cap 5
  g7: number; // games played in the last 7 days
  l10: number | null; // last-10 win% (≥5 games required)
  stk: number; // signed win streak entering the day, cap ±6
  rs30: number; // runs scored, trailing 30 days
  ra30: number;
  g30: number;
  trip: number; // consecutive most-recent games away from home (0 if last game home)
}

function buildTeamHistories(results: SeasonGameResult[]) {
  const byTeam = new Map<number, Array<{ date: string; isHome: boolean; rs: number; ra: number; won: boolean }>>();
  const push = (id: number, g: { date: string; isHome: boolean; rs: number; ra: number; won: boolean }) => {
    const arr = byTeam.get(id) ?? [];
    arr.push(g);
    byTeam.set(id, arr);
  };
  for (const r of results) {
    push(r.home, { date: r.date, isHome: true, rs: r.homeScore, ra: r.awayScore, won: r.homeScore > r.awayScore });
    push(r.away, { date: r.date, isHome: false, rs: r.awayScore, ra: r.homeScore, won: r.awayScore > r.homeScore });
  }
  // results arrive date-sorted; per-team arrays inherit that order
  return byTeam;
}

function teamFactors(
  hist: Array<{ date: string; isHome: boolean; rs: number; ra: number; won: boolean }> | undefined,
  date: string,
): TeamDayFactors {
  if (!hist || hist.length === 0) {
    return { rest: null, g7: 0, l10: null, stk: 0, rs30: 0, ra30: 0, g30: 0, trip: 0 };
  }
  const last = hist[hist.length - 1];
  const rest = Math.min(5, Math.max(0, daysBetween(last.date, date) - 1));
  const from7 = addDaysISO(date, -7);
  const from30 = addDaysISO(date, -30);
  let g7 = 0, rs30 = 0, ra30 = 0, g30 = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const g = hist[i];
    if (g.date < from30) break;
    rs30 += g.rs;
    ra30 += g.ra;
    g30++;
    if (g.date >= from7) g7++;
  }
  const lastN = hist.slice(-10);
  const l10 = lastN.length >= 5 ? lastN.filter((g) => g.won).length / lastN.length : null;
  let stk = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (i === hist.length - 1) stk = hist[i].won ? 1 : -1;
    else if (hist[i].won === hist[hist.length - 1].won) stk += hist[i].won ? 1 : -1;
    else break;
    if (Math.abs(stk) >= 6) break;
  }
  let trip = 0;
  for (let i = hist.length - 1; i >= 0 && !hist[i].isHome; i--) trip++;
  return { rest, g7, l10, stk, rs30, ra30, g30, trip };
}

// ─── Starter context from game logs (globally cached) ─────────────────────────

interface StartLog {
  date: string;
  gs: number;
  outs: number;
  runs: number;
}

async function fetchStarterGameLog(personId: number, season: number): Promise<StartLog[]> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    return splits.map((s): StartLog => {
      const st = s.stat ?? {};
      const p = String(st.inningsPitched ?? "0.0").split(".");
      return {
        date: s.date ?? "",
        gs: st.gamesStarted ?? 0,
        outs: (parseInt(p[0], 10) || 0) * 3 + (p[1] ? parseInt(p[1], 10) : 0),
        runs: st.runs ?? 0,
      };
    });
  } catch {
    return [];
  }
}

function starterContext(log: StartLog[], date: string): { srest: number | null; sr3: number | null } {
  const starts = log.filter((a) => a.gs > 0 && a.date && a.date < date);
  if (starts.length === 0) return { srest: null, sr3: null };
  const last = starts[starts.length - 1];
  const srest = Math.min(12, daysBetween(last.date, date));
  const l3 = starts.slice(-3);
  const outs = l3.reduce((a, s) => a + s.outs, 0);
  const runs = l3.reduce((a, s) => a + s.runs, 0);
  return { srest, sr3: outs > 0 ? runs / outs : null };
}

// ─── The record we emit ───────────────────────────────────────────────────────

interface GameRecord {
  date: string;
  gamePk: number;
  homeId: number;
  awayId: number;
  venue: string | null;
  hourUTC: number | null;
  y: number;
  pSimV1: number;
  pSimV2: number;
  pSimV3: number;
  pElo: number;
  pV1: number;
  pV2: number;
  pV3: number;
  pMarket: number | null;
  mlHome: number | null;
  mlAway: number | null;
  f: {
    restH: number | null; restA: number | null;
    g7H: number; g7A: number;
    l10H: number | null; l10A: number | null;
    stkH: number; stkA: number;
    rs30H: number; ra30H: number; g30H: number;
    rs30A: number; ra30A: number; g30A: number;
    tripH: number; tripA: number;
    srestH: number | null; srestA: number | null;
    sr3H: number | null; sr3A: number | null;
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const start = arg("start", "2026-04-20");
  const end = arg("end", "2026-07-11");
  const nSims = parseInt(arg("sims", "3000"), 10);
  const outPath = arg("out", ".backtest-cache/records.jsonl");
  const season = parseInt(start.slice(0, 4), 10);

  mkdirSync(dirname(outPath), { recursive: true });
  const doneDates = new Set<string>();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        doneDates.add((JSON.parse(line) as GameRecord).date);
      } catch {
        /* tolerate a torn final line; that date will be redone */
      }
    }
  }

  console.log(`Window ${start} → ${end}, ${nSims} sims/game/model, out=${outPath}`);
  if (doneDates.size > 0) console.log(`  resuming — ${doneDates.size} date(s) already collected`);

  console.log("Loading settled games + prior-season results for Elo…");
  const [games, prev2, prev1] = await Promise.all([
    fetchSettledGames(start, end),
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
  ]);
  const byDate = new Map<string, Game[]>();
  for (const g of games) (byDate.get(g.date) ?? byDate.set(g.date, []).get(g.date)!).push(g);
  const dates = Array.from(byDate.keys()).sort();
  console.log(`  ${games.length} settled games across ${dates.length} dates (${prev2.length}+${prev1.length} prior results)`);

  // Cross-date caches: full-season logs are date-filtered downstream, so safe.
  const relieverLogCache = new Map<number, Appearance[]>();
  const starterLogCache = new Map<number, StartLog[]>();

  let collected = 0;
  for (const date of dates) {
    if (doneDates.has(date)) continue;
    const day = byDate.get(date)!;
    const before = dayBefore(date);
    const teamIds = Array.from(new Set(day.flatMap((g) => [g.homeId, g.awayId])));

    const [seasonResults, teamRatesSeason, teamRatesRecent, espnEvents] = await Promise.all([
      fetchSeasonResults(season, date),
      fetchAllTeamRatesAsOf(season, before),
      fetchAllTeamRatesRecent(season, date),
      fetchEspnEventsFull(date),
    ]);
    const elo = computeElo([prev2, prev1, seasonResults]);
    const lg = leagueRates(teamRatesSeason);
    const histories = buildTeamHistories(seasonResults);

    const pitcherIds = new Set<number>();
    for (const g of day) {
      if (g.hp) pitcherIds.add(g.hp);
      if (g.ap) pitcherIds.add(g.ap);
    }
    const startersSeason = new Map<number, StarterInfo | null>();
    const startersRecent = new Map<number, StarterInfo | null>();
    const [relievers] = await Promise.all([
      fetchAllBullpens(teamIds, season, date, lg, PEN_WINDOW_DAYS, relieverLogCache),
      batchedAll(
        Array.from(pitcherIds).map((id) => async () => {
          startersSeason.set(id, await fetchStarterInfoAsOf(id, season, before, lg));
        }),
        8,
      ),
      batchedAll(
        Array.from(pitcherIds).map((id) => async () => {
          startersRecent.set(id, await fetchStarterInfoRecent(id, season, date, lg));
        }),
        8,
      ),
      batchedAll(
        Array.from(pitcherIds).map((id) => async () => {
          if (!starterLogCache.has(id)) starterLogCache.set(id, await fetchStarterGameLog(id, season));
        }),
        8,
      ),
    ]);

    // Odds: group by name pair, zip chronologically (doubleheader-safe).
    const evByPair = new Map<string, EspnEventFull[]>();
    for (const e of espnEvents) {
      const k = `${e.awayName}@${e.homeName}`;
      (evByPair.get(k) ?? evByPair.set(k, []).get(k)!).push(e);
    }
    for (const arr of evByPair.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const gByPair = new Map<string, Game[]>();
    for (const g of day) {
      const k = `${g.awayName}@${g.homeName}`;
      (gByPair.get(k) ?? gByPair.set(k, []).get(k)!).push(g);
    }
    for (const arr of gByPair.values()) arr.sort((a, b) => (a.gameDate < b.gameDate ? -1 : 1));
    const oddsByGame = new Map<number, { mlHome: number; mlAway: number; pHome: number }>();
    const oddsTasks: Array<() => Promise<void>> = [];
    for (const [pair, arr] of gByPair) {
      const evs = evByPair.get(pair) ?? [];
      arr.forEach((g, i) => {
        const ev = evs[i];
        if (!ev) return;
        oddsTasks.push(async () => {
          const ml = await fetchMoneylineForEvent(ev.id);
          if (!ml) return;
          const { homeImpliedProb } = devig(ml.homeMoneyLine, ml.awayMoneyLine);
          oddsByGame.set(g.gamePk, { mlHome: ml.homeMoneyLine, mlAway: ml.awayMoneyLine, pHome: homeImpliedProb });
        });
      });
    }
    await batchedAll(oddsTasks, 8);

    const lines: string[] = [];
    for (const g of day) {
      const sR = (m: Map<number, TeamRates>, id: number) => m.get(id) ?? { batting: null, staff: null };
      const hSeason = sR(teamRatesSeason, g.homeId), aSeason = sR(teamRatesSeason, g.awayId);
      const hRecent = sR(teamRatesRecent, g.homeId), aRecent = sR(teamRatesRecent, g.awayId);
      const hPen = relievers.get(g.homeId) ?? null, aPen = relievers.get(g.awayId) ?? null;
      const pElo = eloWinProb(elo.get(g.homeId) ?? 1500, elo.get(g.awayId) ?? 1500);

      const pSimV1 = simulateMatchup(
        {
          homeBatting: hSeason.batting ?? lg,
          awayBatting: aSeason.batting ?? lg,
          homeStarter: (g.hp && startersSeason.get(g.hp)) || null,
          awayStarter: (g.ap && startersSeason.get(g.ap)) || null,
          homeStaff: reshapeStaff(hSeason.staff, lg),
          awayStaff: reshapeStaff(aSeason.staff, lg),
          league: lg,
          venue: g.venue,
        },
        nSims,
        1000 + g.gamePk,
      );
      const pSimV2 = simulateMatchup(
        {
          homeBatting: hRecent.batting ?? lg,
          awayBatting: aRecent.batting ?? lg,
          homeStarter: (g.hp && startersRecent.get(g.hp)) || null,
          awayStarter: (g.ap && startersRecent.get(g.ap)) || null,
          homeStaff: reshapeStaff(hRecent.staff, lg),
          awayStaff: reshapeStaff(aRecent.staff, lg),
          league: lg,
          venue: g.venue,
        },
        nSims,
        2_000_000 + g.gamePk,
      );
      const pSimV3 = simulateMatchup(
        {
          homeBatting: hRecent.batting ?? lg,
          awayBatting: aRecent.batting ?? lg,
          homeStarter: (g.hp && startersRecent.get(g.hp)) || null,
          awayStarter: (g.ap && startersRecent.get(g.ap)) || null,
          homeStaff: reshapeStaff(hRecent.staff, lg),
          awayStaff: reshapeStaff(aRecent.staff, lg),
          homePenTiers: hPen,
          awayPenTiers: aPen,
          league: lg,
          venue: g.venue,
        },
        nSims,
        5_000_000 + g.gamePk,
      );

      const fH = teamFactors(histories.get(g.homeId), date);
      const fA = teamFactors(histories.get(g.awayId), date);
      const scH = starterContext(g.hp ? (starterLogCache.get(g.hp) ?? []) : [], date);
      const scA = starterContext(g.ap ? (starterLogCache.get(g.ap) ?? []) : [], date);
      const odds = oddsByGame.get(g.gamePk) ?? null;
      const hour = g.gameDate ? new Date(g.gameDate).getUTCHours() : null;

      const rec: GameRecord = {
        date,
        gamePk: g.gamePk,
        homeId: g.homeId,
        awayId: g.awayId,
        venue: g.venue,
        hourUTC: hour,
        y: g.y,
        pSimV1,
        pSimV2,
        pSimV3,
        pElo,
        pV1: ensemble(pSimV1, pElo),
        pV2: ensemble(pSimV2, pElo),
        pV3: ensemble(pSimV3, pElo),
        pMarket: odds?.pHome ?? null,
        mlHome: odds?.mlHome ?? null,
        mlAway: odds?.mlAway ?? null,
        f: {
          restH: fH.rest, restA: fA.rest,
          g7H: fH.g7, g7A: fA.g7,
          l10H: fH.l10, l10A: fA.l10,
          stkH: fH.stk, stkA: fA.stk,
          rs30H: fH.rs30, ra30H: fH.ra30, g30H: fH.g30,
          rs30A: fA.rs30, ra30A: fA.ra30, g30A: fA.g30,
          tripH: fH.trip, tripA: fA.trip,
          srestH: scH.srest, srestA: scA.srest,
          sr3H: scH.sr3, sr3A: scA.sr3,
        },
      };
      lines.push(JSON.stringify(rec));
    }
    appendFileSync(outPath, lines.join("\n") + "\n");
    collected += day.length;
    const withOdds = day.filter((g) => oddsByGame.has(g.gamePk)).length;
    console.log(
      `  ${date}: ${day.length} games (odds ${withOdds}/${day.length}) · ${collected} new · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
  }
  console.log(`\nDone — ${collected} new games appended in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
}

main().catch((err) => {
  console.error("💥 collect failed:", err);
  process.exit(1);
});
