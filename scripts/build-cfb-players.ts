#!/usr/bin/env node
/**
 * Build last season's college football player lines for the game simulator.
 *
 * ESPN's league-wide player feed carries no statistics for college football,
 * so the simulator reads box scores instead (src/lib/sim/cfb-box.ts). The
 * current season is read live, team by team, from the games each team has
 * played. Last season is read once, here, for every FBS game — so a player who
 * transferred brings his numbers with him — and written to
 * src/lib/sim/cfb-<season>.json, which the server imports.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/build-cfb-players.ts 2025
 *   CFB_SAVE=dir …        also keep every raw game summary in dir (for
 *                         benchmarking simulated games against real ones)
 *
 * Re-run once a season, after the bowls, with the season that just ended.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { accumulate, readSummary, type Summary } from "../src/lib/sim/cfb-box";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/college-football";
const season = Number(process.argv[2] ?? new Date().getFullYear() - 1);
const save = process.env.CFB_SAVE;

/** Stats the simulator reads, in the order they are written. */
const CFB_KEYS = [
  "general.gamesPlayed",
  "passing.completions",
  "passing.passingAttempts",
  "passing.passingYards",
  "passing.passingTouchdowns",
  "passing.interceptions",
  "passing.sacks",
  "passing.sackYardsLost",
  "rushing.rushingAttempts",
  "rushing.rushingYards",
  "rushing.rushingTouchdowns",
  "rushing.rushingFumblesLost",
  "receiving.receptions",
  "receiving.receivingYards",
  "receiving.receivingTouchdowns",
  "kicking.fieldGoalsMade",
  "kicking.fieldGoalAttempts",
  "kicking.longFieldGoalMade",
  "kicking.extraPointsMade",
  "kicking.extraPointAttempts",
  ...["1_19", "20_29", "30_39", "40_49", "50"].flatMap((b) => [
    `kicking.fieldGoalsMade${b}`,
    `kicking.fieldGoalAttempts${b}`,
  ]),
  "punting.punts",
  "punting.netYards",
  "defensive.totalTackles",
  "defensive.sacks",
  "defensiveinterceptions.interceptions",
];

async function getJson<T>(url: string): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * i * i));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function pool<T>(items: T[], n: number, run: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await run(items[i], i);
      }
    }),
  );
}

async function main() {
  // Every FBS regular-season game, week by week.
  type Board = { events?: { id: string; status: { type: { completed?: boolean } } }[] };
  const ids = new Set<string>();
  for (let week = 1; week <= 17; week++) {
    const b = await getJson<Board>(
      `${SITE}/scoreboard?groups=80&seasontype=2&week=${week}&dates=${season}&limit=500`,
    );
    for (const e of b.events ?? []) if (e.status.type.completed) ids.add(e.id);
  }
  console.error(`${season}: ${ids.size} completed FBS games`);
  if (save) mkdirSync(save, { recursive: true });

  const totals = new Map<string, { name: string; teamId: string; s: Record<string, number> }>();
  let done = 0;
  await pool([...ids], 8, async (id) => {
    const file = save ? join(save, `${id}.json`) : null;
    let sum: Summary;
    if (file && existsSync(file)) sum = JSON.parse(readFileSync(file, "utf8")) as Summary;
    else {
      sum = await getJson<Summary>(`${SITE}/summary?event=${id}`);
      if (file) writeFileSync(file, JSON.stringify(sum));
    }
    const g = readSummary(sum);
    if (g && g.completed && g.seasonType === 2) for (const t of g.teams) accumulate(totals, t);
    if (++done % 100 === 0) console.error(`  ${done}/${ids.size}`);
  });

  // Positions, from the league feed (which does carry those).
  type ByAthlete = {
    pagination?: { pages?: number };
    athletes?: { athlete: { id: string; position?: { abbreviation?: string } } }[];
  };
  const pos = new Map<string, string>();
  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await getJson<ByAthlete>(
      `${WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false` +
        `&season=${season}&seasontype=2&limit=1000&page=${page}`,
    );
    pages = r.pagination?.pages ?? 1;
    for (const a of r.athletes ?? []) pos.set(a.athlete.id, a.athlete.position?.abbreviation ?? "");
  }

  const players: Record<string, (string | number)[]> = {};
  for (const [id, t] of totals) {
    const vals = CFB_KEYS.map((k) => Math.round((t.s[k] ?? 0) * 10) / 10);
    if (vals.slice(1).every((v) => v === 0)) continue;
    players[id] = [pos.get(id) ?? "", ...vals];
  }
  const out = { season, games: ids.size, keys: CFB_KEYS, players };
  const path = `src/lib/sim/cfb-${season}.json`;
  writeFileSync(path, JSON.stringify(out));
  console.error(`wrote ${path}: ${Object.keys(players).length} players`);
}

void main();
