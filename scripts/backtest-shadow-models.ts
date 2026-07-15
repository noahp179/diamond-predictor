#!/usr/bin/env -S npx tsx
/**
 * Backtest: the sim-recent line vs the headline sim-elo-v2, on real settled
 * games, strictly point-in-time. Self-contained — reads everything from the MLB
 * Stats API (no Supabase, no odds), so it runs the moment statsapi.mlb.com is
 * reachable.
 *
 *   npx tsx scripts/backtest-shadow-models.ts [--start YYYY-MM-DD] [--end YYYY-MM-DD]
 *                                             [--sims 3000] [--out results.json]
 *
 * Four models, same engine, compared on identical games (production seeds):
 *   sim-elo-v2      headline — season-to-date team rates + season starter    (seed 1000    + pk)
 *   sim-recent-v1   trailing-window team form + trailing starter             (seed 2000000 + pk)
 *   sim-recent-v2   sim-recent-v1 + the TIERED relievers-only pen            (seed 5000000 + pk)
 *   sim-lineup-v1   sim-recent-v1 + the LINEUP/PLATOON offense               (seed 7000000 + pk)
 *
 * sim-recent-v2 (Rounds 4-6) folds the recommended bullpen upgrades onto the
 * recent-form model. sim-lineup-v1 (Round 7) instead swaps the offense: the
 * trailing team-aggregate line is replaced by the nine hitters in tonight's
 * posted order, PA-weighted by slot, platoon-tilted vs the starter's hand, and
 * level-recalibrated to the team-aggregate run environment (mlb-lineup.ts) —
 * the properly-built version of the naïve lineup average that lost in Round 4.
 * Each is one isolated change onto sim-recent-v1. Every input is reconstructed
 * with no lookahead (Elo replayed to each morning; all rates end the day before;
 * lineups are tonight's posted orders; handedness is static).
 *
 * Read-only. Never writes to any database.
 */

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
} from "../src/lib/mlb-sim";
import {
  fetchAllTeamRatesRecent,
  fetchStarterInfoRecent,
} from "../src/lib/mlb-recent-form";
import { fetchAllBullpens } from "../src/lib/mlb-bullpen";
import { fetchLineupOffenseForDate, type LineupGameRef } from "../src/lib/mlb-lineup";
import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";

const PEN_WINDOW_DAYS = 30; // must match mlb-recent-form.ts

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));
const ensemble = (pSim: number, pElo: number) =>
  sigmoid((logit(clamp01(pSim)) + logit(clamp01(pElo))) / 2);

function dayBefore(dateISO: string): string {
  return new Date(new Date(dateISO + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ─── Point-in-time season-to-date team rates + starter (for sim-elo-v2) ──────

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

// ─── Settled games from the schedule ─────────────────────────────────────────

interface Game {
  gamePk: number;
  date: string;
  homeId: number;
  awayId: number;
  venue: string | null;
  hp: number | null;
  ap: number | null;
  y: number;
}

async function fetchSettledGames(start: string, end: string): Promise<Game[]> {
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher,team,venue&startDate=${start}&endDate=${end}`;
  const res = await fetchWithTimeout(url, 30_000);
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
        homeId: g.teams.home.team.id,
        awayId: g.teams.away.team.id,
        venue: g.venue?.name ?? null,
        hp: g.teams.home.probablePitcher?.id ?? null,
        ap: g.teams.away.probablePitcher?.id ?? null,
        y: hs > as ? 1 : 0,
      });
    }
  }
  return out;
}

function metrics(pairs: Array<[number, number]>) {
  const eps = 1e-7;
  let acc = 0, brier = 0, ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = pairs.length;
  return { n, acc: acc / n, brier: brier / n, logLoss: ll / n };
}

interface Scored {
  gamePk: number;
  date: string;
  y: number;
  pElo2: number; // sim-elo-v2 (headline)
  pRec1: number; // sim-recent-v1
  pRec2: number; // sim-recent-v2 (form + tiered pen)
  pLineup: number; // sim-lineup-v1 (form + lineup/platoon offense)
  usedPen: boolean; // a smart reliever line was used for at least one side
  usedLineup: boolean; // a lineup-derived offense line was used for at least one side
}

async function main() {
  const t0 = Date.now();
  const end = arg("end", dayBefore(dayBefore(new Date().toISOString().slice(0, 10))));
  const startDefault = new Date(new Date(end + "T00:00:00Z").getTime() - 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const start = arg("start", startDefault);
  const nSims = parseInt(arg("sims", "3000"), 10);
  const season = parseInt(start.slice(0, 4), 10);

  console.log(`Window ${start} → ${end}, ${nSims} sims/game/model`);
  console.log("Loading settled games…");
  const games = await fetchSettledGames(start, end);
  const byDate = new Map<string, Game[]>();
  for (const g of games) (byDate.get(g.date) ?? byDate.set(g.date, []).get(g.date)!).push(g);
  const dates = Array.from(byDate.keys()).sort();
  console.log(`  ${games.length} settled games across ${dates.length} dates`);

  console.log("Loading prior-season results for multi-season Elo…");
  const [prev2, prev1] = await Promise.all([
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
  ]);
  console.log(`  ${prev2.length} + ${prev1.length} prior-season results`);

  const scored: Scored[] = [];

  for (const date of dates) {
    const day = byDate.get(date)!;
    const before = dayBefore(date);
    const teamIds = Array.from(new Set(day.flatMap((g) => [g.homeId, g.awayId])));

    // League line comes from season-to-date rates; everything regresses to it.
    const [seasonResults, teamRatesSeason, teamRatesRecent] = await Promise.all([
      fetchSeasonResults(season, date),
      fetchAllTeamRatesAsOf(season, before),
      fetchAllTeamRatesRecent(season, date),
    ]);
    const elo = computeElo([prev2, prev1, seasonResults]);
    const lg = leagueRates(teamRatesSeason);

    // sim-recent-v2's upgraded input (the smart pen), plus both starter
    // reconstructions.
    const pitcherIds = new Set<number>();
    for (const g of day) {
      if (g.hp) pitcherIds.add(g.hp);
      if (g.ap) pitcherIds.add(g.ap);
    }
    const startersSeason = new Map<number, StarterInfo | null>();
    const startersRecent = new Map<number, StarterInfo | null>();

    // sim-lineup-v1's upgraded input: the lineup-derived offense, recalibrated
    // against the same trailing team-batting map sim-recent-v1 uses.
    const teamAggRecent = new Map<number, BattingRates | null>();
    for (const [id, r] of teamRatesRecent) teamAggRecent.set(id, r.batting);
    const lineupRefs: LineupGameRef[] = day.map((g) => ({
      gamePk: g.gamePk,
      homeId: g.homeId,
      awayId: g.awayId,
      homeStarterId: g.hp,
      awayStarterId: g.ap,
    }));

    const [relievers, lineupByGame] = await Promise.all([
      fetchAllBullpens(teamIds, season, date, lg, PEN_WINDOW_DAYS),
      fetchLineupOffenseForDate(lineupRefs, season, date, lg, teamAggRecent),
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
    ]);

    for (const g of day) {
      const sR = (m: Map<number, TeamRates>, id: number) => m.get(id) ?? { batting: null, staff: null };
      const hSeason = sR(teamRatesSeason, g.homeId), aSeason = sR(teamRatesSeason, g.awayId);
      const hRecent = sR(teamRatesRecent, g.homeId), aRecent = sR(teamRatesRecent, g.awayId);
      const hPen = relievers.get(g.homeId) ?? null, aPen = relievers.get(g.awayId) ?? null;
      const pElo = eloWinProb(elo.get(g.homeId) ?? 1500, elo.get(g.awayId) ?? 1500);

      // sim-elo-v2 (headline): season rates + season starter, seed 1000+pk.
      const pS1 = simulateMatchup(
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
      // sim-recent-v1: trailing team rates + trailing starter, seed 2000000+pk.
      const pS2 = simulateMatchup(
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
      // sim-recent-v2: recent team offense + TIERED pen (fallback to v1 staff), seed 5000000+pk.
      const pS3 = simulateMatchup(
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
      // sim-lineup-v1: recent form + LINEUP/PLATOON offense (fallback to the v1
      // recent team line per side), recent starter, recent full-staff pen (like
      // v1). Isolates exactly the offense source. seed 7000000+pk.
      const lu = lineupByGame.get(g.gamePk);
      const homeLineup = lu?.home ?? null;
      const awayLineup = lu?.away ?? null;
      const pS4 = simulateMatchup(
        {
          homeBatting: homeLineup ?? hRecent.batting ?? lg,
          awayBatting: awayLineup ?? aRecent.batting ?? lg,
          homeStarter: (g.hp && startersRecent.get(g.hp)) || null,
          awayStarter: (g.ap && startersRecent.get(g.ap)) || null,
          homeStaff: reshapeStaff(hRecent.staff, lg),
          awayStaff: reshapeStaff(aRecent.staff, lg),
          league: lg,
          venue: g.venue,
        },
        nSims,
        7_000_000 + g.gamePk,
      );

      scored.push({
        gamePk: g.gamePk,
        date: g.date,
        y: g.y,
        pElo2: ensemble(pS1, pElo),
        pRec1: ensemble(pS2, pElo),
        pRec2: ensemble(pS3, pElo),
        pLineup: ensemble(pS4, pElo),
        usedPen: hPen != null || aPen != null,
        usedLineup: homeLineup != null || awayLineup != null,
      });
    }
    const pen = day.filter((g) => (relievers.get(g.homeId) ?? relievers.get(g.awayId)) != null).length;
    console.log(`  ${date}: ${day.length} games  (smart pen for ${pen})`);
  }

  console.log(`\nScored ${scored.length} games in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  const pairs = (f: (s: Scored) => number, set = scored) => set.map((s) => [f(s), s.y] as [number, number]);
  const fmt = (name: string, m: ReturnType<typeof metrics>) =>
    console.log(
      `${name.padEnd(24)} n=${String(m.n).padStart(3)}  acc=${(m.acc * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`,
    );

  console.log("═══ All settled games in window ═══");
  fmt("sim-elo-v2 (headline)", metrics(pairs((s) => s.pElo2)));
  fmt("sim-recent-v1", metrics(pairs((s) => s.pRec1)));
  fmt("sim-recent-v2", metrics(pairs((s) => s.pRec2)));
  fmt("sim-lineup-v1", metrics(pairs((s) => s.pLineup)));
  fmt("home-always-54", metrics(pairs(() => 0.54)));

  const penSet = scored.filter((s) => s.usedPen);
  console.log(`\n═══ Games where a smart reliever line was actually built (n=${penSet.length}) ═══`);
  fmt("sim-elo-v2", metrics(pairs((s) => s.pElo2, penSet)));
  fmt("sim-recent-v1", metrics(pairs((s) => s.pRec1, penSet)));
  fmt("sim-recent-v2", metrics(pairs((s) => s.pRec2, penSet)));

  const lineupSet = scored.filter((s) => s.usedLineup);
  console.log(`\n═══ Games where a lineup-derived offense was actually built (n=${lineupSet.length}) ═══`);
  fmt("sim-elo-v2", metrics(pairs((s) => s.pElo2, lineupSet)));
  fmt("sim-recent-v1", metrics(pairs((s) => s.pRec1, lineupSet)));
  fmt("sim-lineup-v1", metrics(pairs((s) => s.pLineup, lineupSet)));

  // Disagreement vs a base pick: how often the challenger flips the base's pick,
  // and how often that flip is correct (a real complementary-signal test).
  const flips = (base: (s: Scored) => number, chal: (s: Scored) => number, set = scored) => {
    let disagree = 0, right = 0;
    for (const s of set) {
      if ((base(s) >= 0.5) !== (chal(s) >= 0.5)) {
        disagree++;
        if ((chal(s) >= 0.5 ? 1 : 0) === s.y) right++;
      }
    }
    return { disagree, right };
  };
  const f1 = flips((s) => s.pElo2, (s) => s.pRec1);
  const f2 = flips((s) => s.pElo2, (s) => s.pRec2);
  const f3 = flips((s) => s.pElo2, (s) => s.pLineup);
  console.log(`\nvs the headline sim-elo-v2 pick:`);
  console.log(`  sim-recent-v1 disagreed on ${f1.disagree} games, right on ${f1.right}`);
  console.log(`  sim-recent-v2 disagreed on ${f2.disagree} games, right on ${f2.right}`);
  console.log(`  sim-lineup-v1 disagreed on ${f3.disagree} games, right on ${f3.right}`);
  // The key Round 7 question: does the lineup offense out-pick its own parent, v1?
  const f4 = flips((s) => s.pRec1, (s) => s.pLineup);
  console.log(`vs its parent sim-recent-v1 pick:`);
  console.log(`  sim-lineup-v1 disagreed on ${f4.disagree} games, right on ${f4.right}`);
  const f4l = flips((s) => s.pRec1, (s) => s.pLineup, lineupSet);
  console.log(`  (on the ${lineupSet.length} lineup-built games: disagreed on ${f4l.disagree}, right on ${f4l.right})`);

  const outIdx = process.argv.indexOf("--out");
  if (outIdx > 0 && process.argv[outIdx + 1]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      process.argv[outIdx + 1],
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          window: { start, end },
          nSims,
          nGames: scored.length,
          all: {
            simEloV2: metrics(pairs((s) => s.pElo2)),
            simRecentV1: metrics(pairs((s) => s.pRec1)),
            simRecentV2: metrics(pairs((s) => s.pRec2)),
            simLineupV1: metrics(pairs((s) => s.pLineup)),
          },
          penSet: {
            n: penSet.length,
            simEloV2: metrics(pairs((s) => s.pElo2, penSet)),
            simRecentV1: metrics(pairs((s) => s.pRec1, penSet)),
            simRecentV2: metrics(pairs((s) => s.pRec2, penSet)),
          },
          lineupSet: {
            n: lineupSet.length,
            simEloV2: metrics(pairs((s) => s.pElo2, lineupSet)),
            simRecentV1: metrics(pairs((s) => s.pRec1, lineupSet)),
            simLineupV1: metrics(pairs((s) => s.pLineup, lineupSet)),
          },
          games: scored,
        },
        null,
        2,
      ),
    );
    console.log(`\nSaved full results to ${process.argv[outIdx + 1]}`);
  }
}

main().catch((err) => {
  console.error("💥 backtest failed:", err);
  process.exit(1);
});
