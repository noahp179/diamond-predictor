#!/usr/bin/env node
/**
 * props-backtest-football.ts — the site's football simulator, replayed on past
 * seasons for anytime touchdowns (NFL and college).
 *
 * The football twin of props-backtest.ts. For every game it rebuilds what the
 * live builder would have known that morning — every player's season-to-date
 * line and last season's, every team's totals and its opponents', the college
 * schedule-adjusted ratings — from the box scores of the games before it, and
 * hands them to the same pure functions the site uses (makeSeason,
 * assembleFootball, ratingsFrom). Then it plays the game N times and writes
 * each player's chance of scoring a touchdown.
 *
 * What it is told about the game itself, as the morning would know it:
 *   - who was active: the players who appear in the game's box score (the
 *     inactives are announced before kickoff; a player active but untouched
 *     is the one thing this cannot see),
 *   - the starting quarterback (the box score's leading passer).
 * The coaching-tendency file is left out: it is built from play-by-play up to
 * its own date and would leak into earlier games.
 *
 *   npx tsx scripts/props-backtest-football.ts nfl 2025 <rawDir> [shard] [shards] [sims]
 *
 * <rawDir> holds ESPN summaries as {event_id}.json or .json.gz, any seasons;
 * positions come from research/player-props/data/positions_{league}_{year}.json
 * (fetch_positions.py). Writes research/player-props/data/sim_{league}_{season}[.shard].jsonl.
 */
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { Accumulator } from "../src/lib/sim/aggregate";
import { assembleFootball, makeSeason } from "../src/lib/sim/build.server";
import { readSummary, type Summary } from "../src/lib/sim/cfb-box";
import { ratingsFrom, type Final } from "../src/lib/sim/cfb-ratings.server";
import { NFL } from "../src/lib/sim/columns";
import { seedFor } from "../src/lib/sim/core";
import { runner } from "../src/lib/sim/engine";
import type {
  RosterEntry,
  StandingRow,
  StatLine,
  TeamMeta,
  TeamTotals,
} from "../src/lib/sim/espn-stats.server";
import type { MatchupContext } from "../src/lib/sim/types";

type League = "nfl" | "cfb";
const [league, seasonArg, rawDir, shardArg, shardsArg, simsArg] = process.argv.slice(2) as [
  League,
  string,
  string,
  string?,
  string?,
  string?,
];
const SEASON = Number(seasonArg);
const SHARD = Number(shardArg ?? 0);
const SHARDS = Number(shardsArg ?? 1);
const SIMS = Number(simsArg ?? 1000);
const DATA = "research/player-props/data";

type RawSummary = Summary & {
  header?: Summary["header"] & {
    competitions?: {
      date?: string;
      neutralSite?: boolean;
      status?: { type?: { completed?: boolean } };
      competitors?: {
        homeAway?: string;
        score?: string;
        team?: { id?: string; abbreviation?: string };
      }[];
    }[];
  };
  boxscore?: Summary["boxscore"] & {
    teams?: { team?: { id?: string }; statistics?: { name?: string; displayValue?: string }[] }[];
  };
};

type Game = {
  id: string;
  season: number;
  stype: number;
  date: string;
  neutral: boolean;
  home: { id: string; abbr: string };
  away: { id: string; abbr: string };
  hs: number;
  as: number;
  /** teamId -> player id -> byathlete-keyed line for this game */
  lines: Map<string, Map<string, { name: string; s: Record<string, number> }>>;
  third: Map<string, { conv: number; att: number }>;
};

function readRaw(path: string): RawSummary {
  const buf = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8")) as RawSummary;
}

function loadGames(): Game[] {
  const out: Game[] = [];
  for (const f of readdirSync(rawDir)) {
    if (!/\.json(\.gz)?$/.test(f)) continue;
    let sum: RawSummary;
    try {
      sum = readRaw(`${rawDir}/${f}`);
    } catch {
      continue;
    }
    const comp = sum.header?.competitions?.[0];
    const season = sum.header?.season?.year ?? 0;
    if (!comp?.status?.type?.completed || (season !== SEASON && season !== SEASON - 1)) continue;
    const g = readSummary(sum);
    if (!g) continue;
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    if (!home?.team?.id || !away?.team?.id) continue;
    const third = new Map<string, { conv: number; att: number }>();
    for (const t of sum.boxscore?.teams ?? []) {
      const eff = t.statistics?.find((x) => x.name === "thirdDownEff")?.displayValue ?? "";
      const [c, a] = eff.split("-").map(Number);
      if (t.team?.id) third.set(t.team.id, { conv: c || 0, att: a || 0 });
    }
    out.push({
      id: String(sum.header?.id ?? f.replace(/\.json(\.gz)?$/, "")),
      season,
      stype: sum.header?.season?.type ?? 2,
      date: comp.date ?? "",
      neutral: comp.neutralSite === true,
      home: { id: home.team.id, abbr: home.team.abbreviation ?? home.team.id },
      away: { id: away.team.id, abbr: away.team.abbreviation ?? away.team.id },
      hs: Number(home.score ?? 0),
      as: Number(away.score ?? 0),
      lines: new Map(g.teams.map((t) => [t.teamId, t.players])),
      third,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function positions(year: number): Record<string, string> {
  const p = `${DATA}/positions_${league}_${year}.json`;
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : {};
}

const TEAM_KEYS = [
  "passing.completions",
  "passing.passingAttempts",
  "passing.passingYards",
  "passing.interceptions",
  "passing.passingTouchdowns",
  "passing.sacks",
  "passing.sackYardsLost",
  "rushing.rushingAttempts",
  "rushing.rushingYards",
  "rushing.rushingTouchdowns",
];

class Totals {
  players = new Map<string, StatLine>();
  standings = new Map<string, StandingRow & { w: number; l: number }>();
  teams = new Map<string, TeamTotals>();
  finals: Final[] = [];

  fold(g: Game, pos: Record<string, string>) {
    const own = new Map<string, Record<string, number>>();
    for (const [tid, players] of g.lines) {
      const t: Record<string, number> = {};
      for (const [pid, l] of players) {
        let st = this.players.get(pid);
        if (!st) {
          st = { id: pid, name: l.name, teamId: tid, pos: pos[pid] ?? "", s: {} };
          this.players.set(pid, st);
        }
        st.teamId = tid;
        if (pos[pid]) st.pos = pos[pid];
        for (const [k, v] of Object.entries(l.s)) {
          if (k.includes(".long")) st.s[k] = Math.max(st.s[k] ?? 0, v);
          else st.s[k] = (st.s[k] ?? 0) + v;
        }
        for (const k of TEAM_KEYS) t[k] = (t[k] ?? 0) + (l.s[k] ?? 0);
      }
      const third = g.third.get(tid);
      t["miscellaneous.thirdDownConvs"] = third?.conv ?? 0;
      t["miscellaneous.thirdDownAttempts"] = third?.att ?? 0;
      t["general.gamesPlayed"] = 1;
      own.set(tid, t);
    }
    for (const [side, other] of [
      ["home", "away"],
      ["away", "home"],
    ] as const) {
      const tid = g[side].id;
      const oid = g[other].id;
      const pf = side === "home" ? g.hs : g.as;
      const pa = side === "home" ? g.as : g.hs;
      const st = this.standings.get(tid) ?? {
        teamId: tid,
        gp: 0,
        pf: 0,
        pa: 0,
        record: "",
        w: 0,
        l: 0,
      };
      st.gp += 1;
      st.pf += pf;
      st.pa += pa;
      if (pf > pa) st.w += 1;
      else st.l += 1;
      st.record = `${st.w}-${st.l}`;
      this.standings.set(tid, st);
      const tt = this.teams.get(tid) ?? { own: {}, opp: {} };
      for (const [k, v] of Object.entries(own.get(tid) ?? {})) tt.own[k] = (tt.own[k] ?? 0) + v;
      for (const [k, v] of Object.entries(own.get(oid) ?? {})) tt.opp[k] = (tt.opp[k] ?? 0) + v;
      this.teams.set(tid, tt);
    }
    this.finals.push({
      date: g.date.slice(0, 10),
      home: g.home.id,
      away: g.away.id,
      hs: g.hs,
      as: g.as,
      neutral: g.neutral,
    });
  }

  snapshot() {
    return {
      players: new Map([...this.players].map(([k, v]) => [k, { ...v, s: { ...v.s } }])),
      standings: new Map([...this.standings].map(([k, v]) => [k, { ...v }])) as Map<
        string,
        StandingRow
      >,
      teams: new Map(
        [...this.teams].map(([k, v]) => [k, { own: { ...v.own }, opp: { ...v.opp } }]),
      ) as Map<string, TeamTotals>,
    };
  }
}

const DEF = new Set([
  "DE",
  "DT",
  "NT",
  "LB",
  "OLB",
  "ILB",
  "MLB",
  "CB",
  "S",
  "SS",
  "FS",
  "DB",
  "DL",
  "EDGE",
]);
const ST = new Set(["K", "PK", "P", "LS"]);

function meta(t: { id: string; abbr: string }): TeamMeta {
  return {
    id: t.id,
    abbr: t.abbr,
    name: t.abbr,
    location: t.abbr,
    displayName: t.abbr,
    color: "",
    altColor: "",
    logo: "",
  };
}

function main() {
  const all = loadGames();
  const prior = all.filter((g) => g.season === SEASON - 1);
  const games = all.filter((g) => g.season === SEASON);
  if (!games.length) throw new Error(`no ${league} ${SEASON} games in ${rawDir}`);
  const posPrior = positions(SEASON - 1);
  const posNow = { ...posPrior, ...positions(SEASON) };

  const old = new Totals();
  for (const g of prior) if (g.stype === 2) old.fold(g, posPrior);
  const o = old.snapshot();
  const fbs = new Set<string>(); // college: FBS = teams with a box score in our FBS-only data
  for (const g of all) {
    fbs.add(g.home.id);
    fbs.add(g.away.id);
  }

  const cur = new Totals();
  const suffix = SHARDS > 1 ? `.${SHARD}` : "";
  const out = createWriteStream(`${DATA}/sim_${league}_${SEASON}${suffix}.jsonl`);
  const t0 = Date.now();
  let done = 0;
  for (let gi = 0; gi < games.length; gi++) {
    const g = games[gi];
    if (gi % SHARDS === SHARD) {
      const c = cur.snapshot();
      const se = makeSeason({
        league,
        current: SEASON,
        cur: c.players,
        old: o.players,
        stCur: c.standings,
        stOld: o.standings,
        tsCur: c.teams,
        tsOld: o.teams,
      });
      const date = g.date.slice(0, 10);
      const ratings = league === "cfb" ? ratingsFrom(old.finals, cur.finals, fbs, date) : null;
      const roster = (tid: string): RosterEntry[] =>
        [...(g.lines.get(tid) ?? new Map()).entries()].map(([pid, l]) => {
          const pos = posNow[pid] ?? "";
          return {
            id: pid,
            name: l.name,
            short: l.name,
            pos,
            jersey: "",
            injury: null,
            group: DEF.has(pos) ? "defense" : ST.has(pos) ? "specialTeam" : "offense",
          };
        });
      // The starting quarterback: the game's leading passer, as every
      // pregame report names him.
      const qb = (tid: string) =>
        [...(g.lines.get(tid) ?? new Map()).entries()].sort(
          (a, b) =>
            (b[1].s["passing.passingAttempts"] ?? 0) - (a[1].s["passing.passingAttempts"] ?? 0),
        )[0]?.[0];
      const ctx: MatchupContext = {
        gameId: g.id,
        date,
        venue: "",
        neutral: g.neutral,
        playoff: g.stype === 3,
        line: null,
        basis: se.basis,
        indoor: false,
      };
      const m = assembleFootball(
        league,
        se,
        se,
        meta(g.home),
        meta(g.away),
        roster(g.home.id),
        roster(g.away.id),
        ctx,
        ratings,
        false,
      );
      const starter = { home: qb(g.home.id), away: qb(g.away.id) };
      const play = runner(m, {
        benched: [],
        activated: [],
        starter: Object.fromEntries(Object.entries(starter).filter(([, v]) => v)) as Record<
          string,
          string
        >,
      });
      const acc = new Accumulator(m);
      const base = (Number(g.id) * 2654435761) >>> 0;
      for (let i = 0; i < SIMS; i++) acc.add(play(seedFor(base, i), false));
      const r = acc.summary(0);
      const players: Record<string, unknown> = {};
      for (const p of r.players) {
        const td = p.props.find((x) => x.key === "td");
        const mean = (p.avgBox[NFL.RTD] ?? 0) + (p.avgBox[NFL.RETD] ?? 0);
        players[p.id] = {
          td: td ? td.over[0] : 1 - Math.exp(-mean),
          mean: Math.round(mean * 10000) / 10000,
          played: Math.round(p.played * 1000) / 1000,
        };
      }
      out.write(
        `${JSON.stringify({ id: g.id, date: g.date, stype: g.stype, home: r.avgHome, away: r.avgAway, players })}\n`,
      );
      done += 1;
      if (done % 50 === 0)
        console.log(
          `${league} ${SEASON} shard ${SHARD}: ${done} games, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
    }
    if (g.stype === 2) cur.fold(g, posNow);
    else
      cur.finals.push({
        date: g.date.slice(0, 10),
        home: g.home.id,
        away: g.away.id,
        hs: g.hs,
        as: g.as,
        neutral: g.neutral,
      });
  }
  out.end();
  console.log(
    `${league} ${SEASON} shard ${SHARD}: done, ${done} games in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}

main();
