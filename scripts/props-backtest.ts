#!/usr/bin/env node
/**
 * props-backtest.ts — the site's game simulator, replayed on past seasons for
 * player props (NBA points, NHL points and goals).
 *
 * For every game it rebuilds what the live site would have known that
 * morning — every player's and team's season-to-date totals, in exactly the
 * shape ESPN's season feeds give the live builder, plus last season's — and
 * hands them to the same pure functions the site uses (makeSeason,
 * assembleMatchup), then plays the game N times and writes each player's
 * chance of reaching every line.
 *
 * What it is told about the game itself, as the morning would know it:
 *   - who was dressed (the box score's list; a player listed as not playing
 *     with an injury reason is marked out, a coach's decision is not),
 *   - NHL: the goalie who started (confirmed before puck drop),
 *   - NBA: whether either team played the night before.
 * Nothing from the game's own box score is folded in until after it is played.
 *
 *   npx tsx scripts/props-backtest.ts nba 2025 [shard] [shards] [sims]
 *
 * Reads research/player-props/data/{sport}_{season-1,season}.jsonl, writes
 * research/player-props/data/sim_{sport}_{season}[.shard].jsonl.
 */
import { createWriteStream, existsSync, readFileSync } from "node:fs";

import { Accumulator } from "../src/lib/sim/aggregate";
import { assembleMatchup, makeSeason } from "../src/lib/sim/build.server";
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

type Sport = "nba" | "nhl";
const [sport, seasonArg, shardArg, shardsArg, simsArg] = process.argv.slice(2) as [
  Sport,
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
// For the run-count study: simulate only every Nth game (all games are still
// folded into the season), and tag the output file.
const EVERY = Number(process.env.SAMPLE_EVERY ?? 1);
const TAG = process.env.OUT_TAG ?? "";

type P = Record<string, number | string | boolean | undefined> & {
  pid: string;
  name: string;
  team: string;
  pos?: string;
  dnp?: boolean;
  reason?: string;
  grp?: string;
};
type Game = {
  id: string;
  date: string;
  stype: number;
  home: { id: string; abbr: string };
  away: { id: string; abbr: string };
  hs: number;
  as: number;
  players: P[];
  teams: Record<string, Record<string, number>>;
  season: number;
};

function load(season: number): Game[] {
  const path = `${DATA}/${sport}_${season}.jsonl`;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ ...(JSON.parse(l) as Game), season }));
}

const n = (x: unknown) => (typeof x === "number" ? x : 0);

// ------------------------------------------------------ season accumulators

class Totals {
  players = new Map<string, StatLine>();
  standings = new Map<string, StandingRow & { w: number; l: number }>();
  teams = new Map<string, TeamTotals>();

  private line(p: P): StatLine {
    let s = this.players.get(p.pid);
    if (!s) {
      s = { id: p.pid, name: p.name, teamId: p.team, pos: p.pos ?? "", s: {} };
      this.players.set(p.pid, s);
    }
    s.teamId = p.team;
    if (p.pos) s.pos = sport === "nhl" && p.grp === "goalies" ? "G" : p.pos;
    return s;
  }

  private add(rec: Record<string, number>, k: string, v: number) {
    rec[k] = (rec[k] ?? 0) + v;
  }

  fold(g: Game) {
    // Players
    if (sport === "nba") {
      for (const p of g.players) {
        if (p.dnp || n(p.min) <= 0) continue;
        const s = this.line(p).s;
        const a = (k: string, v: number) => this.add(s, k, v);
        a("general.gamesPlayed", 1);
        a("general.minutes", n(p.min));
        a("offensive.points", n(p.pts));
        a("offensive.fieldGoalsMade", n(p.fgm));
        a("offensive.fieldGoalsAttempted", n(p.fga));
        a("offensive.threePointFieldGoalsMade", n(p.tpm));
        a("offensive.threePointFieldGoalsAttempted", n(p.tpa));
        a("offensive.freeThrowsMade", n(p.ftm));
        a("offensive.freeThrowsAttempted", n(p.fta));
        a("general.rebounds", n(p.reb));
        a("offensive.assists", n(p.ast));
        a("defensive.steals", n(p.stl));
        a("defensive.blocks", n(p.blk));
        a("offensive.turnovers", n(p.tov));
        a("general.fouls", n(p.pf));
      }
    } else {
      // The starting goalie is the one with the most ice time.
      const starter = new Map<string, P>();
      for (const p of g.players)
        if (p.grp === "goalies" && n(p.toi) > 0) {
          const cur = starter.get(p.team);
          if (!cur || n(p.toi) > n(cur.toi)) starter.set(p.team, p);
        }
      for (const p of g.players) {
        if (p.dnp || n(p.toi) <= 0) continue;
        const s = this.line(p).s;
        const a = (k: string, v: number) => this.add(s, k, v);
        a("general.games", 1);
        a("general.timeOnIce", n(p.toi));
        if (p.grp === "goalies") {
          a("defensive.saves", n(p.sv));
          a("defensive.shotsAgainst", n(p.sa));
          a("defensive.goalsAgainst", n(p.ga));
          // Only the count of starts is read (wins + losses + OT losses).
          if (starter.get(p.team)?.pid === p.pid) a("general.wins", 1);
          continue;
        }
        a("offensive.shotsTotal", n(p.shots)); // ESPN "S" is shots on goal
        a("offensive.goals", n(p.g));
        a("offensive.assists", n(p.a));
        a("offensive.powerPlayGoals", n(p.ppg));
        a("offensive.powerPlayAssists", n(p.ppa));
        a("offensive.faceoffsWon", n(p.fw));
        a("offensive.faceoffsLost", n(p.fl));
        a("penalties.penaltyMinutes", n(p.pim));
      }
    }

    // Teams: standings and box totals (own, and the opponent's as "opp")
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
      const own = g.teams?.[tid] ?? {};
      const opp = g.teams?.[oid] ?? {};
      for (const [into, src] of [
        [tt.own, own],
        [tt.opp, opp],
      ] as const) {
        if (sport === "nba") {
          this.add(into, "general.gamesPlayed", 1);
          this.add(into, "offensive.fieldGoalsMade", n(src.fieldGoalsMade));
          this.add(into, "offensive.fieldGoalsAttempted", n(src.fieldGoalsAttempted));
          this.add(into, "offensive.threePointFieldGoalsMade", n(src.threePointFieldGoalsMade));
          this.add(
            into,
            "offensive.threePointFieldGoalsAttempted",
            n(src.threePointFieldGoalsAttempted),
          );
          this.add(into, "offensive.freeThrowsAttempted", n(src.freeThrowsAttempted));
          this.add(into, "offensive.offensiveRebounds", n(src.offensiveRebounds));
          this.add(into, "defensive.defensiveRebounds", n(src.defensiveRebounds));
          this.add(into, "offensive.turnovers", n(src.totalTurnovers ?? src.turnovers));
        }
      }
      if (sport === "nhl") {
        this.add(tt.own, "general.games", 1);
        this.add(tt.own, "offensive.shotsTotal", n(own.shotsTotal));
        this.add(tt.own, "defensive.shotsAgainst", n(opp.shotsTotal));
        this.add(tt.own, "offensive.powerPlayGoals", n(own.powerPlayGoals));
        this.add(tt.own, "offensive.powerPlayOpportunities", n(own.powerPlayOpportunities));
        this.add(tt.own, "penalties.penaltyMinutes", n(own.penaltyMinutes));
        // Kept as raw counts; turned into ESPN's percentage when read.
        this.add(tt.own, "_ppAgainst", n(opp.powerPlayOpportunities));
        this.add(tt.own, "_ppgAgainst", n(opp.powerPlayGoals));
      }
      this.teams.set(tid, tt);
    }
  }

  /** The team map as ESPN's byteam feed would show it. */
  teamView(): Map<string, TeamTotals> {
    if (sport !== "nhl") return this.teams;
    const out = new Map<string, TeamTotals>();
    for (const [id, t] of this.teams) {
      const own = { ...t.own };
      const opp = own._ppAgainst ?? 0;
      own["defensive.penaltyKillPct"] = opp > 0 ? 100 * (1 - (own._ppgAgainst ?? 0) / opp) : 80;
      delete own._ppAgainst;
      delete own._ppgAgainst;
      out.set(id, { own, opp: t.opp });
    }
    return out;
  }

  standingView(): Map<string, StandingRow> {
    return new Map([...this.standings].map(([k, v]) => [k, { ...v }]));
  }

  /** A deep-enough copy for "this season as of this morning". */
  snapshotPlayers(): Map<string, StatLine> {
    return new Map([...this.players].map(([k, v]) => [k, { ...v, s: { ...v.s } }]));
  }
}

// ------------------------------------------------------------------- run

const COACH = /coach|decision/i;

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

function roster(g: Game, teamId: string): RosterEntry[] {
  return g.players
    .filter((p) => p.team === teamId && p.pid)
    .map((p) => ({
      id: p.pid,
      name: p.name,
      short: p.name,
      pos:
        sport === "nhl" && p.grp === "goalies"
          ? "G"
          : sport === "nhl" && p.grp === "defenses"
            ? "D"
            : (p.pos ?? ""),
      jersey: "",
      // Listed as not playing for an injury or illness: the injury report had
      // him out. A coach's decision was not knowable; he stays available.
      injury: p.dnp && p.reason && !COACH.test(String(p.reason)) ? "Out" : null,
      group: null,
    }));
}

function main() {
  const prior = load(SEASON - 1);
  const games = load(SEASON).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!games.length) throw new Error(`no games for ${sport} ${SEASON}`);

  const old = new Totals();
  for (const g of prior) if (g.stype === 2) old.fold(g);
  const oldPlayers = old.snapshotPlayers();
  const oldStand = old.standingView();
  const oldTeams = old.teamView();

  const cur = new Totals();
  const playedOn = new Map<string, Set<string>>(); // date -> team ids
  const day = (iso: string) => {
    // Game dates are UTC; the evening slate belongs to the US calendar day.
    const d = new Date(new Date(iso).getTime() - 6 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  };
  for (const g of games) {
    const d = day(g.date);
    const s = playedOn.get(d) ?? new Set<string>();
    s.add(g.home.id);
    s.add(g.away.id);
    playedOn.set(d, s);
  }

  const suffix = SHARDS > 1 ? `.${SHARD}` : "";
  const out = createWriteStream(`${DATA}/sim${TAG}_${sport}_${SEASON}${suffix}.jsonl`);
  const t0 = Date.now();
  let done = 0;

  for (let gi = 0; gi < games.length; gi++) {
    const g = games[gi];
    if (gi % EVERY === 0 && (gi / EVERY) % SHARDS === SHARD) {
      const se = makeSeason({
        league: sport,
        current: SEASON + 1,
        cur: cur.snapshotPlayers(),
        old: oldPlayers,
        stCur: cur.standingView(),
        stOld: oldStand,
        tsCur: cur.teamView(),
        tsOld: oldTeams,
      });
      const d = day(g.date);
      const prev = new Date(`${d}T12:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() - 1);
      const yesterday = playedOn.get(prev.toISOString().slice(0, 10)) ?? new Set<string>();
      const ctx: MatchupContext = {
        gameId: g.id,
        date: d,
        venue: "",
        neutral: false,
        playoff: g.stype === 3,
        line: null,
        basis: se.basis,
        ...(sport === "nba"
          ? { b2b: { home: yesterday.has(g.home.id), away: yesterday.has(g.away.id) } }
          : {}),
      };
      let probable: { home?: string; away?: string } | undefined;
      if (sport === "nhl") {
        const start = (tid: string) =>
          g.players
            .filter((p) => p.team === tid && p.grp === "goalies" && n(p.toi) > 0)
            .sort((a, b) => n(b.toi) - n(a.toi))[0]?.pid;
        probable = { home: start(g.home.id), away: start(g.away.id) };
      }
      const m = assembleMatchup(
        sport,
        se,
        meta(g.home),
        meta(g.away),
        roster(g, g.home.id),
        roster(g, g.away.id),
        ctx,
        probable,
      );
      const play = runner(m, { benched: [], activated: [] });
      const acc = new Accumulator(m);
      const base = (Number(g.id) * 2654435761) >>> 0;
      for (let i = 0; i < SIMS; i++) acc.add(play(seedFor(base, i), false));
      const r = acc.summary(0);
      const players: Record<string, unknown> = {};
      for (const p of r.players) {
        const row: Record<string, unknown> = {
          played: Math.round(p.played * 1000) / 1000,
          first: Math.round(p.first * 100000) / 100000,
        };
        for (const s of p.props) {
          if (sport === "nba" ? s.key !== "pts" : !["pts", "g", "a", "sog"].includes(s.key))
            continue;
          row[s.key] = {
            mean: Math.round(s.mean * 1000) / 1000,
            sd: Math.round(s.sd * 1000) / 1000,
            over: s.over.map((x) => Math.round(x * 10000) / 10000),
          };
        }
        players[p.id] = row;
      }
      out.write(
        `${JSON.stringify({ id: g.id, date: g.date, stype: g.stype, home: r.avgHome, away: r.avgAway, players })}\n`,
      );
      done += 1;
      if (done % 100 === 0)
        console.log(
          `${sport} ${SEASON} shard ${SHARD}: ${done} games, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
    }
    // Fold the game into the season only after it has been predicted.
    if (g.stype === 2) cur.fold(g);
  }
  out.end();
  console.log(
    `${sport} ${SEASON} shard ${SHARD}: done, ${done} games in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}

main();
