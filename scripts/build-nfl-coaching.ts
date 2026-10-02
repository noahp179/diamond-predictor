#!/usr/bin/env node
/**
 * Builds src/lib/sim/nfl-coaching.json — the coaching tendencies the NFL
 * simulator plays with — from nflverse's public play-by-play.
 *
 *   Play calling   Each team's early-down pass rate in neutral game states
 *                  (win probability 20–80%, outside the last two minutes of a
 *                  half), measured against nflverse's expected pass rate for
 *                  each play (down, distance, field position, score, clock).
 *                  A team's raw pass rate mixes its coach's preference with
 *                  how often it was trailing; the engine already bends play
 *                  calls by score and clock, so it needs the preference alone.
 *   Fourth downs   The league's go-for-it rate by distance and field position
 *                  over the last two seasons (the engine's base decision), and
 *                  each head coach's go rate on 4th and 5 or less between his
 *                  own 25 and the opponent's 20 against what the league did
 *                  from the same distance and spot that season.
 *
 * Both are regressed hard toward the league, because neither is very stable:
 * across seasons a team's pass-rate-over-expected correlates ~0.3–0.45 with
 * itself and a coach's fourth-down aggressiveness ~0.1–0.6 (about 27
 * decisions a season each). What this script measured and rejected — matchup
 * effects of individual cornerbacks, 40 times and heights, man/zone and blitz
 * splits — is written up in SIMULATOR.md.
 *
 * Run (re-run weekly in season; it takes about a minute):
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/build-nfl-coaching.ts [season]
 */

import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download/pbp";
/** nflverse → ESPN team abbreviations, where they differ. */
const ESPN_ABBR: Record<string, string> = { LA: "LAR", WAS: "WSH" };
/** Pseudo-plays and pseudo-decisions of league average added before dividing. */
const PASS_K = 600;
const GO_K = 50;

const now = new Date();
const SEASON =
  Number(process.argv[2]) ||
  (now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);
const SEASONS = [SEASON - 3, SEASON - 2, SEASON - 1, SEASON];

type Play = Record<string, string>;
const COLS = [
  "season_type",
  "week",
  "posteam",
  "home_team",
  "home_coach",
  "away_coach",
  "down",
  "ydstogo",
  "yardline_100",
  "wp",
  "qtr",
  "half_seconds_remaining",
  "play_type",
  "pass",
  "xpass",
] as const;

async function load(season: number): Promise<Play[] | null> {
  const res = await fetch(`${RELEASE}/play_by_play_${season}.csv.gz`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`play_by_play_${season}: HTTP ${res.status}`);
  const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
  return parseCsv(text).filter((p) => p.season_type === "REG");
}

/** CSV with quoted fields (which may hold commas or newlines); keeps only COLS. */
function parseCsv(text: string): Play[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const header = rows[0];
  const idx = COLS.map((c) => header.indexOf(c));
  if (idx.some((i) => i < 0))
    throw new Error(`play-by-play is missing a column: ${COLS.join(", ")}`);
  return rows.slice(1).map((r) => Object.fromEntries(COLS.map((c, k) => [c, r[idx[k]] ?? ""])));
}

const num = (s: string) => (s === "" || s === "NA" ? NaN : Number(s));
const espn = (t: string) => ESPN_ABBR[t] ?? t;
const coachOf = (p: Play) => (p.posteam === p.home_team ? p.home_coach : p.away_coach);

/** Early downs, neutral game state, a real run or pass with an expected pass rate. */
function neutralEarlyDown(p: Play): boolean {
  const wp = num(p.wp);
  return (
    (p.down === "1" || p.down === "2") &&
    (p.play_type === "pass" || p.play_type === "run") &&
    Number(p.qtr) <= 4 &&
    num(p.half_seconds_remaining) > 120 &&
    wp >= 0.2 &&
    wp <= 0.8 &&
    Number.isFinite(num(p.xpass))
  );
}

/** A fourth down where going for it is a live option. */
function fourthDecision(p: Play): boolean {
  const ytg = num(p.ydstogo);
  const yl = num(p.yardline_100);
  const wp = num(p.wp);
  return (
    p.down === "4" &&
    ["pass", "run", "punt", "field_goal"].includes(p.play_type) &&
    Number(p.qtr) <= 4 &&
    ytg <= 5 &&
    yl >= 20 &&
    yl <= 75 &&
    wp >= 0.1 &&
    wp <= 0.9
  );
}

const went = (p: Play) => p.play_type === "pass" || p.play_type === "run";

/** Any fourth down outside the end-of-game scramble (the engine has its own
 *  rules there): win probability 10–90%, kick or go. */
function anyFourth(p: Play): boolean {
  const wp = num(p.wp);
  return (
    p.down === "4" &&
    ["pass", "run", "punt", "field_goal"].includes(p.play_type) &&
    Number(p.qtr) <= 4 &&
    wp >= 0.1 &&
    wp <= 0.9 &&
    Number.isFinite(num(p.ydstogo)) &&
    Number.isFinite(num(p.yardline_100))
  );
}
/** Table key: yards to go (10 = 10+) and yards from the goal line by tens. */
const tableKey = (ytg: number, yl100: number) =>
  `${Math.min(10, Math.max(1, Math.round(ytg)))}:${Math.min(9, Math.floor(yl100 / 10))}`;
const spot = (p: Play) => `${Math.min(5, num(p.ydstogo))}:${Math.floor(num(p.yardline_100) / 10)}`;

async function main() {
  const bySeason = new Map<number, Play[]>();
  for (const s of SEASONS) {
    const plays = await load(s);
    if (plays) bySeason.set(s, plays);
    console.log(`${s}: ${plays ? plays.length : "not published"} regular-season plays`);
  }
  const latest = Math.max(...bySeason.keys());
  const prev = latest - 1;

  // Each team's head coach and each season's coach, by the last game played.
  const coach = new Map<string, string>(); // `${season}:${team}` → coach
  for (const [s, plays] of bySeason) {
    const lastWeek = new Map<string, number>();
    for (const p of plays) {
      if (!p.posteam) continue;
      const k = `${s}:${p.posteam}`;
      const w = Number(p.week);
      if (w >= (lastWeek.get(k) ?? -1)) {
        lastWeek.set(k, w);
        coach.set(k, coachOf(p));
      }
    }
  }

  // --- play calling: pass − expected pass on neutral early downs
  const passW = (s: number, team: string) => {
    if (s === latest) return 1;
    if (s !== prev) return 0;
    // Last season counts for half as much, and barely at all under a new coach.
    return coach.get(`${s}:${team}`) === coach.get(`${latest}:${team}`) ? 0.5 : 0.15;
  };
  const pass = new Map<string, { oe: number; n: number }>();
  let lgPass = 0;
  let lgN = 0;
  for (const [s, plays] of bySeason) {
    for (const p of plays) {
      if (!p.posteam || !neutralEarlyDown(p)) continue;
      if (s === latest) {
        lgPass += Number(p.pass);
        lgN++;
      }
      const w = passW(s, p.posteam);
      if (!w) continue;
      const t = pass.get(p.posteam) ?? { oe: 0, n: 0 };
      t.oe += w * (Number(p.pass) - num(p.xpass));
      t.n += w;
      pass.set(p.posteam, t);
    }
  }

  // --- fourth downs: each coach's go rate against the league's from the same spot
  const goW: Record<number, number> = {
    [latest]: 1,
    [latest - 1]: 0.8,
    [latest - 2]: 0.6,
    [latest - 3]: 0.4,
  };
  const go = new Map<string, { over: number; n: number }>();
  let lgGo = 0;
  let lgGoN = 0;
  for (const [s, plays] of bySeason) {
    const decisions = plays.filter((p) => p.posteam && fourthDecision(p));
    const base = new Map<string, [number, number]>();
    for (const p of decisions) {
      const b = base.get(spot(p)) ?? [0, 0];
      b[0] += went(p) ? 1 : 0;
      b[1]++;
      base.set(spot(p), b);
    }
    for (const p of decisions) {
      const [g, n] = base.get(spot(p))!;
      const c = coachOf(p);
      const t = go.get(c) ?? { over: 0, n: 0 };
      t.over += goW[s] * ((went(p) ? 1 : 0) - g / n);
      t.n += goW[s];
      go.set(c, t);
      // The league's rate over the last two seasons, for display.
      if (s >= prev) {
        lgGo += went(p) ? 1 : 0;
        lgGoN++;
      }
    }
  }

  // --- the league's go rate from every spot, last two seasons, smoothed
  // toward the rate at that distance across all field positions.
  const cell = new Map<string, [number, number]>();
  const byYtg = new Map<number, [number, number]>();
  for (const [s, plays] of bySeason) {
    if (s < prev) continue;
    for (const p of plays) {
      if (!p.posteam || !anyFourth(p)) continue;
      const ytg = Math.min(10, Math.max(1, Math.round(num(p.ydstogo))));
      const k = tableKey(ytg, num(p.yardline_100));
      const c = cell.get(k) ?? [0, 0];
      const y = byYtg.get(ytg) ?? [0, 0];
      c[0] += went(p) ? 1 : 0;
      c[1]++;
      y[0] += went(p) ? 1 : 0;
      y[1]++;
      cell.set(k, c);
      byYtg.set(ytg, y);
    }
  }
  const goTable: Record<string, number> = {};
  for (const [k, [g, n]] of [...cell].sort()) {
    const [y] = byYtg.get(Number(k.split(":")[0]))!;
    const coarse = y / byYtg.get(Number(k.split(":")[0]))![1];
    goTable[k] = Math.round(((g + 8 * coarse) / (n + 8)) * 1000) / 1000;
  }

  // Thin cells deep in a team's own end are noise (and fakes). Coaches never
  // get more aggressive with more yards to go, or deeper in their own end.
  const at = (y: number, d: number) => goTable[`${y}:${d}`];
  for (let d = 0; d <= 9; d++)
    for (let y = 2; y <= 10; y++)
      if (at(y, d) !== undefined && at(y - 1, d) !== undefined)
        goTable[`${y}:${d}`] = Math.min(at(y, d), at(y - 1, d));
  for (let y = 1; y <= 10; y++)
    for (let d = 6; d <= 9; d++)
      if (at(y, d) !== undefined && at(y, d - 1) !== undefined)
        goTable[`${y}:${d}`] = Math.min(at(y, d), at(y, d - 1));

  const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  const teams: Record<string, unknown> = {};
  for (const [team, t] of [...pass].sort()) {
    const c = coach.get(`${latest}:${team}`) ?? "";
    const g = go.get(c) ?? { over: 0, n: 0 };
    teams[espn(team)] = {
      coach: c,
      passOffset: round(t.oe / (t.n + PASS_K)),
      passOffsetRaw: round(t.n ? t.oe / t.n : 0),
      passPlays: Math.round(t.n),
      goOffset: round(g.over / (g.n + GO_K)),
      goOffsetRaw: round(g.n ? g.over / g.n : 0),
      goDecisions: Math.round(g.n),
    };
  }
  const out = {
    asOf: new Date().toISOString().slice(0, 10),
    season: latest,
    source: "nflverse play-by-play (github.com/nflverse/nflverse-data)",
    league: {
      earlyDownPass: round(lgPass / Math.max(1, lgN)),
      fourthGo: round(lgGo / Math.max(1, lgGoN)),
      goTable,
    },
    teams,
  };
  writeFileSync("src/lib/sim/nfl-coaching.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${Object.keys(teams).length} teams, season ${latest}`);
  const list = Object.entries(teams) as [
    string,
    { coach: string; passOffset: number; goOffset: number },
  ][];
  const by = (k: "passOffset" | "goOffset") => list.slice().sort((a, b) => b[1][k] - a[1][k]);
  console.log(
    "most pass-happy:",
    by("passOffset")
      .slice(0, 3)
      .map(([t, v]) => `${t} ${v.passOffset}`)
      .join(", "),
  );
  console.log(
    "most run-heavy:",
    by("passOffset")
      .slice(-3)
      .map(([t, v]) => `${t} ${v.passOffset}`)
      .join(", "),
  );
  console.log(
    "most aggressive:",
    by("goOffset")
      .slice(0, 3)
      .map(([t, v]) => `${t} ${v.coach} ${v.goOffset}`)
      .join(", "),
  );
  console.log(
    "least aggressive:",
    by("goOffset")
      .slice(-3)
      .map(([t, v]) => `${t} ${v.coach} ${v.goOffset}`)
      .join(", "),
  );
}

await main();
