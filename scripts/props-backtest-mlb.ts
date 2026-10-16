#!/usr/bin/env node
/**
 * props-backtest-mlb.ts — the site's baseball simulator, replayed on past
 * seasons for player props (every market in PROPS.mlb).
 *
 * The baseball twin of props-backtest.ts. For every game it rebuilds what the
 * live site would have known that morning — every player's and team's
 * season-to-date totals, in exactly the shape ESPN's season feeds give the
 * live builder, plus last season's — and hands them to the same pure
 * functions the site uses (makeSeason, assembleMlb), then plays the game N
 * times and writes each player's chance of reaching every line.
 *
 * "That morning" is the calendar day the game started: a game sees every
 * regular-season game finished on an earlier day and nothing from its own
 * day (a doubleheader's second game does not see the first). Postseason games
 * are never folded in, as ESPN's season feeds (season type 2) leave them out.
 *
 * What it is told about the game itself, as the morning would know it:
 *   - the starting pitchers (probables are announced the day before),
 *   - the park (the home club's), a neutral site, and the postseason flag,
 *   - who was there, by MLB_ROSTER:
 *       staff     (default) the position players who appeared — the posted
 *                 lineup and the bench players who came in — and the whole
 *                 active pitching staff (the box score's bullpen list), so
 *                 which relievers the game called for is not given away;
 *       appeared  only the players who appeared, pitchers included;
 *       active    the whole active roster, as the live site reads ESPN's;
 *       lineup    the whole active roster with every position player not in
 *                 the posted starting lineup benched, as a user (or a board)
 *                 would once lineup cards are out, ~2 hours before first
 *                 pitch. Benched players cannot come off the bench, so the
 *                 nine bat all game.
 * The engine picks its own batting order from these, as it does live: the
 * nine with the most plate appearances, ordered by on-base and OPS. Off the
 * posted lineup that nine misses the real one — a substitute who came in
 * often has more plate appearances behind him than the starter he replaced.
 *
 *   npx tsx scripts/props-backtest-mlb.ts 2025 [shard] [shards] [sims]
 *   STYPE=3 npx tsx scripts/props-backtest-mlb.ts 2024    # postseason only
 *
 * Reads {DATA}/mlb_{season-1,season}.jsonl (research/player-props/fetch_mlb.py)
 * and writes {DATA}/sim{OUT_TAG}_mlb_{season}[.shard].jsonl, where DATA is
 * research/player-props/data unless PROPS_DATA names another directory. One
 * line per game:
 *
 *   { id, date, day, stype, gtype, neutral, park, home, away (mean runs),
 *     hw (home win share), hs, as (the real score), ms (wall time),
 *     sp: {home, away} (the starters named),
 *     players: { pid: { side, slot (the engine's batting-order slot, 0 = not
 *       in it), sp (the named starter), played (share of games with a plate
 *       appearance), pitched (share with a pitching appearance), pa (mean
 *       plate appearances), <prop>: { mean, sd, over[] }, act: { <prop>:
 *       what he did, role, bo } } } }
 *
 * Every PROPS.mlb line is written for every batter (h tb hr r rbi hrr bb so
 * sb) and pitcher (k outs ha er pbb win), whatever its mean — the site's
 * board hides the small ones, a backtest should not.
 */
import { createWriteStream, existsSync, readFileSync } from "node:fs";

import { Accumulator } from "../src/lib/sim/aggregate";
import { assembleMlb, makeSeason } from "../src/lib/sim/build.server";
import { MLB } from "../src/lib/sim/columns";
import { seedFor } from "../src/lib/sim/core";
import { runner } from "../src/lib/sim/engine";
import type {
  RosterEntry,
  StandingRow,
  StatLine,
  TeamMeta,
  TeamTotals,
} from "../src/lib/sim/espn-stats.server";
import { mlbPlan } from "../src/lib/sim/mlb";
import { boxPlayers, PROPS } from "../src/lib/sim/props";
import type { MatchupContext, SimOverrides } from "../src/lib/sim/types";

const [seasonArg, shardArg, shardsArg, simsArg] = process.argv.slice(2);
const SEASON = Number(seasonArg);
const SHARD = Number(shardArg ?? 0);
const SHARDS = Number(shardsArg ?? 1);
const SIMS = Number(simsArg ?? 1000);
const DATA = process.env.PROPS_DATA ?? "research/player-props/data";
const TAG = process.env.OUT_TAG ?? "";
const ROSTER = (process.env.MLB_ROSTER ?? "staff") as "staff" | "appeared" | "active" | "lineup";
// Simulate only this season type (2 regular, 3 postseason); all are by default.
const STYPE = process.env.STYPE ? Number(process.env.STYPE) : null;

type P = Record<string, number | string | undefined> & {
  pid: string;
  name: string;
  team: string;
  pos?: string;
  ppos?: string;
  bats?: string;
  throws?: string;
  role: "lineup" | "sub" | "sp" | "rp" | "bench" | "pen";
  bo?: number;
};
type Game = {
  id: string;
  date: string;
  day: string;
  start: string;
  stype: number;
  gtype: string;
  neutral: boolean;
  venue: { id: number; name: string };
  home: { id: string; abbr: string };
  away: { id: string; abbr: string };
  hs: number;
  as: number;
  players: P[];
  teams: Record<string, Record<string, number>>;
};

function load(season: number): Game[] {
  const path = `${DATA}/mlb_${season}.jsonl`;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Game);
}

const n = (x: unknown) => (typeof x === "number" ? x : 0);
/** 20 outs → 6.2, the innings notation ESPN's feeds use. */
const innings = (outs: number) => Math.floor(outs / 3) + (outs % 3) / 10;

// ------------------------------------------------------ season accumulators

class Totals {
  players = new Map<string, StatLine>();
  standings = new Map<string, StandingRow & { w: number; l: number }>();
  teams = new Map<string, TeamTotals>();
  /** Outs by pitcher and by team, kept whole; written out as innings. */
  private outs = new Map<string, number>();
  private teamOuts = new Map<string, number>();

  private line(p: P): StatLine {
    let s = this.players.get(p.pid);
    if (!s) {
      s = { id: p.pid, name: p.name, teamId: p.team, pos: p.ppos ?? "", s: {} };
      this.players.set(p.pid, s);
    }
    s.teamId = p.team;
    return s;
  }

  private add(rec: Record<string, number>, k: string, v: number) {
    rec[k] = (rec[k] ?? 0) + v;
  }

  /**
   * One game's box score into the season, under the names ESPN's byathlete
   * and byteam feeds use. Walks are all walks, intentional ones included,
   * as ESPN counts them; hit batsmen, sacrifices and catcher's interference
   * are not in ESPN's feed and are left out here too (the builder adds its
   * own allowance for them).
   */
  fold(g: Game) {
    for (const p of g.players) {
      const bat = p.pa !== undefined;
      const pit = p.p_bf !== undefined;
      if (!bat && !pit) continue;
      const s = this.line(p).s;
      const a = (k: string, v: number) => this.add(s, k, v);
      if (bat) {
        a("batting.gamesPlayed", 1);
        a("batting.atBats", n(p.ab));
        a("batting.runs", n(p.r));
        a("batting.hits", n(p.h));
        a("batting.doubles", n(p.d2));
        a("batting.triples", n(p.d3));
        a("batting.homeRuns", n(p.hr));
        a("batting.RBIs", n(p.rbi));
        a("batting.totalBases", n(p.tb));
        a("batting.walks", n(p.bb));
        a("batting.strikeouts", n(p.so));
        a("batting.stolenBases", n(p.sb));
      }
      if (pit) {
        a("pitching.gamesPlayed", 1);
        a("pitching.gamesStarted", n(p.p_gs));
        a("pitching.wins", n(p.p_w));
        a("pitching.losses", n(p.p_l));
        a("pitching.saves", n(p.p_sv));
        a("pitching.holds", n(p.p_hld));
        a("pitching.hits", n(p.p_h));
        a("pitching.earnedRuns", n(p.p_er));
        a("pitching.homeRuns", n(p.p_hr));
        a("pitching.walks", n(p.p_bb));
        a("pitching.strikeouts", n(p.p_so));
        const outs = (this.outs.get(p.pid) ?? 0) + n(p.p_outs);
        this.outs.set(p.pid, outs);
        s["pitching.innings"] = innings(outs);
      }
    }

    // Teams: standings, and the byteam totals (baseball lists no opponents'
    // figures; the defense is the team's own pitching and fielding).
    for (const side of ["home", "away"] as const) {
      const tid = g[side].id;
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
      const t = g.teams?.[tid] ?? {};
      const a = (k: string, v: number) => this.add(tt.own, k, v);
      a("batting.gamesPlayed", 1);
      a("batting.atBats", n(t.ab));
      a("batting.runs", n(t.r));
      a("batting.hits", n(t.h));
      a("batting.doubles", n(t.d2));
      a("batting.triples", n(t.d3));
      a("batting.homeRuns", n(t.hr));
      a("batting.RBIs", n(t.rbi));
      a("batting.totalBases", n(t.tb));
      a("batting.walks", n(t.bb));
      a("batting.strikeouts", n(t.so));
      a("batting.stolenBases", n(t.sb));
      a("pitching.gamesPlayed", 1);
      a("pitching.wins", pf > pa ? 1 : 0);
      a("pitching.losses", pf > pa ? 0 : 1);
      a("pitching.hits", n(t.p_h));
      a("pitching.earnedRuns", n(t.p_er));
      a("pitching.homeRuns", n(t.p_hr));
      a("pitching.walks", n(t.p_bb));
      a("pitching.strikeouts", n(t.p_so));
      a("fielding.gamesPlayed", 1);
      a("fielding.errors", n(t.e));
      const outs = (this.teamOuts.get(tid) ?? 0) + n(t.p_outs);
      this.teamOuts.set(tid, outs);
      tt.own["pitching.innings"] = innings(outs);
      this.teams.set(tid, tt);
    }
  }

  /** ESPN's standings list every club from opening day, at 0-0 until it
   *  plays — which matters for the games-into-the-season weight. */
  seed(g: Game) {
    for (const t of [g.home, g.away])
      if (!this.standings.has(t.id))
        this.standings.set(t.id, { teamId: t.id, gp: 0, pf: 0, pa: 0, record: "0-0", w: 0, l: 0 });
  }

  standingView(): Map<string, StandingRow> {
    return new Map([...this.standings].map(([k, v]) => [k, { ...v }]));
  }
}

// ------------------------------------------------------------------- run

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

const PITCHER_ROLE = new Set(["sp", "rp", "pen"]);

/** The roster position ESPN would list: a pitcher is "P" (ESPN: SP / RP,
 *  which the builder treats alike), a two-way player is his batting side. */
function position(p: P): string {
  if (p.ppos === "TWP") return "DH";
  if (p.ppos) return p.ppos;
  return PITCHER_ROLE.has(p.role) && p.pa === undefined ? "P" : (p.pos ?? "");
}

function inRoster(p: P): boolean {
  if (ROSTER === "active" || ROSTER === "lineup") return true;
  if (p.role === "bench") return false;
  return ROSTER === "staff" || p.role !== "pen";
}

/** Lineup mode: every position player who did not start at the plate. */
function benched(g: Game): string[] {
  if (ROSTER !== "lineup") return [];
  return g.players
    .filter((p) => !(p.bo && p.bo % 100 === 0) && position(p) !== "P")
    .map((p) => p.pid);
}

function roster(g: Game, teamId: string): RosterEntry[] {
  return g.players
    .filter((p) => p.team === teamId && p.pid && inRoster(p))
    .map((p) => ({
      id: p.pid,
      name: p.name,
      short: p.name,
      pos: position(p),
      jersey: "",
      injury: null,
      group: null,
      bats: p.bats || undefined,
      throws: p.throws || undefined,
    }));
}

/** What the player did, under the PROPS.mlb keys. */
function actual(p: P): Record<string, number | string> {
  const out: Record<string, number | string> = { role: p.role };
  if (p.bo) out.bo = p.bo;
  if (p.pa !== undefined) {
    out.pa = n(p.pa);
    out.h = n(p.h);
    out.tb = n(p.tb);
    out.hr = n(p.hr);
    out.r = n(p.r);
    out.rbi = n(p.rbi);
    out.hrr = n(p.h) + n(p.r) + n(p.rbi);
    out.bb = n(p.bb);
    out.so = n(p.so);
    out.sb = n(p.sb);
  }
  if (p.p_bf !== undefined) {
    out.k = n(p.p_so);
    out.outs = n(p.p_outs);
    out.ha = n(p.p_h);
    out.er = n(p.p_er);
    out.pbb = n(p.p_bb);
    out.win = n(p.p_w);
  }
  return out;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

function main() {
  const prior = load(SEASON - 1);
  const key = (g: Game) => `${g.start} ${g.date}`;
  const games = load(SEASON).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (!games.length) throw new Error(`no games for mlb ${SEASON} in ${DATA}`);
  if (!prior.length) console.warn(`mlb ${SEASON - 1}: no games; last season will be empty`);

  const old = new Totals();
  for (const g of prior) if (g.stype === 2) old.fold(g);
  const oldStand = old.standingView();

  // Regular-season games in the order they finished: each is folded in on
  // the first morning after the day it ended.
  const finished = games
    .filter((g) => g.stype === 2)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const cur = new Totals();
  for (const g of games) cur.seed(g);
  let folded = 0;

  const suffix = SHARDS > 1 ? `.${SHARD}` : "";
  const outPath = `${DATA}/sim${TAG}_mlb_${SEASON}${suffix}.jsonl`;
  const out = createWriteStream(outPath);
  const defs = PROPS.mlb;
  const t0 = Date.now();
  let done = 0;
  let noStarter = 0;
  let se: ReturnType<typeof makeSeason> | null = null;
  let seDay = "";

  for (let gi = 0; gi < games.length; gi++) {
    const g = games[gi];
    if (g.start !== seDay) {
      while (folded < finished.length && finished[folded].day < g.start)
        cur.fold(finished[folded++]);
      seDay = g.start;
      se = null;
    }
    if (gi % SHARDS !== SHARD || (STYPE !== null && g.stype !== STYPE)) continue;
    const tg = Date.now();
    // One season per morning: nothing is folded in until the day is over.
    se ??= makeSeason({
      league: "mlb",
      current: SEASON,
      cur: cur.players,
      old: old.players,
      stCur: cur.standingView(),
      stOld: oldStand,
      tsCur: cur.teams,
      tsOld: old.teams,
    });
    const ctx: MatchupContext = {
      gameId: g.id,
      date: g.start,
      venue: g.venue?.name ?? "",
      neutral: g.neutral,
      playoff: g.stype === 3,
      line: null,
      basis: se.basis,
    };
    const starter = (tid: string) => g.players.find((p) => p.team === tid && p.role === "sp")?.pid;
    const probable = { home: starter(g.home.id), away: starter(g.away.id) };
    const m = assembleMlb(
      se,
      meta(g.home),
      meta(g.away),
      roster(g, g.home.id),
      roster(g, g.away.id),
      ctx,
      probable,
    );
    const o: SimOverrides = { benched: benched(g), activated: [] };
    const plan = mlbPlan(m, o);
    const play = runner(m, o);
    const acc = new Accumulator(m);
    const base = (Number(g.id) * 2654435761) >>> 0;
    for (let i = 0; i < SIMS; i++) acc.add(play(seedFor(base, i), false));
    const st = acc.st;
    const N = Math.max(1, st.n);

    // The accumulator's roster, in its own order: every player and every
    // market his group has, before the board's small-mean filter.
    const rows = (["home", "away"] as const).flatMap((side) =>
      boxPlayers(m, side).map((p) => ({
        side,
        p,
        props: defs.filter((d) => d.groups.includes(p.group) && (!d.pos || d.pos.includes(p.pos))),
      })),
    );
    const real = new Map(g.players.map((p) => [p.pid, p]));
    const players: Record<string, Record<string, unknown>> = {};
    rows.forEach(({ side, p, props }, i) => {
      const k = side === "home" ? 0 : 1;
      const share = st.played[i] / N;
      const rp = real.get(p.id);
      const appeared = rp && (rp.pa !== undefined || rp.p_bf !== undefined);
      if (share <= 0 && !appeared) return;
      const row = (players[p.id] ??= { side });
      if (p.group === "batter") {
        row.slot = plan[k].order.indexOf(p.idx) + 1;
        row.played = r3(share);
        row.pa = r3((st.box[i][MLB.PA] ?? 0) / N);
      } else {
        row.sp = plan[k].starter === p.idx - m[side].batters.length;
        row.pitched = r3(share);
      }
      // Games he did not play count as zeros, as in the accumulator's
      // summary; every line is 1 or more, so they only pull the mean down.
      props.forEach((d, j) => {
        const h = st.hists[i][j];
        let s1 = 0;
        let s2 = 0;
        for (const [v, c] of Object.entries(h)) {
          s1 += Number(v) * c;
          s2 += Number(v) * Number(v) * c;
        }
        const mean = s1 / N;
        row[d.key] = {
          mean: r3(mean),
          sd: r3(Math.sqrt(Math.max(0, s2 / N - mean * mean))),
          over: d.lines.map((line) => {
            let c = 0;
            for (const [v, cnt] of Object.entries(h)) if (Number(v) >= line) c += cnt;
            return r4(c / N);
          }),
        };
      });
      if (rp) row.act = actual(rp);
    });
    for (const k of [0, 1]) if (plan[k].starter < 0) noStarter++;
    const r = acc.summary(0);
    out.write(
      `${JSON.stringify({
        id: g.id,
        date: g.date,
        day: g.start,
        stype: g.stype,
        gtype: g.gtype,
        neutral: g.neutral,
        park: m.ctx.park,
        home: r3(r.avgHome),
        away: r3(r.avgAway),
        hw: r4(r.homeWins),
        hs: g.hs,
        as: g.as,
        ms: Date.now() - tg,
        sp: probable,
        players,
      })}\n`,
    );
    done += 1;
    if (done % 100 === 0)
      console.log(
        `mlb ${SEASON} shard ${SHARD}: ${done} games, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
  }
  out.end();
  console.log(
    `mlb ${SEASON} shard ${SHARD}: done, ${done} games in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
      ` (${((Date.now() - t0) / Math.max(1, done)).toFixed(0)} ms a game; ${noStarter} sides` +
      ` whose starter the engine could not place) -> ${outPath}`,
  );
}

main();
