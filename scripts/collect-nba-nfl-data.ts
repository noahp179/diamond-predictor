#!/usr/bin/env bun
/**
 * Collector for the NBA/NFL expedition: normalizes three public datasets into
 * per-game JSONL caches so every algorithm in the study is pure math over
 * local files. Run with bun (it uses bun:sqlite):
 *
 *   bun scripts/collect-nba-nfl-data.ts
 *
 * Inputs (downloaded once into .backtest-cache/, see NBA-NFL-ANALYSIS.md):
 *   nba-odds.sqlite  — sportsbookreviews-lineage closing odds + results,
 *                      2007-08 → 2025-26 (partial), one table per season
 *                      (kyleskom/NBA-Machine-Learning-Sports-Betting mirror)
 *   nba-allelo.csv   — FiveThirtyEight game archive 1946-47 → 2014-15 with
 *                      their Elo ratings and published win forecasts
 *   nfl-games.csv    — nflverse/nfldata games.csv, 1999 → today: results,
 *                      closing spread/total every season, moneylines 2011+,
 *                      rest days, QB starters, roof/surface/weather
 *
 * Outputs (JSONL, one game per line, strictly as-of information only):
 *   .backtest-cache/nba-games.jsonl    — the odds-era NBA corpus
 *   .backtest-cache/nba-history.jsonl  — 1946-2015 warm-up + 538 benchmark
 *   .backtest-cache/nfl-games.jsonl    — the NFL corpus
 *
 * Normalizations applied:
 *   - Franchise-stable team codes across relocations/renames (SEA→OKC,
 *     NJN→BKN, Bobcats→CHA-2, Hornets/Pelicans split, OAK→LV, SD→LAC, STL→LA).
 *   - Spreads converted to a single convention: signed HOME margin
 *     (positive = home favored). Per-table sign detection: tables that never
 *     go negative store unsigned favorite margins; the favorite is recovered
 *     from the moneyline.
 *   - Scores reconstructed from (total points, home win margin).
 *   - Rest days recomputed from the schedule itself (capped at 7).
 *   - NBA playoff flag from published per-season postseason start dates.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = ".backtest-cache";

// ---------------------------------------------------------------- NBA teams

/** Full-name → franchise code. Codes are franchise-stable: a relocated or
 *  renamed club keeps one code so ratings carry across the move. */
const NBA_NAME_TO_CODE: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "New Jersey Nets": "BKN",
  "Charlotte Bobcats": "CHA",
  "Charlotte Hornets": "CHA", // 2014+ rename of the Bobcats franchise
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "LA Clippers": "LAC",
  "Los Angeles Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Hornets": "NOP", // pre-2013 name of the Pelicans franchise
  "New Orleans/Oklahoma City Hornets": "NOP", // Katrina seasons
  "New Orleans Pelicans": "NOP",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Seattle SuperSonics": "OKC", // moved 2008
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
};

/** 538 fran_id → the same franchise codes (modern franchises only; defunct
 *  franchises keep their fran_id so deep-history Elo still replays cleanly). */
const FRAN_TO_CODE: Record<string, string> = {
  Hawks: "ATL",
  Celtics: "BOS",
  Nets: "BKN",
  Hornets: "CHA", // 538 assigns Bobcats→Hornets continuity to the CHA line
  Bulls: "CHI",
  Cavaliers: "CLE",
  Mavericks: "DAL",
  Nuggets: "DEN",
  Pistons: "DET",
  Warriors: "GSW",
  Rockets: "HOU",
  Pacers: "IND",
  Clippers: "LAC",
  Lakers: "LAL",
  Grizzlies: "MEM",
  Heat: "MIA",
  Bucks: "MIL",
  Timberwolves: "MIN",
  Pelicans: "NOP",
  Knicks: "NYK",
  Thunder: "OKC",
  Magic: "ORL",
  Sixers: "PHI",
  Suns: "PHX",
  Trailblazers: "POR",
  Kings: "SAC",
  Spurs: "SAS",
  Raptors: "TOR",
  Jazz: "UTA",
  Wizards: "WAS",
};

/** First postseason game date per season-end-year (play-in counts as
 *  postseason). Games on/after the date are flagged playoff. */
const NBA_PLAYOFF_START: Record<number, string> = {
  2008: "2008-04-19",
  2009: "2009-04-18",
  2010: "2010-04-17",
  2011: "2011-04-16",
  2012: "2012-04-28",
  2013: "2013-04-20",
  2014: "2014-04-19",
  2015: "2015-04-18",
  2016: "2016-04-16",
  2017: "2017-04-15",
  2018: "2018-04-14",
  2019: "2019-04-13",
  2020: "2020-08-15", // bubble: seeding games treated as regular season
  2021: "2021-05-18",
  2022: "2022-04-12",
  2023: "2023-04-11",
  2024: "2024-04-16",
  2025: "2025-04-15",
};

// ------------------------------------------------------------------- types

export type NbaGame = {
  date: string; // YYYY-MM-DD
  season: number; // season end year (2008 = 2007-08)
  playoff: 0 | 1;
  home: string;
  away: string;
  hs: number;
  as: number;
  /** Signed closing spread, home perspective: positive = home favored. */
  spread: number | null;
  total: number | null;
  mlH: number | null; // American odds
  mlA: number | null;
  restH: number; // days since previous game, capped 7 (7 = opener too)
  restA: number;
};

export type NflGame = {
  date: string;
  season: number;
  week: number;
  type: string; // REG | WC | DIV | CON | SB (nflverse game_type)
  home: string;
  away: string;
  hs: number;
  as: number;
  spread: number | null; // nflverse spread_line: positive = home favored
  total: number | null;
  mlH: number | null;
  mlA: number | null;
  restH: number;
  restA: number;
  div: 0 | 1;
  dome: 0 | 1;
  qbH: string;
  qbA: string;
  neutral: 0 | 1; // Super Bowls / international
};

// ------------------------------------------------------------- NBA (odds era)

function collectNbaOddsEra(): NbaGame[] {
  const db = new Database(`${CACHE}/nba-odds.sqlite`, { readonly: true });
  const tableNames = (
    db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

  // Season label like "2007-08" → the tables that may hold it, best first.
  const seasons: string[] = [];
  for (let y = 2007; y <= 2025; y++) seasons.push(`${y}-${String((y + 1) % 100).padStart(2, "0")}`);

  const games = new Map<string, NbaGame>(); // key date|home|away, first (preferred) wins
  let spreadless = 0;

  for (const season of seasons) {
    const endYear = Number(season.slice(0, 4)) + 1;
    const candidates = [`odds_${season}_new`, season, `odds_${season}`].filter((t) =>
      tableNames.includes(t),
    );
    if (candidates.length === 0) continue;

    for (const table of candidates) {
      const rows = db.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      // Rows with a malformed date (e.g. "2007-08-0102" in the legacy tables)
      // are dropped; the _new tables cover those seasons cleanly.
      const clean = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.Date)));
      if (clean.length === 0) continue;

      // Spread convention: if the table ever stores a negative spread it is
      // already signed (home perspective); otherwise it is |favorite margin|
      // and the moneyline tells us who the favorite is.
      const signed = clean.some((r) => Number(r.Spread) < 0);

      for (const r of clean) {
        const home = NBA_NAME_TO_CODE[String(r.Home)];
        const away = NBA_NAME_TO_CODE[String(r.Away)];
        if (!home || !away) throw new Error(`unmapped NBA team: ${r.Home} / ${r.Away}`);
        const date = String(r.Date);
        const key = `${date}|${home}|${away}`;
        if (games.has(key)) continue; // earlier candidate table already provided it

        const points = Number(r.Points);
        const margin = Number(r.Win_Margin);
        if (!Number.isFinite(points) || !Number.isFinite(margin)) continue;
        const hs = (points + margin) / 2;
        const as = (points - margin) / 2;
        if (!Number.isInteger(hs) || !Number.isInteger(as) || hs === as) continue;

        const mlH = parseMl(r.ML_Home);
        const mlA = parseMl(r.ML_Away);
        let spread: number | null = Number(r.Spread);
        if (!Number.isFinite(spread as number)) spread = null;
        if (spread !== null && !signed) {
          // unsigned: favorite margin; home is the favorite iff its ML is lower
          if (mlH !== null && mlA !== null) {
            if (mlH > mlA) spread = -spread;
          } else {
            spread = null; // can't resolve the sign without a moneyline
            spreadless++;
          }
        }

        games.set(key, {
          date,
          season: endYear,
          playoff: NBA_PLAYOFF_START[endYear] && date >= NBA_PLAYOFF_START[endYear] ? 1 : 0,
          home,
          away,
          hs,
          as,
          spread,
          total: Number.isFinite(Number(r.OU)) ? Number(r.OU) : null,
          mlH,
          mlA,
          restH: 7,
          restA: 7,
        });
      }
    }
  }
  db.close();

  const list = [...games.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home),
  );
  computeRest(list);
  if (spreadless) console.log(`  (nba: ${spreadless} spreads dropped, sign unresolvable)`);
  return list;
}

function parseMl(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^-\d.]/g, ""));
  // American odds are never in (-100, 100); junk like 0 or NL becomes null
  return Number.isFinite(n) && Math.abs(n) >= 100 ? Math.round(n) : null;
}

/** Recompute rest for both sides from the corpus itself: days since the
 *  team's previous game, capped at 7 (openers get 7). Mutates in place. */
function computeRest(
  list: {
    date: string;
    home: string;
    away: string;
    restH: number;
    restA: number;
    season: number;
  }[],
) {
  const last = new Map<string, string>(); // team|season → last date
  for (const g of list) {
    for (const side of ["home", "away"] as const) {
      const team = g[side];
      const key = `${team}|${g.season}`;
      const prev = last.get(key);
      const rest = prev ? Math.min(7, Math.max(0, daysBetween(prev, g.date) - 1)) : 7;
      if (side === "home") g.restH = rest;
      else g.restA = rest;
      last.set(key, g.date);
    }
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// ------------------------------------------------------- NBA deep history (538)

type NbaHist = {
  date: string;
  season: number;
  playoff: 0 | 1;
  neutral: 0 | 1;
  home: string; // franchise code, or raw fran_id for defunct franchises
  away: string;
  hs: number;
  as: number;
  /** 538's published pre-game home win probability (their Elo). */
  p538: number | null;
};

function collectNbaHistory(): NbaHist[] {
  const raw = readFileSync(`${CACHE}/nba-allelo.csv`, "utf8");
  const rows = parseCsv(raw);
  const out: NbaHist[] = [];
  for (const r of rows) {
    if (r.lg_id !== "NBA" || r._iscopy !== "0") continue;
    // one row per game, from the listed team's perspective; game_location H
    // means the listed team is home, N is neutral (listed team = nominal home)
    const loc = r.game_location;
    const [m, d, y] = r.date_game.split("/").map(Number);
    const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const team = FRAN_TO_CODE[r.fran_id] ?? r.fran_id;
    const opp = FRAN_TO_CODE[r.opp_fran] ?? r.opp_fran;
    const pts = Number(r.pts);
    const oppPts = Number(r.opp_pts);
    if (pts === oppPts) continue; // no ties in modern data; guard anyway
    const listedIsHome = loc !== "A";
    out.push({
      date,
      season: Number(r.year_id),
      playoff: r.is_playoffs === "1" ? 1 : 0,
      neutral: loc === "N" ? 1 : 0,
      home: listedIsHome ? team : opp,
      away: listedIsHome ? opp : team,
      hs: listedIsHome ? pts : oppPts,
      as: listedIsHome ? oppPts : pts,
      p538: r.forecast ? (listedIsHome ? Number(r.forecast) : 1 - Number(r.forecast)) : null,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
  return out;
}

// A tolerant CSV line parser (nbaallelo/nfl-games have no embedded newlines;
// nfl-games quotes some fields).
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = vals[i] ?? ""));
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// --------------------------------------------------------------------- NFL

const NFL_RELOCATE: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };

function collectNfl(): NflGame[] {
  const rows = parseCsv(readFileSync(`${CACHE}/nfl-games.csv`, "utf8"));
  const out: NflGame[] = [];
  for (const r of rows) {
    if (r.home_score === "" || r.away_score === "") continue; // unplayed
    const home = NFL_RELOCATE[r.home_team] ?? r.home_team;
    const away = NFL_RELOCATE[r.away_team] ?? r.away_team;
    out.push({
      date: r.gameday,
      season: Number(r.season),
      week: Number(r.week),
      type: r.game_type,
      home,
      away,
      hs: Number(r.home_score),
      as: Number(r.away_score),
      spread: r.spread_line === "" ? null : Number(r.spread_line),
      total: r.total_line === "" ? null : Number(r.total_line),
      mlH: r.home_moneyline === "" ? null : Number(r.home_moneyline),
      mlA: r.away_moneyline === "" ? null : Number(r.away_moneyline),
      restH: Math.min(14, Number(r.home_rest) || 7),
      restA: Math.min(14, Number(r.away_rest) || 7),
      div: r.div_game === "1" ? 1 : 0,
      dome: r.roof === "dome" || r.roof === "closed" ? 1 : 0,
      qbH: r.home_qb_name,
      qbA: r.away_qb_name,
      neutral: r.location === "Neutral" ? 1 : 0,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
  return out;
}

// ------------------------------------------------- ESPN results top-up (NBA)

/** The odds corpus truncates the 2023-24 season at Apr 28 2024 (source quirk).
 *  Fill the missing playoff results (scores only, odds stay null) from ESPN
 *  scoreboards so the rating replay has no mid-corpus hole. Results are cached
 *  to .backtest-cache/nba-espn-fill.json after the first run. */
async function espnFill(): Promise<NbaGame[]> {
  const cachePath = `${CACHE}/nba-espn-fill.json`;
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as NbaGame[];

  const out: NbaGame[] = [];
  const start = Date.parse("2024-04-29");
  const end = Date.parse("2024-06-18");
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const yyyymmdd = d.replace(/-/g, "");
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}`;
    // curl instead of fetch: it is pre-configured for this environment's
    // TLS-intercepting proxy, which bun's fetch does not negotiate with.
    const proc = Bun.spawnSync(["curl", "-sS", "--max-time", "30", url]);
    if (proc.exitCode !== 0) throw new Error(`ESPN ${d}: curl exit ${proc.exitCode}`);
    const data = JSON.parse(proc.stdout.toString()) as {
      events?: {
        status: { type: { name: string } };
        competitions: {
          competitors: {
            homeAway: string;
            score: string;
            team: { displayName: string };
          }[];
        }[];
      }[];
    };
    for (const ev of data.events ?? []) {
      if (ev.status.type.name !== "STATUS_FINAL") continue;
      const comp = ev.competitions[0];
      const h = comp.competitors.find((c) => c.homeAway === "home")!;
      const a = comp.competitors.find((c) => c.homeAway === "away")!;
      const home = NBA_NAME_TO_CODE[h.team.displayName];
      const away = NBA_NAME_TO_CODE[a.team.displayName];
      if (!home || !away) continue; // all-star etc.
      out.push({
        date: d,
        season: 2024,
        playoff: 1,
        home,
        away,
        hs: Number(h.score),
        as: Number(a.score),
        spread: null,
        total: null,
        mlH: null,
        mlA: null,
        restH: 7,
        restA: 7,
      });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  writeFileSync(cachePath, JSON.stringify(out));
  return out;
}

// --------------------------------------------------------------------- main

async function main() {
  for (const f of ["nba-odds.sqlite", "nba-allelo.csv", "nfl-games.csv"]) {
    if (!existsSync(`${CACHE}/${f}`))
      throw new Error(
        `${CACHE}/${f} missing — download it first (see NBA-NFL-ANALYSIS.md data section)`,
      );
  }

  const nba = collectNbaOddsEra();
  const have = new Set(nba.map((g) => `${g.date}|${g.home}|${g.away}`));
  const fill = (await espnFill()).filter((g) => !have.has(`${g.date}|${g.home}|${g.away}`));
  nba.push(...fill);
  nba.sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
  computeRest(nba);
  console.log(`espn fill: +${fill.length} 2023-24 playoff results`);
  writeFileSync(`${CACHE}/nba-games.jsonl`, nba.map((g) => JSON.stringify(g)).join("\n") + "\n");
  const bySeason = new Map<number, { n: number; ml: number; sp: number }>();
  for (const g of nba) {
    const s = bySeason.get(g.season) ?? { n: 0, ml: 0, sp: 0 };
    s.n++;
    if (g.mlH !== null && g.mlA !== null) s.ml++;
    if (g.spread !== null) s.sp++;
    bySeason.set(g.season, s);
  }
  console.log(`nba-games.jsonl: ${nba.length} games, ${bySeason.size} seasons`);
  for (const [s, v] of [...bySeason.entries()].sort())
    console.log(
      `  ${s - 1}-${String(s % 100).padStart(2, "0")}: ${v.n} games, ml ${v.ml}, spread ${v.sp}`,
    );

  const hist = collectNbaHistory();
  writeFileSync(`${CACHE}/nba-history.jsonl`, hist.map((g) => JSON.stringify(g)).join("\n") + "\n");
  console.log(
    `nba-history.jsonl: ${hist.length} games ${hist[0].date} → ${hist[hist.length - 1].date}`,
  );

  const nfl = collectNfl();
  writeFileSync(`${CACHE}/nfl-games.jsonl`, nfl.map((g) => JSON.stringify(g)).join("\n") + "\n");
  const nflMl = nfl.filter((g) => g.mlH !== null).length;
  const nflSp = nfl.filter((g) => g.spread !== null).length;
  console.log(
    `nfl-games.jsonl: ${nfl.length} games ${nfl[0].date} → ${nfl[nfl.length - 1].date}, spread ${nflSp}, ml ${nflMl}`,
  );
}

main();
