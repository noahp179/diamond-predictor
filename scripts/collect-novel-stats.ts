#!/usr/bin/env -S npx tsx
/**
 * Round-10 novel-stat collector — invented signals the market might price late.
 * One row per game in the model window, joined to records-v5.jsonl by gamePk.
 *
 *   npx tsx scripts/collect-novel-stats.ts [--start 2026-04-20] [--end 2026-07-11]
 *                                          [--out .backtest-cache/novel.jsonl]
 *
 * The stats (all strictly point-in-time — every input ends before first pitch):
 *   veloDelta   starter's first-inning FF/SI velocity in his MOST RECENT start
 *               minus his mean over earlier starts (Statcast; inning-1 pitches
 *               are starters by construction). Velo drops precede bad outings.
 *   luck21      sequencing luck: actual runs over the trailing 21 days minus
 *               BaseRuns-expected runs from the same window's raw events.
 *               Lucky teams (positive) should regress.
 *   pythagLuck  season W% minus Pythagorean W% (run-profile luck).
 *   oneRunLuck  win% in one-run games minus overall win% (coin-flip games won).
 *   tzShift     time zones crossed since the previous game (park longitudes).
 *   km72h       kilometers traveled across parks in the last 72 hours.
 *   getaway     tired pocket: previous game was a local night game, today is a
 *               day game, and the team traveled in between.
 *   down02      sweep-avoidance spot: lost the first 2+ games of the current
 *               series without a win.
 *   penBF2d     bullpen batters faced over the last 2 days (from boxscores;
 *               everyone after the first pitcher used is bullpen).
 *
 * Heavy but resumable-free (single pass, ~10 min): 1 season schedule call,
 * ~107 small Statcast CSVs (sequential, throttled), ~1,150 boxscores, 84
 * team-hitting snapshots. Read-only.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Park coordinates (matches collect-backtest-data.ts's table).
const VENUES: Record<string, { lat: number; lon: number }> = {
  "American Family Field": { lat: 43.028, lon: -87.971 },
  "Angel Stadium": { lat: 33.8, lon: -117.883 },
  "Busch Stadium": { lat: 38.6226, lon: -90.1928 },
  "Chase Field": { lat: 33.4455, lon: -112.0667 },
  "Citi Field": { lat: 40.7571, lon: -73.8458 },
  "Citizens Bank Park": { lat: 39.9061, lon: -75.1665 },
  "Comerica Park": { lat: 42.339, lon: -83.0485 },
  "Coors Field": { lat: 39.7559, lon: -104.9942 },
  "Daikin Park": { lat: 29.7573, lon: -95.3555 },
  "Estadio Alfredo Harp Helu": { lat: 19.4042, lon: -99.0907 },
  "Fenway Park": { lat: 42.3467, lon: -71.0972 },
  "Globe Life Field": { lat: 32.7473, lon: -97.0847 },
  "Great American Ball Park": { lat: 39.0975, lon: -84.5066 },
  "Kauffman Stadium": { lat: 39.0517, lon: -94.4803 },
  "Las Vegas Ballpark": { lat: 36.1526, lon: -115.3392 },
  "Nationals Park": { lat: 38.873, lon: -77.0074 },
  "Oracle Park": { lat: 37.7786, lon: -122.3893 },
  "Oriole Park at Camden Yards": { lat: 39.2838, lon: -76.6217 },
  "PNC Park": { lat: 40.4469, lon: -80.0057 },
  "Petco Park": { lat: 32.7076, lon: -117.157 },
  "Progressive Field": { lat: 41.4962, lon: -81.6852 },
  "Rate Field": { lat: 41.8299, lon: -87.6338 },
  "Rogers Centre": { lat: 43.6414, lon: -79.3894 },
  "Sutter Health Park": { lat: 38.5802, lon: -121.5133 },
  "T-Mobile Park": { lat: 47.5914, lon: -122.3325 },
  "Target Field": { lat: 44.9817, lon: -93.2776 },
  "Tropicana Field": { lat: 27.7683, lon: -82.6534 },
  "Truist Park": { lat: 33.8908, lon: -84.4678 },
  "UNIQLO Field at Dodger Stadium": { lat: 34.0739, lon: -118.24 },
  "Wrigley Field": { lat: 41.9484, lon: -87.6553 },
  "Yankee Stadium": { lat: 40.8296, lon: -73.9262 },
  "loanDepot park": { lat: 25.7781, lon: -80.2196 },
};

function havKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, dLa = ((b.lat - a.lat) * Math.PI) / 180, dLo = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ─── Season schedule (venue + time + scores + probables), one call ────────────

interface SchedGame {
  gamePk: number;
  date: string;
  gameDate: string;
  venue: string | null;
  home: number;
  away: number;
  hs: number | null;
  as: number | null;
  hp: number | null;
  ap: number | null;
  final: boolean;
}

async function fetchSeasonSchedule(season: number, end: string): Promise<SchedGame[]> {
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=venue,probablePitcher&startDate=${season}-03-01&endDate=${end}`;
  const res = await fetchWithTimeout(url, 60_000);
  if (!res.ok) throw new Error(`schedule ${res.status}`);
  const json: any = await res.json();
  const out: SchedGame[] = [];
  for (const d of json?.dates ?? []) {
    for (const g of d?.games ?? []) {
      const status: string = g?.status?.detailedState ?? "";
      out.push({
        gamePk: g.gamePk,
        date: d.date,
        gameDate: g.gameDate ?? "",
        venue: g.venue?.name ?? null,
        home: g.teams.home.team.id,
        away: g.teams.away.team.id,
        hs: typeof g.teams?.home?.score === "number" ? g.teams.home.score : null,
        as: typeof g.teams?.away?.score === "number" ? g.teams.away.score : null,
        hp: g.teams.home.probablePitcher?.id ?? null,
        ap: g.teams.away.probablePitcher?.id ?? null,
        final: /final|game over|completed/i.test(status),
      });
    }
  }
  return out.sort((a, b) => (a.gameDate < b.gameDate ? -1 : 1));
}

// ─── Statcast first-inning velocity per date ──────────────────────────────────

/** Minimal quote-aware CSV line splitter (savant fields contain commas). */
function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchVeloDay(date: string): Promise<Map<number, number>> {
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=FF%7CSI%7C&hfInn=1%7C&hfSea=2026%7C&player_type=pitcher&game_date_gt=${date}&game_date_lt=${date}&type=details`;
  try {
    const res = await fetchWithTimeout(url, 40_000);
    if (!res.ok) return new Map();
    const text = (await res.text()).replace(/^﻿/, "");
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return new Map();
    const header = csvSplit(lines[0]);
    const iPitcher = header.indexOf("pitcher");
    const iSpeed = header.indexOf("release_speed");
    if (iPitcher < 0 || iSpeed < 0) return new Map();
    const acc = new Map<number, { s: number; n: number }>();
    for (let i = 1; i < lines.length; i++) {
      const cols = csvSplit(lines[i]);
      const id = parseInt(cols[iPitcher], 10);
      const v = parseFloat(cols[iSpeed]);
      if (!id || !Number.isFinite(v)) continue;
      const a = acc.get(id) ?? { s: 0, n: 0 };
      a.s += v; a.n++;
      acc.set(id, a);
    }
    const out = new Map<number, number>();
    for (const [id, a] of acc) if (a.n >= 5) out.set(id, a.s / a.n);
    return out;
  } catch {
    return new Map();
  }
}

// ─── Boxscore pen workload ────────────────────────────────────────────────────

async function fetchPenBF(gamePk: number): Promise<{ home: number; away: number } | null> {
  try {
    const res = await fetchWithTimeout(`${STATS_API}/game/${gamePk}/boxscore`, 25_000);
    if (!res.ok) return null;
    const json: any = await res.json();
    const side = (s: "home" | "away") => {
      const t = json?.teams?.[s];
      const order: number[] = t?.pitchers ?? [];
      let bf = 0;
      order.slice(1).forEach((id) => {
        bf += t?.players?.[`ID${id}`]?.stats?.pitching?.battersFaced ?? 0;
      });
      return bf;
    };
    return { home: side("home"), away: side("away") };
  } catch {
    return null;
  }
}

// ─── BaseRuns from a trailing-21d team hitting snapshot ───────────────────────

async function fetchHitCounts(season: number, startDate: string, endDate: string) {
  const url = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=byDateRange&startDate=${startDate}&endDate=${endDate}&group=hitting`;
  const res = await fetchWithTimeout(url, 30_000);
  const out = new Map<number, { h: number; d2: number; d3: number; hr: number; bb: number; pa: number; ab: number }>();
  if (!res.ok) return out;
  const j: any = await res.json();
  for (const s of j?.stats?.[0]?.splits ?? []) {
    const id = s?.team?.id, st = s?.stat;
    if (!id || !st) continue;
    out.set(id, {
      h: st.hits ?? 0, d2: st.doubles ?? 0, d3: st.triples ?? 0, hr: st.homeRuns ?? 0,
      bb: (st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0),
      pa: st.plateAppearances ?? 0, ab: st.atBats ?? 0,
    });
  }
  return out;
}

function baseRuns(c: { h: number; d2: number; d3: number; hr: number; bb: number; ab: number }): number {
  const b1 = c.h - c.d2 - c.d3 - c.hr;
  const tb = b1 + 2 * c.d2 + 3 * c.d3 + 4 * c.hr;
  const A = c.h + c.bb - c.hr;
  const B = (1.4 * tb - 0.6 * c.h - 3 * c.hr + 0.1 * c.bb) * 1.02;
  const C = c.ab - c.h;
  const D = c.hr;
  return C <= 0 || B + C <= 0 ? 0 : (A * B) / (B + C) + D;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const start = arg("start", "2026-04-20");
  const end = arg("end", "2026-07-11");
  const outPath = arg("out", ".backtest-cache/novel.jsonl");
  const season = parseInt(start.slice(0, 4), 10);
  mkdirSync(dirname(outPath), { recursive: true });

  console.log("1/4 season schedule…");
  const sched = await fetchSeasonSchedule(season, end);
  const finals = sched.filter((g) => g.final && g.hs != null && g.as != null && g.hs !== g.as);
  console.log(`  ${sched.length} games, ${finals.length} finals`);
  const windowGames = finals.filter((g) => g.date >= start && g.date <= end);

  // Per-team timeline for travel / luck / series context.
  const byTeam = new Map<number, SchedGame[]>();
  for (const g of finals) {
    for (const t of [g.home, g.away]) (byTeam.get(t) ?? byTeam.set(t, []).get(t)!).push(g);
  }

  console.log("2/4 Statcast first-inning velocity (throttled)…");
  const veloDates = Array.from(new Set(finals.map((g) => g.date))).sort();
  const veloByDate = new Map<string, Map<number, number>>();
  for (const d of veloDates) {
    veloByDate.set(d, await fetchVeloDay(d));
    await new Promise((r) => setTimeout(r, 900));
  }
  const veloOk = Array.from(veloByDate.values()).filter((m) => m.size > 0).length;
  console.log(`  velo for ${veloOk}/${veloDates.length} dates (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  // pitcher → chronological [date, velo]
  const veloHist = new Map<number, Array<[string, number]>>();
  for (const d of veloDates) {
    for (const [id, v] of veloByDate.get(d)!) {
      (veloHist.get(id) ?? veloHist.set(id, []).get(id)!).push([d, v]);
    }
  }

  console.log("3/4 boxscore pen workload…");
  const boxNeeded = finals.filter((g) => g.date >= addDaysISO(start, -3));
  const penByGame = new Map<number, { home: number; away: number }>();
  await batchedAll(
    boxNeeded.map((g) => async () => {
      const p = await fetchPenBF(g.gamePk);
      if (p) penByGame.set(g.gamePk, p);
    }),
    8,
  );
  console.log(`  ${penByGame.size}/${boxNeeded.length} boxscores (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  console.log("4/4 per-date features…");
  const dates = Array.from(new Set(windowGames.map((g) => g.date))).sort();

  const localHour = (g: SchedGame): number | null => {
    if (!g.gameDate || !g.venue || !VENUES[g.venue]) return null;
    const utc = new Date(g.gameDate).getUTCHours() + new Date(g.gameDate).getUTCMinutes() / 60;
    return (utc + VENUES[g.venue].lon / 15 + 24) % 24;
  };

  function teamFeats(team: number, date: string, todayVenue: string | null, todayHour: number | null) {
    const hist = (byTeam.get(team) ?? []).filter((g) => g.date < date);
    const season_ = hist;
    // pythag + one-run luck (season to date)
    let w = 0, rs = 0, ra = 0, oneRunW = 0, oneRunN = 0;
    for (const g of season_) {
      const isHome = g.home === team;
      const my = isHome ? g.hs! : g.as!, opp = isHome ? g.as! : g.hs!;
      rs += my; ra += opp;
      const won = my > opp;
      if (won) w++;
      if (Math.abs(my - opp) === 1) { oneRunN++; if (won) oneRunW++; }
    }
    const n = season_.length;
    const pythag = rs > 0 || ra > 0 ? Math.pow(rs, 1.83) / (Math.pow(rs, 1.83) + Math.pow(ra, 1.83)) : 0.5;
    const pythagLuck = n >= 20 ? w / n - pythag : 0;
    const oneRunLuck = oneRunN >= 5 && n >= 20 ? oneRunW / oneRunN - w / n : 0;
    // trailing 21d actual runs (for BaseRuns luck; expected side joined later)
    const from21 = addDaysISO(date, -21);
    let rs21 = 0, g21 = 0;
    for (const g of season_) {
      if (g.date < from21) continue;
      rs21 += g.home === team ? g.hs! : g.as!;
      g21++;
    }
    // travel + tz + getaway
    const last = season_[season_.length - 1] ?? null;
    let tzShift = 0, km72 = 0, getaway = 0;
    const cur = todayVenue && VENUES[todayVenue] ? VENUES[todayVenue] : null;
    if (last?.venue && VENUES[last.venue] && cur) {
      tzShift = Math.abs(Math.round(cur.lon / 15) - Math.round(VENUES[last.venue].lon / 15));
      const from72 = addDaysISO(date, -3);
      let prev = cur;
      for (let i = season_.length - 1; i >= 0; i--) {
        const g = season_[i];
        if (g.date < from72) break;
        const v = g.venue && VENUES[g.venue] ? VENUES[g.venue] : null;
        if (v) { km72 += havKm(v, prev); prev = v; }
      }
      const lh = localHour(last);
      const wasNight = lh != null && lh >= 18;
      const isDay = todayHour != null && todayHour <= 15.5;
      if (wasNight && isDay && km72 > 200 && last.date === addDaysISO(date, -1)) getaway = 1;
    }
    // sweep spot: current series vs same opponent, lost first 2+ without a win
    let down02 = 0;
    if (season_.length >= 2) {
      const today = (byTeam.get(team) ?? []).find((g) => g.date === date);
      const opp = today ? (today.home === team ? today.away : today.home) : null;
      if (opp != null) {
        let losses = 0, wins = 0;
        for (let i = season_.length - 1; i >= 0; i--) {
          const g = season_[i];
          const gOpp = g.home === team ? g.away : g.home;
          if (gOpp !== opp || g.date < addDaysISO(date, -4)) break;
          const won = (g.home === team ? g.hs! : g.as!) > (g.home === team ? g.as! : g.hs!);
          if (won) wins++; else losses++;
        }
        if (losses >= 2 && wins === 0) down02 = 1;
      }
    }
    // pen workload last 2 days
    let penBF2d = 0;
    for (let i = season_.length - 1; i >= 0; i--) {
      const g = season_[i];
      if (g.date < addDaysISO(date, -2)) break;
      const p = penByGame.get(g.gamePk);
      if (p) penBF2d += g.home === team ? p.home : p.away;
    }
    return { pythagLuck, oneRunLuck, rs21, g21, tzShift, km72, getaway, down02, penBF2d };
  }

  const veloDelta = (pid: number | null, date: string): number | null => {
    if (!pid) return null;
    const hist = (veloHist.get(pid) ?? []).filter(([d]) => d < date);
    if (hist.length < 4) return null;
    const lastV = hist[hist.length - 1][1];
    const prior = hist.slice(0, -1);
    const mean = prior.reduce((a, [, v]) => a + v, 0) / prior.length;
    return lastV - mean;
  };

  const lines: string[] = [];
  for (const date of dates) {
    const day = windowGames.filter((g) => g.date === date);
    const hitCounts = await fetchHitCounts(season, addDaysISO(date, -21), addDaysISO(date, -1));
    for (const g of day) {
      const hour = localHour(g);
      const fH = teamFeats(g.home, date, g.venue, hour);
      const fA = teamFeats(g.away, date, g.venue, hour);
      const luck = (team: number, f: { rs21: number; g21: number }) => {
        const c = hitCounts.get(team);
        if (!c || f.g21 < 10 || c.pa < 200) return 0;
        return (f.rs21 - baseRuns(c)) / f.g21; // runs/game above expectation
      };
      lines.push(
        JSON.stringify({
          gamePk: g.gamePk,
          date,
          veloDeltaH: veloDelta(g.hp, date),
          veloDeltaA: veloDelta(g.ap, date),
          luck21H: luck(g.home, fH), luck21A: luck(g.away, fA),
          pythagLuckH: fH.pythagLuck, pythagLuckA: fA.pythagLuck,
          oneRunLuckH: fH.oneRunLuck, oneRunLuckA: fA.oneRunLuck,
          tzShiftH: fH.tzShift, tzShiftA: fA.tzShift,
          km72H: fH.km72, km72A: fA.km72,
          getawayH: fH.getaway, getawayA: fA.getaway,
          down02H: fH.down02, down02A: fA.down02,
          penBF2dH: fH.penBF2d, penBF2dA: fA.penBF2d,
        }),
      );
    }
  }
  appendFileSync(outPath, lines.join("\n") + "\n");
  console.log(`done — ${lines.length} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${outPath}`);
}

main().catch((err) => {
  console.error("💥 novel collect failed:", err);
  process.exit(1);
});
