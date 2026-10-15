#!/usr/bin/env node
/**
 * How the MLB prop boards would have done on playoff games.
 *
 * The models were fitted on the regular season only; the boards now price the
 * playoffs too. This replays the boards' own code — propsSlate, twoBaseSlate,
 * stacksSlate, exactly what the page and the ledger call — on every postseason
 * date of 2024, 2025 and 2026 so far, and grades each price against the box
 * score by the rule its market is settled by. Everything a board reads is
 * as of that morning: game logs are cut at the date, lineups and probable
 * starters are the ones MLB listed, and the regular season they lean on was
 * over before the first playoff game.
 *
 *   FORM=all      recent form counts playoff games (what ships)
 *   FORM=regular  recent form from regular-season games only (the alternative)
 *   DATES=post    every postseason date (default)
 *   DATES=sept    every other September 2026 date — the regular-season baseline,
 *                 run through this same harness so the comparison is like for like
 *   SHIFT=off     the models' own prices, before the playoff correction (default:
 *                 research/mlb-props/postseason_shift.py fits the correction to
 *                 these); SHIFT=on prices as the boards now ship them
 *
 *   FORM=all DATES=post npx tsx scripts/backtest-mlb-postseason.ts
 *
 * Writes the summary to research/mlb-props/postseason/<DATES>-<FORM>.json and
 * every graded price to research/mlb-props/data/postseason/ (a dataset, not
 * committed). MLB responses are cached on disk (MLB_CACHE) so the second
 * variant reuses the first's calls.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const FORM = process.env.FORM ?? "all";
const DATES = process.env.DATES ?? "post";
const SHIFT = process.env.SHIFT ?? "off";
const CACHE = process.env.MLB_CACHE ?? "/tmp/mlb-postseason-cache";
const NAME = `${DATES}-${FORM}${SHIFT === "on" ? "-shipped" : ""}.json`;
/** The summary, committed. */
const OUT = join(process.cwd(), "research/mlb-props/postseason", NAME);
/** Every graded price, for postseason_shift.py — a dataset, so not committed. */
const ROWS = join(process.cwd(), "research/mlb-props/data/postseason", NAME);
const API = "https://statsapi.mlb.com/api/v1";
mkdirSync(CACHE, { recursive: true });

// ---- fetch: the FORM=regular rewrite, and a disk cache for MLB's API
const realFetch = globalThis.fetch;
const empty = () =>
  new Response(JSON.stringify({ stats: [{ splits: [] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (FORM === "regular") {
    url = url.replace("gameType=[R,P]", "gameType=R");
    if (url.includes("/teams/stats") && /gameType=P(&|$)/.test(url)) return empty();
    if (url.includes("/schedule") && url.includes("startDate="))
      url = url.replace("gameType=R,F,D,L,W", "gameType=R");
  }
  if (!url.startsWith(API)) return realFetch(url, init);
  const file = join(CACHE, createHash("sha1").update(url).digest("hex") + ".json");
  if (existsSync(file))
    return new Response(readFileSync(file), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await realFetch(url, { ...init, signal: AbortSignal.timeout(45000) });
      if (!res.ok) return res;
      const body = await res.text();
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, file);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}) as typeof fetch;

// The playoff correction is fitted to the raw prices, so by default it is
// switched off here (the JSON module is one shared object).
const playoffAdjust = (await import("../src/lib/mlb-postseason.json")).default;
if (SHIFT !== "on")
  for (const k of Object.keys(playoffAdjust.shift))
    (playoffAdjust.shift as Record<string, number>)[k] = 0;

const { propsSlate, mlbPropOutcome } = await import("../src/lib/mlb-props.server");
const { twoBaseSlate } = await import("../src/lib/mlb-tb2.server");
const { stacksSlate } = await import("../src/lib/mlb-stacks.server");
const { boardPicks } = await import("../src/lib/props-board");
const propsModel = (await import("../src/lib/mlb-props-model.json")).default;

const getJson = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

// ---- which dates
async function postseasonDates(): Promise<{ date: string; games: number[] }[]> {
  const out: { date: string; games: number[] }[] = [];
  for (const season of [2024, 2025, 2026]) {
    const d = await getJson(
      `${API}/schedule?sportId=1&gameType=F,D,L,W&startDate=${season}-09-20&endDate=${season}-11-15`,
    );
    for (const day of d?.dates ?? []) {
      const games = (day?.games ?? [])
        .filter((g: { status?: { codedGameState?: string } }) =>
          ["F", "O"].includes(g?.status?.codedGameState ?? ""),
        )
        .map((g: { gamePk: number }) => g.gamePk);
      if (games.length) out.push({ date: day.date, games });
    }
  }
  return out;
}
async function septemberDates(): Promise<{ date: string; games: number[] }[]> {
  const d = await getJson(
    `${API}/schedule?sportId=1&gameType=R&startDate=2026-09-01&endDate=2026-09-27`,
  );
  return (d?.dates ?? [])
    .filter((_: unknown, i: number) => i % 2 === 0)
    .map(
      (day: {
        date: string;
        games: { gamePk: number; status?: { codedGameState?: string } }[];
      }) => ({
        date: day.date,
        games: day.games
          .filter((g) => ["F", "O"].includes(g?.status?.codedGameState ?? ""))
          .map((g) => g.gamePk),
      }),
    );
}

// ---- box scores, parsed the way prop-ledger.server's mlbBox parses them
type Box = {
  bat: Map<
    number,
    { pa: number; h: number; tb: number; hr: number; rbi: number; r: number; sb: number }
  >;
  pit: Map<number, { k: number; outs: number; gs: number }>;
  runs: Map<number, number>;
};
async function box(gamePk: number): Promise<Box> {
  const d = await getJson(`${API}/game/${gamePk}/boxscore`);
  const b: Box = { bat: new Map(), pit: new Map(), runs: new Map() };
  for (const side of ["away", "home"]) {
    const t = d?.teams?.[side];
    b.runs.set(Number(t?.team?.id), Number(t?.teamStats?.batting?.runs ?? 0));
    type BoxPlayer = {
      person?: { id?: number };
      stats?: { batting?: Record<string, number>; pitching?: Record<string, number> };
    };
    for (const p of Object.values<BoxPlayer>(t?.players ?? {})) {
      const id = Number(p?.person?.id);
      const s = p?.stats?.batting;
      if (s && Object.keys(s).length)
        b.bat.set(id, {
          pa: Number(s.plateAppearances ?? 0),
          h: Number(s.hits ?? 0),
          tb: Number(s.totalBases ?? 0),
          hr: Number(s.homeRuns ?? 0),
          rbi: Number(s.rbi ?? 0),
          r: Number(s.runs ?? 0),
          sb: Number(s.stolenBases ?? 0),
        });
      const q = p?.stats?.pitching;
      if (q && Object.keys(q).length)
        b.pit.set(id, {
          k: Number(q.strikeOuts ?? 0),
          outs: Number(q.outs ?? 0),
          gs: Number(q.gamesStarted ?? 0),
        });
    }
  }
  return b;
}

// ---- rows: one graded price each
type Row = {
  date: string;
  game: number;
  board: "props" | "tb2" | "stacks";
  market: string;
  id: number;
  prob: number;
  /** Shown: in the board's top picks (props), a game card's top three (tb2). */
  shown: boolean;
  hit: 0 | 1;
  /** Team totals only: projected and actual runs. */
  exp?: number;
  runs?: number;
};

const rows: Row[] = [];
const dates = (DATES === "sept" ? await septemberDates() : await postseasonDates()).slice(
  0,
  Number(process.env.LIMIT ?? Infinity),
);
console.error(
  `${DATES}/${FORM}/shift-${SHIFT}: ${dates.length} dates, ${dates.reduce((s, d) => s + d.games.length, 0)} games`,
);

for (const { date, games } of dates) {
  const finals = new Set(games);
  const boxes = new Map<number, Box>();
  const boxOf = async (pk: number) => {
    if (!boxes.has(pk)) boxes.set(pk, await box(pk));
    return boxes.get(pk)!;
  };
  try {
    const props = await propsSlate(date);
    for (const g of props.games) {
      if (!finals.has(g.gameId)) continue;
      const b = await boxOf(g.gameId);
      const top = new Set(
        boardPicks(g.picks, "all", false).map((p) => `${p.playerId}:${p.market}`),
      );
      for (const p of g.picks) {
        const y = mlbPropOutcome(
          p.market,
          p.kind === "batter" ? (b.bat.get(p.playerId) ?? null) : null,
          p.kind === "pitcher" ? (b.pit.get(p.playerId) ?? null) : null,
        );
        if (y == null) continue; // void: no plate appearance / did not start
        rows.push({
          date,
          game: g.gameId,
          board: "props",
          market: p.market,
          id: p.playerId,
          prob: p.prob,
          shown: top.has(`${p.playerId}:${p.market}`),
          hit: y ? 1 : 0,
        });
      }
    }

    const tb2 = await twoBaseSlate(date);
    for (const g of tb2.byGame) {
      if (!finals.has(g.gameId)) continue;
      const b = await boxOf(g.gameId);
      g.picks.forEach((p, i) => {
        const line = b.bat.get(p.playerId);
        if (!line || line.pa <= 0) return;
        rows.push({
          date,
          game: g.gameId,
          board: "tb2",
          market: "tb2",
          id: p.playerId,
          prob: p.prob,
          shown: i < 3,
          hit: line.tb >= 2 ? 1 : 0,
        });
      });
    }

    const stacks = await stacksSlate(date);
    for (const t of stacks.teams) {
      if (!finals.has(t.gameId)) continue;
      const b = await boxOf(t.gameId);
      for (const tot of t.totals) {
        rows.push({
          date,
          game: t.gameId,
          board: "stacks",
          market: tot.market,
          id: t.teamId,
          prob: tot.prob,
          shown: true,
          hit: (b.runs.get(t.teamId) ?? 0) > tot.line ? 1 : 0,
          exp: t.expRuns,
          runs: b.runs.get(t.teamId) ?? 0,
        });
      }
    }
    console.error(`  ${date}: ${games.length} games, ${rows.length} rows so far`);
  } catch (err) {
    console.error(`  ${date}: FAILED`, err);
  }
}

// ---- summaries
const BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
function summary(rs: Row[], base?: number) {
  const n = rs.length;
  if (!n) return { n: 0 };
  const said = rs.reduce((s, r) => s + r.prob, 0) / n;
  const hit = rs.reduce((s, r) => s + r.hit, 0) / n;
  const brier = rs.reduce((s, r) => s + (r.prob - r.hit) ** 2, 0) / n;
  const b0 = base ?? hit;
  const brierBase = rs.reduce((s, r) => s + (b0 - r.hit) ** 2, 0) / n;
  return { n, said, hit, brier, brierBase };
}
function bands(rs: Row[]) {
  return BANDS.slice(0, -1)
    .map((lo, i) => {
      const inBand = rs.filter((r) => r.prob >= lo && r.prob < BANDS[i + 1]);
      return {
        lo,
        hi: Math.min(1, BANDS[i + 1]),
        n: inBand.length,
        said: inBand.length ? inBand.reduce((s, r) => s + r.prob, 0) / inBand.length : null,
        hit: inBand.length ? inBand.reduce((s, r) => s + r.hit, 0) / inBand.length : null,
      };
    })
    .filter((b) => b.n > 0);
}

const markets = [...new Set(rows.map((r) => `${r.board}:${r.market}`))].sort();
const result = {
  generated: new Date().toISOString(),
  form: FORM,
  dates: DATES,
  span: dates.length ? [dates[0].date, dates[dates.length - 1].date] : null,
  games: new Set(rows.map((r) => r.game)).size,
  boards: Object.fromEntries(
    (["props", "tb2", "stacks"] as const).map((board) => {
      const rs = rows.filter((r) => r.board === board);
      return [
        board,
        {
          all: summary(rs),
          shown: summary(rs.filter((r) => r.shown)),
          bands: bands(rs),
          shownBands: bands(rs.filter((r) => r.shown)),
        },
      ];
    }),
  ),
  markets: Object.fromEntries(
    markets.map((k) => {
      const [board, market] = k.split(":");
      const rs = rows.filter((r) => r.board === board && r.market === market);
      const base =
        board === "props"
          ? (propsModel.markets as Record<string, { base: number }>)[market]?.base
          : undefined;
      return [
        k,
        {
          all: summary(rs, base),
          shown: summary(
            rs.filter((r) => r.shown),
            base,
          ),
        },
      ];
    }),
  ),
  rows,
};
mkdirSync(dirname(OUT), { recursive: true });
mkdirSync(dirname(ROWS), { recursive: true });
writeFileSync(ROWS, JSON.stringify(result));
const { rows: _rows, ...summaryOnly } = result;
writeFileSync(OUT, JSON.stringify(summaryOnly, null, 1) + "\n");
for (const [board, v] of Object.entries(result.boards)) {
  const a = v.all as ReturnType<typeof summary>;
  const s = v.shown as ReturnType<typeof summary>;
  if (!a.n) continue;
  console.log(
    `${DATES}/${FORM} ${board}: ${a.n} priced, said ${(a.said! * 100).toFixed(1)}% came in ${(a.hit! * 100).toFixed(1)}%` +
      ` | shown ${s.n}: said ${((s.said ?? 0) * 100).toFixed(1)}% came in ${((s.hit ?? 0) * 100).toFixed(1)}%`,
  );
}
console.log(`wrote ${OUT}`);
