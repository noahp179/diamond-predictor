#!/usr/bin/env bun
/**
 * Backtest Algorithm V2 (sim-elo-v3) against sim-elo-v2 on real games, with
 * strictly point-in-time inputs. Needs network access to statsapi.mlb.com
 * (and site.api.espn.com for the optional market comparison) — run it from a
 * machine that can reach them:
 *
 *   bun scripts/backtest-v3.ts --window dev              # tuning window
 *   bun scripts/backtest-v3.ts --window test             # frozen holdout
 *   bun scripts/backtest-v3.ts --start 2026-06-01 --end 2026-06-20
 *   bun scripts/backtest-v3.ts --window dev --tune       # coefficient search
 *
 * Flags: --out results.json   write full per-game results
 *        --no-odds            skip the ESPN market comparison
 *        --nsims N            sims per game (default 3000, the prod value)
 *        --limit-dates N      first N dates only (smoke test)
 *        --tune               staged grid search on this window (see below)
 *
 * Protocol (pre-registered in MODEL-ANALYSIS.md Round 4):
 *   dev  = 2026-04-15 → 2026-07-01   tune anything here
 *   test = 2026-07-02 → 2026-07-11   score once, frozen — never tuned on
 *
 * Point-in-time discipline, mirroring scripts/backtest-odds-blend.ts:
 *   · standings/rates via byDateRange ending the day BEFORE each game day
 *   · Elo replayed from 2024 through the morning of each game day
 *   · starter identity from that date's schedule probables
 *   · starter game logs filtered to starts strictly before the game day
 *   · settled games and results straight from the MLB schedule API — no
 *     Supabase required (works from a fresh clone with zero secrets)
 *
 * Everything fetched is cached under .backtest-cache/ (gitignored), so
 * re-runs and --tune sweeps are fast and hit the APIs once.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATS_API, batchedAll, fetchWithTimeout } from "../src/lib/mlb-core";
import {
  computeElo,
  eloWinProb,
  fetchSeasonResults,
  leagueRates,
  type BattingRates,
  type PitchingLine,
  type StarterInfo,
  type TeamRates,
} from "../src/lib/mlb-sim";
import type { SeasonGame, StarterLogEntry, TeamLines } from "../src/lib/mlb-sos";
import {
  CONTEXT_DISABLED,
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from "../src/lib/mlb-context";
import {
  DEFAULT_V3_CONFIG,
  fetchTeamHomeVenues,
  predictV3Game,
  toTeamLines,
  V3_AS_V2_CONFIG,
  type V3Config,
  type V3Env,
} from "../src/lib/mlb-v3";
import { devig, fetchMoneylineForEvent } from "../src/lib/mlb-odds.server";
import { blendWithMarket, MARKET_BLEND_WEIGHT } from "../src/lib/mlb-blend";

// ─── Windows ──────────────────────────────────────────────────────────────────

const WINDOWS: Record<string, { start: string; end: string }> = {
  dev: { start: "2026-04-15", end: "2026-07-01" },
  test: { start: "2026-07-02", end: "2026-07-11" },
};

// ─── Tiny disk cache (immutable historical URLs only) ────────────────────────

const CACHE_DIR = ".backtest-cache";

function cachePath(key: string): string {
  return join(CACHE_DIR, createHash("sha1").update(key).digest("hex") + ".json");
}

async function cachedJson(url: string, timeoutMs = 30_000, key = url): Promise<any | null> {
  const p = cachePath(key);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* refetch */
    }
  }
  try {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) return null;
    const json = await res.json();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(json));
    return json;
  } catch {
    return null;
  }
}

// ─── Point-in-time fetchers ───────────────────────────────────────────────────

function dayBefore(date: string): string {
  return new Date(new Date(date + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
}

/** Season-to-date team rates as of `endDate` (byDateRange), as TeamRates. */
async function fetchTeamRatesAsOf(
  season: number,
  endDate: string,
): Promise<Map<number, TeamRates>> {
  const base = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=byDateRange&startDate=${season}-03-01&endDate=${endDate}`;
  const [hit, pit] = await Promise.all([
    cachedJson(`${base}&group=hitting`),
    cachedJson(`${base}&group=pitching`),
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
  for (const s of hit?.stats?.[0]?.splits ?? []) {
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
  for (const s of pit?.stats?.[0]?.splits ?? []) {
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
      b1: hNonHr / bf, // total non-HR hits; reshaped by toTeamLines
      b2: 0,
      b3: 0,
    };
  }
  return map;
}

/**
 * Merge a traded pitcher's per-team splits (duplicated rows for one team,
 * separate rows per team otherwise) — same handling as backtest-odds-blend.
 */
function pickSplit(splits: any[]): any | null {
  if (!splits || splits.length === 0) return null;
  const combined = splits.find((s) => (s.numTeams ?? 1) > 1);
  if (combined) return combined.stat;
  const byTeam = new Map<string, any>();
  for (const s of splits) byTeam.set(String(s?.team?.id ?? "?"), s.stat);
  const stats = Array.from(byTeam.values());
  if (stats.length === 1) return stats[0];
  const sum: any = {};
  for (const k of [
    "battersFaced",
    "strikeOuts",
    "baseOnBalls",
    "hitByPitch",
    "hits",
    "homeRuns",
    "gamesStarted",
  ]) {
    sum[k] = stats.reduce((a, s) => a + (s[k] ?? 0), 0);
  }
  let outs = 0;
  for (const s of stats) {
    const parts = String(s.inningsPitched ?? "0.0").split(".");
    outs += (parseInt(parts[0], 10) || 0) * 3 + (parts[1] ? parseInt(parts[1], 10) : 0);
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
  const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=pitching&season=${season}&startDate=${season}-03-01&endDate=${endDate}`;
  const json = await cachedJson(url, 15_000);
  const st = pickSplit(json?.stats?.[0]?.splits ?? []);
  if (!st) return null;
  const bf = st.battersFaced ?? 0;
  const PRIOR_BF = 70;
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
}

/** Full-season pitcher game log (immutable history), cached per window end. */
async function fetchStarterLogCached(
  personId: number,
  season: number,
  windowEnd: string,
): Promise<StarterLogEntry[]> {
  const url = `${STATS_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
  const json = await cachedJson(url, 15_000, `${url}@${windowEnd}`);
  const out: StarterLogEntry[] = [];
  for (const s of json?.stats?.[0]?.splits ?? []) {
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
}

/** Season finals with venue + innings, one cached call per window. */
async function fetchSeasonGamesCached(season: number, throughEnd: string): Promise<SeasonGame[]> {
  const fields =
    "dates,date,games,gamePk,status,detailedState,teams,home,away,team,id,score,venue,name,linescore,currentInning";
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&startDate=${season}-03-01&endDate=${throughEnd}&hydrate=linescore&fields=${fields}`;
  const json = await cachedJson(url, 60_000);
  const out: SeasonGame[] = [];
  for (const d of json?.dates ?? []) {
    for (const g of d?.games ?? []) {
      const status: string = g?.status?.detailedState ?? "";
      if (!/final|game over|completed/i.test(status)) continue;
      const hs = g?.teams?.home?.score;
      const as = g?.teams?.away?.score;
      if (typeof hs !== "number" || typeof as !== "number" || hs === as) continue;
      const inn = g?.linescore?.currentInning;
      out.push({
        date: d.date,
        home: g.teams.home.team.id,
        away: g.teams.away.team.id,
        homeScore: hs,
        awayScore: as,
        venue: g?.venue?.name ?? null,
        innings: typeof inn === "number" && inn > 0 ? inn : null,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

interface DayGame {
  gameId: number;
  date: string;
  gameDate: string;
  venue: string | null;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  homePitcherId: number | null;
  awayPitcherId: number | null;
  winner: "home" | "away";
  y: number;
}

/** One date's settled slate with probables, straight from the schedule API. */
async function fetchDaySlate(date: string): Promise<DayGame[]> {
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher,team,venue&startDate=${date}&endDate=${date}`;
  const json = await cachedJson(url, 30_000);
  const out: DayGame[] = [];
  for (const g of json?.dates?.[0]?.games ?? []) {
    const status: string = g?.status?.detailedState ?? "";
    if (!/final|game over|completed/i.test(status)) continue;
    const hs = g?.teams?.home?.score;
    const as = g?.teams?.away?.score;
    if (typeof hs !== "number" || typeof as !== "number" || hs === as) continue;
    out.push({
      gameId: g.gamePk,
      date,
      gameDate: g.gameDate ?? date,
      venue: g?.venue?.name ?? null,
      homeId: g.teams.home.team.id,
      awayId: g.teams.away.team.id,
      homeName: g.teams.home.team.name,
      awayName: g.teams.away.team.name,
      homePitcherId: g.teams.home.probablePitcher?.id ?? null,
      awayPitcherId: g.teams.away.probablePitcher?.id ?? null,
      winner: hs > as ? "home" : "away",
      y: hs > as ? 1 : 0,
    });
  }
  return out;
}

// ─── ESPN odds (optional, cached) ─────────────────────────────────────────────

interface DayOdds {
  mlHome: number;
  mlAway: number;
  pHome: number; // devigged
}

async function fetchDayOdds(date: string, games: DayGame[]): Promise<Map<number, DayOdds>> {
  const out = new Map<number, DayOdds>();
  const compact = date.replaceAll("-", "");
  const sb = await cachedJson(
    `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${compact}`,
    15_000,
  );
  if (!sb) return out;
  interface Ev {
    id: string;
    date: string;
    homeName: string;
    awayName: string;
  }
  const events: Ev[] = [];
  for (const e of sb?.events ?? []) {
    const comp = e?.competitions?.[0];
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;
    events.push({
      id: e.id,
      date: e.date ?? "",
      homeName: home.team?.displayName ?? "",
      awayName: away.team?.displayName ?? "",
    });
  }
  // Doubleheader-safe: zip same-name-pair games and events chronologically.
  const evByPair = new Map<string, Ev[]>();
  for (const e of events) {
    const k = `${e.awayName}@${e.homeName}`;
    (evByPair.get(k) ?? evByPair.set(k, []).get(k)!).push(e);
  }
  for (const arr of evByPair.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  const gByPair = new Map<string, DayGame[]>();
  for (const g of games) {
    const k = `${g.awayName}@${g.homeName}`;
    (gByPair.get(k) ?? gByPair.set(k, []).get(k)!).push(g);
  }
  for (const arr of gByPair.values()) arr.sort((a, b) => (a.gameDate < b.gameDate ? -1 : 1));

  const tasks: Array<() => Promise<void>> = [];
  for (const [pair, arr] of gByPair) {
    const evs = evByPair.get(pair) ?? [];
    arr.forEach((g, i) => {
      const ev = evs[i];
      if (!ev) return;
      tasks.push(async () => {
        // fetchMoneylineForEvent is not cached internally; cache the summary here.
        const summary = await cachedJson(
          `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${ev.id}`,
          15_000,
        );
        const line = summary?.pickcenter?.[0];
        const home = line?.homeTeamOdds?.moneyLine;
        const away = line?.awayTeamOdds?.moneyLine;
        if (typeof home !== "number" || typeof away !== "number") {
          // Fall back to the live helper in case the response shape moved.
          const ml = await fetchMoneylineForEvent(ev.id);
          if (!ml) return;
          const { homeImpliedProb } = devig(ml.homeMoneyLine, ml.awayMoneyLine);
          out.set(g.gameId, {
            mlHome: ml.homeMoneyLine,
            mlAway: ml.awayMoneyLine,
            pHome: homeImpliedProb,
          });
          return;
        }
        const { homeImpliedProb } = devig(home, away);
        out.set(g.gameId, { mlHome: home, mlAway: away, pHome: homeImpliedProb });
      });
    });
  }
  await batchedAll(tasks, 8);
  return out;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

interface Metrics {
  n: number;
  acc: number;
  brier: number;
  logLoss: number;
}

function metrics(pairs: Array<[number, number]>): Metrics {
  const eps = 1e-7;
  let acc = 0;
  let brier = 0;
  let ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = pairs.length;
  return { n, acc: acc / n, brier: brier / n, logLoss: ll / n };
}

/** Paired bootstrap on the per-game Brier difference (a − b). */
function bootstrapBrierDelta(
  a: number[],
  b: number[],
  y: number[],
  iters = 10_000,
  seed = 1234,
): { mean: number; ci90: [number, number]; pBetter: number } {
  let s = seed >>> 0;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = y.length;
  const deltas = a.map((pa, i) => (pa - y[i]) ** 2 - (b[i] - y[i]) ** 2);
  const meanDelta = deltas.reduce((x, d) => x + d, 0) / n;
  const samples: number[] = [];
  let better = 0;
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[Math.floor(rnd() * n)];
    const m = sum / n;
    samples.push(m);
    if (m < 0) better++;
  }
  samples.sort((x, z) => x - z);
  return {
    mean: meanDelta,
    ci90: [samples[Math.floor(iters * 0.05)], samples[Math.floor(iters * 0.95)]],
    pBetter: better / iters,
  };
}

function calibrationTable(pairs: Array<[number, number]>): string[] {
  const buckets = [0.5, 0.55, 0.6, 0.65, 0.7, 1.01];
  const rows: string[] = [];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1];
    const inB = pairs
      .map(([p, y]) => [Math.max(p, 1 - p), p >= 0.5 ? y : 1 - y] as [number, number])
      .filter(([c]) => c >= lo && c < hi);
    if (inB.length === 0) continue;
    const won = inB.reduce((a, [, w]) => a + w, 0);
    const claimed = inB.reduce((a, [c]) => a + c, 0) / inB.length;
    rows.push(
      `  ${(lo * 100).toFixed(0)}–${Math.min(100, hi * 100).toFixed(0)}%: claimed ${(claimed * 100).toFixed(1)}%, won ${((won / inB.length) * 100).toFixed(1)}% (n=${inB.length})`,
    );
  }
  return rows;
}

// ─── Model variants ───────────────────────────────────────────────────────────

interface Variant {
  name: string;
  config: V3Config;
}

function buildVariants(): Variant[] {
  const sosOff = V3_AS_V2_CONFIG.sos;
  const ctxOff = CONTEXT_DISABLED;
  return [
    { name: "v2 (recomputed)", config: V3_AS_V2_CONFIG },
    {
      name: "v3 SOS-only",
      config: { ...DEFAULT_V3_CONFIG, context: ctxOff },
    },
    {
      name: "v3 context-only",
      config: { ...DEFAULT_V3_CONFIG, sos: sosOff },
    },
    { name: "v3 full (shipped)", config: DEFAULT_V3_CONFIG },
    {
      name: "v3 SOS λ=1 no-contam",
      config: {
        ...DEFAULT_V3_CONFIG,
        sos: {
          ...DEFAULT_V3_CONFIG.sos,
          tuning: { priorGames: 15, lambda: 1.0, contamCorrection: false },
        },
        context: ctxOff,
      },
    },
  ];
}

// ─── Per-date environment assembly ────────────────────────────────────────────

interface DateEnv {
  date: string;
  games: DayGame[];
  env: Omit<V3Env, "config">;
  odds: Map<number, DayOdds>;
}

async function buildDateEnv(
  date: string,
  season: number,
  seasonGamesAll: SeasonGame[],
  prev2: Awaited<ReturnType<typeof fetchSeasonResults>>,
  prev1: Awaited<ReturnType<typeof fetchSeasonResults>>,
  homeVenues: Map<number, string>,
  windowEnd: string,
  withOdds: boolean,
  nSims: number,
): Promise<DateEnv | null> {
  const games = await fetchDaySlate(date);
  if (games.length === 0) return null;
  const asOfEnd = dayBefore(date);
  const teamRates = await fetchTeamRatesAsOf(season, asOfEnd);
  const lg = leagueRates(teamRates);
  const teamLines: Map<number, TeamLines> = toTeamLines(teamRates, lg);

  const seasonGames = seasonGamesAll.filter((g) => g.date < date);
  const elo = computeElo([prev2, prev1, seasonGames]);

  const pitcherIds = new Set<number>();
  for (const g of games) {
    if (g.homePitcherId) pitcherIds.add(g.homePitcherId);
    if (g.awayPitcherId) pitcherIds.add(g.awayPitcherId);
  }
  const starterInfo = new Map<number, StarterInfo | null>();
  const starterLogs = new Map<number, StarterLogEntry[]>();
  await batchedAll(
    Array.from(pitcherIds).flatMap((id) => [
      async () => {
        starterInfo.set(id, await fetchStarterInfoAsOf(id, season, asOfEnd, lg));
      },
      async () => {
        starterLogs.set(id, await fetchStarterLogCached(id, season, windowEnd));
      },
    ]),
    8,
  );

  const odds = withOdds ? await fetchDayOdds(date, games) : new Map<number, DayOdds>();

  return {
    date,
    games,
    env: {
      seasonGames,
      teamLines,
      league: lg,
      elo,
      starterInfo,
      starterLogs,
      homeVenueOf: (id) => homeVenues.get(id) ?? null,
      nSims,
    },
    odds,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface ScoredRow {
  gameId: number;
  date: string;
  home: string;
  away: string;
  y: number;
  probs: Record<string, number>;
  pMarket: number | null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const windowName = flag("--window");
  const start = flag("--start") ?? (windowName ? WINDOWS[windowName]?.start : null);
  const end = flag("--end") ?? (windowName ? WINDOWS[windowName]?.end : null);
  if (!start || !end) {
    console.error("Usage: bun scripts/backtest-v3.ts --window dev|test  (or --start/--end)");
    process.exit(1);
  }
  const nSims = flag("--nsims") ? parseInt(flag("--nsims")!, 10) : 3000;
  const limitDates = flag("--limit-dates") ? parseInt(flag("--limit-dates")!, 10) : Infinity;
  const withOdds = !args.includes("--no-odds");
  const tune = args.includes("--tune");
  const outPath = flag("--out");

  const season = parseInt(start.slice(0, 4), 10);
  const today = new Date().toISOString().slice(0, 10);
  if (end >= today) {
    console.error(`--end ${end} must be strictly before today (${today}); games must be settled.`);
    process.exit(1);
  }

  console.log(
    `Backtest window ${start} → ${end}  (nsims=${nSims}, odds=${withOdds ? "on" : "off"})`,
  );
  console.log("Fetching shared season data…");
  const [seasonGamesAll, prev2, prev1, homeVenues] = await Promise.all([
    fetchSeasonGamesCached(season, end),
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
    fetchTeamHomeVenues(season),
  ]);
  if (seasonGamesAll.length === 0) {
    console.error(
      "No season games came back from statsapi.mlb.com — check network access. " +
        "(This sandbox's egress policy may block it; run from a machine that can reach it.)",
    );
    process.exit(1);
  }
  console.log(
    `  ${seasonGamesAll.length} season finals, ${prev2.length}+${prev1.length} prior-season results`,
  );

  // Enumerate window dates.
  const dates: string[] = [];
  for (
    let d = start;
    d <= end && dates.length < limitDates;
    d = new Date(new Date(d + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10)
  ) {
    dates.push(d);
  }

  const variants = buildVariants();
  const rows: ScoredRow[] = [];
  const dateEnvs: DateEnv[] = [];
  const t0 = Date.now();

  for (const date of dates) {
    const de = await buildDateEnv(
      date,
      season,
      seasonGamesAll,
      prev2,
      prev1,
      homeVenues,
      end,
      withOdds,
      nSims,
    );
    if (!de) {
      console.log(`  ${date}: no settled games`);
      continue;
    }
    dateEnvs.push(de);
    for (const g of de.games) {
      const probs: Record<string, number> = {};
      for (const v of variants) {
        probs[v.name] = predictV3Game(g, { ...de.env, config: v.config }).finalProb;
      }
      rows.push({
        gameId: g.gameId,
        date,
        home: g.homeName,
        away: g.awayName,
        y: g.y,
        probs,
        pMarket: de.odds.get(g.gameId)?.pHome ?? null,
      });
    }
    console.log(
      `  ${date}: ${de.games.length} games, odds ${de.odds.size}/${de.games.length}` +
        ` (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`,
    );
  }

  console.log(`\nScored ${rows.length} settled games on ${dateEnvs.length} dates.\n`);
  if (rows.length === 0) process.exit(1);

  // ═══ Headline table ═══
  const table = (name: string, m: Metrics) =>
    console.log(
      `${name.padEnd(26)} n=${String(m.n).padStart(4)}  acc=${(m.acc * 100).toFixed(1)}%  ` +
        `brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`,
    );

  console.log(`═══ Probability quality — all settled games (${start} → ${end}) ═══`);
  table("home-always-54", metrics(rows.map((r) => [0.54, r.y])));
  const eloOnly = dateEnvs.flatMap((de) =>
    de.games.map(
      (g) =>
        [eloWinProb(de.env.elo.get(g.homeId) ?? 1500, de.env.elo.get(g.awayId) ?? 1500), g.y] as [
          number,
          number,
        ],
    ),
  );
  table("elo only", metrics(eloOnly));
  for (const v of variants) {
    table(v.name, metrics(rows.map((r) => [r.probs[v.name], r.y])));
  }

  // ═══ v3 vs v2 paired bootstrap ═══
  const yArr = rows.map((r) => r.y);
  const pV2 = rows.map((r) => r.probs["v2 (recomputed)"]);
  for (const name of ["v3 SOS-only", "v3 full (shipped)"]) {
    const pV3 = rows.map((r) => r.probs[name]);
    const bs = bootstrapBrierDelta(pV3, pV2, yArr);
    console.log(
      `\n${name} vs v2 — Brier Δ ${bs.mean >= 0 ? "+" : ""}${bs.mean.toFixed(5)} ` +
        `(90% CI ${bs.ci90[0].toFixed(5)} … ${bs.ci90[1].toFixed(5)}, P(better)=${(bs.pBetter * 100).toFixed(1)}%)`,
    );
  }

  // ═══ Calibration ═══
  console.log(`\n═══ Calibration (pick-side buckets) ═══`);
  for (const name of ["v2 (recomputed)", "v3 full (shipped)"]) {
    console.log(`${name}:`);
    for (const line of calibrationTable(rows.map((r) => [r.probs[name], r.y]))) console.log(line);
  }

  // ═══ Split-half stability ═══
  const half = Math.floor(dateEnvs.length / 2);
  const firstDates = new Set(dateEnvs.slice(0, half).map((d) => d.date));
  console.log(`\n═══ Split-half (first ${half} dates vs rest) ═══`);
  for (const name of ["v2 (recomputed)", "v3 SOS-only", "v3 full (shipped)"]) {
    const h1 = metrics(rows.filter((r) => firstDates.has(r.date)).map((r) => [r.probs[name], r.y]));
    const h2 = metrics(
      rows.filter((r) => !firstDates.has(r.date)).map((r) => [r.probs[name], r.y]),
    );
    console.log(
      `${name.padEnd(26)} h1 brier=${h1.brier.toFixed(4)} (n=${h1.n})   h2 brier=${h2.brier.toFixed(4)} (n=${h2.n})`,
    );
  }

  // ═══ Market comparison ═══
  const withMkt = rows.filter((r) => r.pMarket != null);
  if (withMkt.length > 0) {
    console.log(`\n═══ Games with market odds (n=${withMkt.length}) ═══`);
    table("market (devigged)", metrics(withMkt.map((r) => [r.pMarket!, r.y])));
    for (const name of ["v2 (recomputed)", "v3 full (shipped)"]) {
      table(name, metrics(withMkt.map((r) => [r.probs[name], r.y])));
      table(
        `  ⊕ market w=${MARKET_BLEND_WEIGHT}`,
        metrics(withMkt.map((r) => [blendWithMarket(r.probs[name], r.pMarket!), r.y])),
      );
    }
  } else if (withOdds) {
    console.log("\n(no market odds matched — ESPN may be unreachable from here)");
  }

  // ═══ Tune mode ═══
  if (tune) {
    console.log(`\n═══ Tune (staged grid on this window — do NOT run on the test window) ═══`);
    const evalConfig = (config: V3Config): number => {
      const pairs: Array<[number, number]> = [];
      for (const de of dateEnvs) {
        for (const g of de.games) {
          pairs.push([predictV3Game(g, { ...de.env, config }).finalProb, g.y]);
        }
      }
      return metrics(pairs).brier;
    };

    // Stage 1: SOS estimation knobs, context off.
    console.log("Stage 1 — SOS λ × contamination (context off):");
    let best: { brier: number; config: V3Config } = {
      brier: evalConfig(V3_AS_V2_CONFIG),
      config: V3_AS_V2_CONFIG,
    };
    console.log(`  v2 baseline                     brier=${best.brier.toFixed(4)}`);
    for (const contam of [false, true]) {
      for (const lambda of [0.25, 0.5, 0.75, 1.0]) {
        const config: V3Config = {
          ...DEFAULT_V3_CONFIG,
          sos: {
            ...DEFAULT_V3_CONFIG.sos,
            tuning: { priorGames: 15, lambda, contamCorrection: contam },
          },
          context: CONTEXT_DISABLED,
        };
        const brier = evalConfig(config);
        console.log(
          `  λ=${lambda.toFixed(2)} contam=${contam ? "on " : "off"}             brier=${brier.toFixed(4)}`,
        );
        if (brier < best.brier) best = { brier, config };
      }
    }

    // Stage 2: context features, leave-one-out and one-at-a-time on top of stage-1 best.
    console.log("Stage 2 — context features (on top of stage-1 best):");
    const featureNames = Object.keys(DEFAULT_CONTEXT_CONFIG.enabled) as Array<
      keyof ContextConfig["enabled"]
    >;
    for (const feat of featureNames) {
      const enabled = { ...CONTEXT_DISABLED.enabled, [feat]: true };
      const config: V3Config = {
        ...best.config,
        context: { ...DEFAULT_CONTEXT_CONFIG, enabled },
      };
      console.log(`  +${String(feat).padEnd(10)} brier=${evalConfig(config).toFixed(4)}`);
    }
    const allCtx: V3Config = { ...best.config, context: DEFAULT_CONTEXT_CONFIG };
    const allBrier = evalConfig(allCtx);
    console.log(`  +ALL        brier=${allBrier.toFixed(4)}`);
    if (allBrier < best.brier) best = { brier: allBrier, config: allCtx };

    // Stage 3: calibration scale.
    console.log("Stage 3 — calibration scale:");
    for (const calScale of [0.8, 0.85, 0.9, 0.95, 1.0, 1.05]) {
      const config = { ...best.config, calScale };
      const brier = evalConfig(config);
      console.log(`  a=${calScale.toFixed(2)}  brier=${brier.toFixed(4)}`);
      if (brier < best.brier) best = { brier, config };
    }

    console.log(`\nBest config (dev brier ${best.brier.toFixed(4)}):`);
    console.log(
      JSON.stringify(
        {
          sos: best.config.sos,
          calScale: best.config.calScale,
          contextEnabled: best.config.context.enabled,
        },
        null,
        2,
      ),
    );
    console.log(
      "Freeze this into DEFAULT_V3_CONFIG / DEFAULT_SOS_TUNING, then score --window test ONCE.",
    );
  }

  if (outPath) {
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          window: { start, end },
          nSims,
          nGames: rows.length,
          variants: variants.map((v) => v.name),
          games: rows,
        },
        null,
        2,
      ),
    );
    console.log(`\nSaved full results to ${outPath}`);
  }
}

main().catch((err) => {
  console.error("💥 backtest failed:", err);
  process.exit(1);
});
