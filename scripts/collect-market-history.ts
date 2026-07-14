#!/usr/bin/env -S npx tsx
/**
 * Light market-line collector for the Round-8 edge hunt: outcome + stored
 * DraftKings moneyline per settled game, nothing else (no sims, no factors).
 * Used to extend the market-bias/devig sample to dates the heavy Round-7
 * collector never swept (early season).
 *
 *   npx tsx scripts/collect-market-history.ts [--start 2026-03-26] [--end 2026-04-19]
 *                                             [--out .backtest-cache/market-early.jsonl]
 *
 * Resumable like the main collector; read-only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";
import { fetchMoneylineForEvent } from "../src/lib/mlb-odds.server";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Game {
  gamePk: number;
  date: string;
  gameDate: string;
  homeName: string;
  awayName: string;
  hourUTC: number | null;
  y: number;
}

async function fetchSettledGames(start: string, end: string): Promise<Game[]> {
  const url = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=team&startDate=${start}&endDate=${end}`;
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
        homeName: g.teams.home.team.name ?? "",
        awayName: g.teams.away.team.name ?? "",
        hourUTC: g.gameDate ? new Date(g.gameDate).getUTCHours() : null,
        y: hs > as ? 1 : 0,
      });
    }
  }
  return out;
}

async function fetchEspnEvents(date: string) {
  const compact = date.replaceAll("-", "");
  try {
    const res = await fetchWithTimeout(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${compact}`,
      15_000,
    );
    if (!res.ok) return [];
    const json: any = await res.json();
    const out: Array<{ id: string; date: string; homeName: string; awayName: string }> = [];
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

async function main() {
  const start = arg("start", "2026-03-26");
  const end = arg("end", "2026-04-19");
  const outPath = arg("out", ".backtest-cache/market-early.jsonl");
  mkdirSync(dirname(outPath), { recursive: true });
  const done = new Set<string>();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        done.add(JSON.parse(line).date);
      } catch {
        /* redo torn date */
      }
    }
  }

  const games = await fetchSettledGames(start, end);
  const byDate = new Map<string, Game[]>();
  for (const g of games) (byDate.get(g.date) ?? byDate.set(g.date, []).get(g.date)!).push(g);
  const dates = Array.from(byDate.keys()).sort();
  console.log(`${games.length} settled games, ${dates.length} dates (${done.size} already done)`);

  for (const date of dates) {
    if (done.has(date)) continue;
    const day = byDate.get(date)!;
    const espn = await fetchEspnEvents(date);
    const evByPair = new Map<string, typeof espn>();
    for (const e of espn) {
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

    const lines: string[] = [];
    const tasks: Array<() => Promise<void>> = [];
    for (const [pair, arr] of gByPair) {
      const evs = evByPair.get(pair) ?? [];
      arr.forEach((g, i) => {
        const ev = evs[i];
        if (!ev) return;
        tasks.push(async () => {
          const ml = await fetchMoneylineForEvent(ev.id);
          if (!ml) return;
          lines.push(
            JSON.stringify({
              date: g.date,
              gamePk: g.gamePk,
              y: g.y,
              hourUTC: g.hourUTC,
              mlHome: ml.homeMoneyLine,
              mlAway: ml.awayMoneyLine,
            }),
          );
        });
      });
    }
    await batchedAll(tasks, 8);
    if (lines.length > 0) appendFileSync(outPath, lines.join("\n") + "\n");
    console.log(`  ${date}: odds ${lines.length}/${day.length}`);
  }
  console.log("done");
}

main().catch((err) => {
  console.error("💥 market collect failed:", err);
  process.exit(1);
});
