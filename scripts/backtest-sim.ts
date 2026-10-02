#!/usr/bin/env node
/**
 * Out-of-sample backtest for the game simulator.
 *
 * Replays games that have already been played, building each matchup from the
 * *previous* season's statistics only (SIM_STATS=prior, see loadSeason in
 * build.server.ts), so the simulation never sees the results it is scored on.
 * What it is allowed to know is what is known before first pitch or kickoff:
 * the starting pitcher or quarterback and, in baseball, the posted lineup —
 * both read from the game's box score.
 *
 *   collect   For every finished regular-season game between two dates: the
 *             matchup, the final score, the closing moneyline/spread/total
 *             (ESPN pickcenter) and every player's actual line. Writes JSON.
 *   eval      Simulates each collected game and scores it:
 *               games    log loss and Brier of the home win probability,
 *                        against the market's no-vig probability and a
 *                        home-team constant; calibration slope; how much a
 *                        blend with the market helps; margin and total error.
 *               players  each projected stat's mean against what happened,
 *                        against a naive "last season's per-game average"
 *                        baseline; calibration of the over/under
 *                        probabilities; how often the 10th–90th range held.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/backtest-sim.ts collect mlb 2026-09-01 2026-09-27 out/mlb.json
 *   npx tsx scripts/backtest-sim.ts eval out/mlb.json [games per matchup]
 *
 * Current rosters stand in for the rosters on the day (players since traded
 * or released are missing); with last season's numbers only, rookies are
 * league-average unknowns. Both make the test harder than live use, not
 * easier.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { MassResult } from "../src/lib/sim/aggregate";
import type { SimLeague, SimMatchup, SimOverrides } from "../src/lib/sim/types";

type Actuals = Record<string, Record<string, number>>; // athlete id → prop key → value
type Market = {
  homeMl: number | null;
  awayMl: number | null;
  spread: number | null;
  total: number | null;
};
type Game = {
  id: string;
  date: string;
  matchup: SimMatchup;
  overrides: SimOverrides;
  home: number;
  away: number;
  market: Market;
  players: Actuals;
};

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const PATH: Record<SimLeague, string> = {
  nba: "basketball/nba",
  nfl: "football/nfl",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
};

// ------------------------------------------------------------- collect

type BoxAthlete = {
  athlete: { id: string };
  starter?: boolean;
  batOrder?: number;
  stats: string[];
};
type BoxTeam = {
  team: { id: string };
  statistics: { name?: string; type?: string; labels?: string[]; athletes: BoxAthlete[] }[];
};

async function json<T>(url: string): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return (await r.json()) as T;
    if (i >= 3) throw new Error(`${url}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
}

const n = (s: string | undefined) => {
  const v = Number(String(s ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(v) ? v : 0;
};
const outs = (ip: string) => {
  const [w, f] = ip.split(".");
  return n(w) * 3 + n(f);
};

/** Each player's actual line, keyed like PROPS. */
function actuals(league: SimLeague, box: BoxTeam[]): Actuals {
  const out: Actuals = {};
  const add = (id: string, k: string, v: number) => {
    (out[id] ??= {})[k] = (out[id][k] ?? 0) + v;
  };
  for (const t of box)
    for (const s of t.statistics) {
      const kind = s.name ?? s.type ?? "";
      const lab = s.labels ?? [];
      const at = (a: BoxAthlete, l: string) => a.stats[lab.indexOf(l)];
      for (const a of s.athletes) {
        const id = a.athlete.id;
        if (league === "mlb" && kind === "batting") {
          for (const [l, k] of [
            ["H", "h"],
            ["R", "r"],
            ["RBI", "rbi"],
            ["HR", "hr"],
            ["BB", "bb"],
            ["K", "so"],
          ] as const)
            add(id, k, n(at(a, l)));
          add(id, "hrr", n(at(a, "H")) + n(at(a, "R")) + n(at(a, "RBI")));
        } else if (league === "mlb" && kind === "pitching") {
          add(id, "k", n(at(a, "K")));
          add(id, "outs", outs(at(a, "IP") ?? "0"));
          add(id, "ha", n(at(a, "H")));
          add(id, "er", n(at(a, "ER")));
          add(id, "pbb", n(at(a, "BB")));
        } else if (league === "nfl") {
          if (kind === "passing") {
            add(id, "cmp", n((at(a, "C/ATT") ?? "0/0").split("/")[0]));
            add(id, "pyd", n(at(a, "YDS")));
            add(id, "ptd", n(at(a, "TD")));
            add(id, "int", n(at(a, "INT")));
          } else if (kind === "rushing") {
            add(id, "car", n(at(a, "CAR")));
            add(id, "ryd", n(at(a, "YDS")));
            add(id, "rry", n(at(a, "YDS")));
            add(id, "td", n(at(a, "TD")));
          } else if (kind === "receiving") {
            add(id, "rec", n(at(a, "REC")));
            add(id, "reyd", n(at(a, "YDS")));
            add(id, "rry", n(at(a, "YDS")));
            add(id, "td", n(at(a, "TD")));
          } else if (kind === "kicking") {
            add(id, "fgm", n((at(a, "FG") ?? "0/0").split("/")[0]));
            add(id, "kpts", n(at(a, "PTS")));
          } else if (kind === "defensive") {
            add(id, "tkl", n(at(a, "TOT")));
            add(id, "dsk", n(at(a, "SACKS")));
          } else if (kind === "interceptions") add(id, "dint", n(at(a, "INT")));
        }
      }
    }
  return out;
}

/** What was known before the game: the starting pitcher or quarterback and,
 *  in baseball, the posted lineup. */
function knownBefore(league: SimLeague, m: SimMatchup, box: BoxTeam[]): SimOverrides {
  const o: SimOverrides = { benched: [], activated: [], starter: {} };
  for (const side of ["home", "away"] as const) {
    const t = box.find((b) => b.team.id === m[side].id);
    if (!t) continue;
    if (m.league === "mlb") {
      const bat = t.statistics.find((s) => (s.name ?? s.type) === "batting");
      const pit = t.statistics.find((s) => (s.name ?? s.type) === "pitching");
      const lineup = new Set(
        (bat?.athletes ?? []).filter((a) => a.starter).map((a) => a.athlete.id),
      );
      const sp = pit?.athletes.find((a) => a.starter)?.athlete.id;
      if (sp) o.starter![side] = sp;
      if (lineup.size >= 8)
        for (const b of m[side].batters) {
          if (lineup.has(b.id)) {
            if (b.status !== "active") o.activated.push(b.id);
          } else o.benched.push(b.id);
        }
      if (sp && m[side].pitchers.find((p) => p.id === sp && p.status !== "active"))
        o.activated.push(sp);
    }
    if (m.league === "nfl") {
      const pass = t.statistics.find((s) => s.name === "passing");
      const qb = pass?.athletes[0]?.athlete.id; // most attempts first
      if (qb) {
        o.starter![side] = qb;
        for (const p of m[side].players)
          if (p.pos === "QB") {
            if (p.id === qb && p.status !== "active") o.activated.push(p.id);
            else if (p.id !== qb) o.benched.push(p.id);
          }
      }
      // Anyone who recorded a stat played, whatever today's report says.
      const played = new Set(t.statistics.flatMap((s) => s.athletes.map((a) => a.athlete.id)));
      for (const p of m[side].players)
        if (played.has(p.id) && p.status !== "active" && p.pos !== "QB") o.activated.push(p.id);
    }
  }
  return o;
}

function* dates(from: string, to: string) {
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); ) {
    yield d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 86400000);
  }
}

async function collect(league: SimLeague, from: string, to: string, file: string) {
  process.env.SIM_STATS = "prior";
  const { buildMatchup } = await import("../src/lib/sim/build.server");
  const { scoreboard } = await import("../src/lib/sim/espn-stats.server");
  const out: Game[] = [];
  for (const date of dates(from, to)) {
    const board = (await scoreboard(league, date).catch(() => [])).filter(
      (g) => g.state === "post" && !g.playoff && g.homeScore != null && g.awayScore != null,
    );
    for (const g of board) {
      try {
        const sum = await json<{
          boxscore?: { players?: BoxTeam[] };
          pickcenter?: {
            spread?: number;
            overUnder?: number;
            homeTeamOdds?: { moneyLine?: number };
            awayTeamOdds?: { moneyLine?: number };
          }[];
        }>(`${SITE}/${PATH[league]}/summary?event=${g.id}`);
        const box = sum.boxscore?.players ?? [];
        if (!box.length) continue;
        const m = await buildMatchup({
          league,
          homeId: g.homeId,
          awayId: g.awayId,
          date,
          gameId: g.id,
        });
        const pc = sum.pickcenter?.[0];
        out.push({
          id: g.id,
          date,
          matchup: m,
          overrides: knownBefore(league, m, box),
          home: g.homeScore!,
          away: g.awayScore!,
          market: {
            homeMl: pc?.homeTeamOdds?.moneyLine ?? null,
            awayMl: pc?.awayTeamOdds?.moneyLine ?? null,
            spread: pc?.spread ?? null,
            total: pc?.overUnder ?? null,
          },
          players: actuals(league, box),
        });
      } catch (err) {
        console.warn(`${date} ${g.id}: ${(err as Error).message}`);
      }
    }
    console.log(`${date}: ${out.length} games so far`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  console.log(`wrote ${out.length} games to ${file}`);
}

// ---------------------------------------------------------------- eval

const imp = (ml: number) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
const logit = (p: number) => Math.log(p / (1 - p));
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const clampP = (p: number) => Math.min(0.99, Math.max(0.01, p));
const ll = (p: number, y: number) => -(y * Math.log(clampP(p)) + (1 - y) * Math.log(1 - clampP(p)));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Logistic regression of outcome on one predictor (Newton's method). */
function logistic(x: number[], y: number[]): { a: number; b: number } {
  let a = 0;
  let b = 1;
  for (let it = 0; it < 50; it++) {
    let ga = 0;
    let gb = 0;
    let haa = 0;
    let hab = 0;
    let hbb = 0;
    for (let i = 0; i < x.length; i++) {
      const p = sig(a + b * x[i]);
      const w = p * (1 - p);
      ga += y[i] - p;
      gb += (y[i] - p) * x[i];
      haa += w;
      hab += w * x[i];
      hbb += w * x[i] * x[i];
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    a += (hbb * ga - hab * gb) / det;
    b += (haa * gb - hab * ga) / det;
  }
  return { a, b };
}

export type GameScore = {
  id: string;
  pSim: number;
  pMkt: number | null;
  y: number;
  margin: number;
  simMargin: number;
  total: number;
  simTotal: number;
  spread: number | null;
  mktTotal: number | null;
};
export type PropScore = {
  key: string;
  actual: number;
  sim: number;
  naive: number | null;
  lines: number[];
  over: number[];
  p10: number;
  p90: number;
};

export async function simulate(games: Game[], N: number) {
  const { runner } = await import("../src/lib/sim/engine");
  const { Accumulator } = await import("../src/lib/sim/aggregate");
  const { PROPS } = await import("../src/lib/sim/props");
  const gs: GameScore[] = [];
  const ps: PropScore[] = [];
  for (const g of games) {
    const play = runner(g.matchup, g.overrides);
    const acc = new Accumulator(g.matchup);
    const base = (Number(g.id) * 2654435761) >>> 0;
    for (let i = 0; i < N; i++) acc.add(play((base + i * 7919) >>> 0, false));
    const r: MassResult = acc.summary(0);
    const decided = r.homeWins + r.awayWins;
    const pSim = decided > 0 ? r.homeWins / decided : 0.5;
    const pMkt =
      g.market.homeMl != null && g.market.awayMl != null
        ? imp(g.market.homeMl) / (imp(g.market.homeMl) + imp(g.market.awayMl))
        : null;
    if (g.home !== g.away)
      gs.push({
        id: g.id,
        pSim,
        pMkt,
        y: g.home > g.away ? 1 : 0,
        margin: g.home - g.away,
        simMargin: r.avgHome - r.avgAway,
        total: g.home + g.away,
        simTotal: r.avgHome + r.avgAway,
        spread: g.market.spread,
        mktTotal: g.market.total,
      });
    const defs = PROPS[g.matchup.league];
    for (const p of r.players) {
      const act = g.players[p.id];
      if (!act) continue; // did not play: projections are for players who play
      for (const s of p.props) {
        if (!(s.key in act)) continue;
        const d = defs.find((x) => x.key === s.key)!;
        ps.push({
          key: s.key,
          actual: act[s.key],
          sim: s.mean,
          naive: p.avg?.[s.key] ?? null,
          lines: d.lines,
          over: s.over,
          p10: s.p10,
          p90: s.p90,
        });
      }
    }
  }
  return { gs, ps };
}

export function report(gs: GameScore[], ps: PropScore[]) {
  const lines: string[] = [];
  const priced = gs.filter((g) => g.pMkt != null);
  const homeRate = mean(gs.map((g) => g.y));
  lines.push(
    `games ${gs.length} (priced ${priced.length}), home won ${(homeRate * 100).toFixed(1)}%`,
  );
  const LL = (f: (g: GameScore) => number, set = priced) => mean(set.map((g) => ll(f(g), g.y)));
  const BR = (f: (g: GameScore) => number, set = priced) => mean(set.map((g) => (f(g) - g.y) ** 2));
  lines.push(
    `  log loss  sim ${LL((g) => g.pSim).toFixed(4)}  market ${LL((g) => g.pMkt!).toFixed(4)}  coin-flip-at-home-rate ${LL(() => homeRate).toFixed(4)}`,
  );
  lines.push(
    `  Brier     sim ${BR((g) => g.pSim).toFixed(4)}  market ${BR((g) => g.pMkt!).toFixed(4)}`,
  );
  const cal = logistic(
    priced.map((g) => logit(clampP(g.pSim))),
    priced.map((g) => g.y),
  );
  lines.push(
    `  calibration: outcome ~ logit(sim): slope ${cal.b.toFixed(2)} intercept ${cal.a.toFixed(2)}  (1 and 0 = calibrated; slope < 1 = overconfident)`,
  );
  let best = { w: 0, ll: Infinity };
  for (let w = 0; w <= 1.0001; w += 0.05) {
    const v = LL((g) => sig(w * logit(clampP(g.pSim)) + (1 - w) * logit(clampP(g.pMkt!))));
    if (v < best.ll) best = { w, ll: v };
  }
  lines.push(
    `  best blend: ${(best.w * 100).toFixed(0)}% sim / ${((1 - best.w) * 100).toFixed(0)}% market → log loss ${best.ll.toFixed(4)}`,
  );
  const withSpread = gs.filter((g) => g.spread != null);
  if (withSpread.length) {
    lines.push(
      `  margin MAE  sim ${mean(withSpread.map((g) => Math.abs(g.margin - g.simMargin))).toFixed(2)}  market ${mean(withSpread.map((g) => Math.abs(g.margin + g.spread!))).toFixed(2)}`,
    );
  }
  const withTotal = gs.filter((g) => g.mktTotal != null);
  if (withTotal.length) {
    lines.push(
      `  total  MAE  sim ${mean(withTotal.map((g) => Math.abs(g.total - g.simTotal))).toFixed(2)}  market ${mean(withTotal.map((g) => Math.abs(g.total - g.mktTotal!))).toFixed(2)}   mean total: actual ${mean(withTotal.map((g) => g.total)).toFixed(2)} sim ${mean(withTotal.map((g) => g.simTotal)).toFixed(2)} market ${mean(withTotal.map((g) => g.mktTotal!)).toFixed(2)}`,
    );
  }
  lines.push(`player stats ${ps.length}`);
  const keys = [...new Set(ps.map((p) => p.key))];
  lines.push(
    "  stat    n     actual  sim    naive | MAE sim  naive | over-line Brier sim  naive-Poisson | 10–90 coverage",
  );
  for (const k of keys) {
    const xs = ps.filter((p) => p.key === k && p.naive != null);
    if (xs.length < 30) continue;
    const pois = (lam: number, line: number) => {
      // P(X ≥ line) for Poisson(λ)
      let c = 0;
      let t = Math.exp(-lam);
      for (let i = 0; i < line; i++) {
        c += t;
        t *= lam / (i + 1);
      }
      return 1 - c;
    };
    // A Poisson around last season's average is a fair naive model for
    // counts, not for yardage or outs recorded.
    const counts = !["pyd", "ryd", "reyd", "rry", "outs", "kpts", "tkl"].includes(k);
    let bs = 0;
    let bn = 0;
    let cnt = 0;
    for (const p of xs)
      p.lines.forEach((l, i) => {
        const y = p.actual >= l ? 1 : 0;
        bs += (p.over[i] - y) ** 2;
        bn += (pois(Math.max(0.01, p.naive!), l) - y) ** 2;
        cnt++;
      });
    const naiveBrier = counts ? (bn / cnt).toFixed(4) : "  —   ";
    const cover = mean(xs.map((p) => (p.actual >= p.p10 && p.actual <= p.p90 ? 1 : 0)));
    lines.push(
      `  ${k.padEnd(6)} ${String(xs.length).padStart(5)}  ${mean(xs.map((p) => p.actual))
        .toFixed(2)
        .padStart(6)} ${mean(xs.map((p) => p.sim))
        .toFixed(2)
        .padStart(6)} ${mean(xs.map((p) => p.naive!))
        .toFixed(2)
        .padStart(6)} | ${mean(xs.map((p) => Math.abs(p.actual - p.sim)))
        .toFixed(2)
        .padStart(6)} ${mean(xs.map((p) => Math.abs(p.actual - p.naive!)))
        .toFixed(2)
        .padStart(6)} | ${(bs / cnt).toFixed(4)} ${naiveBrier} | ${(cover * 100).toFixed(0)}%`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === "collect") return collect(a[0] as SimLeague, a[1], a[2], a[3]);
  if (cmd === "eval") {
    const games = JSON.parse(readFileSync(a[0], "utf8")) as Game[];
    const { gs, ps } = await simulate(games, Number(a[1] ?? 1000));
    console.log(report(gs, ps));
    if (a[2]) writeFileSync(a[2], JSON.stringify({ gs, ps }));
    return;
  }
  console.log(
    "usage: backtest-sim.ts collect <league> <from> <to> <out.json> | eval <file> [n] [scores.json]",
  );
}

if (process.argv[1]?.endsWith("backtest-sim.ts")) await main();
