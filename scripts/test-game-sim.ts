#!/usr/bin/env node
/**
 * Checks the four game engines against live ESPN data.
 *
 *   1. Box scores add up — every point, run and goal in the final score is
 *      credited to a player, minutes and ice time fill the game exactly,
 *      batting lines are internally consistent.
 *   2. A seed is a game — the same seed played silently (as in a batch) and
 *      recorded (as in the viewer) produces the identical game, and replaying
 *      the recorded box-score deltas rebuilds the final box exactly. The page
 *      never reuses a seed (every run is fresh randomness), but determinism
 *      is what lets these tests pin an engine's behaviour. And a batch split
 *      across workers and merged sums to exactly the same totals as one run.
 *   3. The engines reproduce their leagues — two-way round robins among real
 *      rosters score within a few percent of the league's points per game,
 *      and the same roster on both sides wins at home 51–58% of the time.
 *
 * Run:  NODE_USE_ENV_PROXY=1 npx tsx scripts/test-game-sim.ts [nfl|nba|nhl|mlb ...]
 * (the proxy variable is only needed behind an HTTPS proxy). Takes a minute,
 * most of it the first fetch of each league's season stats.
 */

import { Accumulator } from "../src/lib/sim/aggregate";
import { buildMatchup, listTeams } from "../src/lib/sim/build.server";
import { MLB, NBA, NFL, NHL } from "../src/lib/sim/columns";
import { runner } from "../src/lib/sim/engine";
import type { GameResult, SimLeague, SimMatchup } from "../src/lib/sim/types";
import { todayET } from "../src/lib/date";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const none = { benched: [], activated: [] };

/** Everything that must hold for one finished game. */
function invariants(m: SimMatchup, r: GameResult): string[] {
  const errs: string[] = [];
  for (const side of ["home", "away"] as const) {
    const rows = r.box[side];
    const sum = (k: number) => rows.reduce((a, row) => a + row[k], 0);
    if (m.league === "nba") {
      if (sum(NBA.PTS) !== r[side]) errs.push(`${side} points ${sum(NBA.PTS)} != ${r[side]}`);
      for (const row of rows)
        if (2 * row[NBA.FGM] + row[NBA.TPM] + row[NBA.FTM] !== row[NBA.PTS])
          errs.push("FG/FT do not add to PTS");
      const length = 2880 + Math.max(0, r.periods.home.length - 4) * 300;
      if (Math.abs(sum(NBA.SEC) - 5 * length) > 1)
        errs.push(`${side} minutes ${sum(NBA.SEC)} != ${5 * length}`);
    } else if (m.league === "nhl") {
      const goals = sum(NHL.G);
      const final = r[side] - (r.so && r[side] > r[side === "home" ? "away" : "home"] ? 1 : 0);
      if (goals !== final) errs.push(`${side} goals ${goals} != ${final}`);
      if (sum(NHL.A) > 2 * goals) errs.push("more than two assists a goal");
    } else if (m.league === "mlb") {
      const nB = m[side].batters.length;
      const bat = rows.slice(0, nB);
      const runs = bat.reduce((a, row) => a + row[MLB.R], 0);
      if (runs !== r[side]) errs.push(`${side} runs ${runs} != ${r[side]}`);
      for (const row of bat)
        if (row[MLB.H] < row[MLB.D2] + row[MLB.D3] + row[MLB.HR])
          errs.push("hits < extra-base hits");
      const other = side === "home" ? "away" : "home";
      const allowed = r.box[other]
        .slice(m[other].batters.length)
        .reduce((a, row) => a + row[MLB.PR], 0);
      if (allowed !== r[side]) errs.push(`${other} pitchers charged ${allowed} != ${r[side]}`);
    } else {
      // Return touchdowns with no returner and safeties are not in the box, so
      // the box may fall short of the score but never exceed it.
      let pts = 0;
      for (const row of rows)
        pts +=
          6 * (row[NFL.RTD] + row[NFL.RETD] + row[NFL.DTD]) +
          3 * row[NFL.FGM] +
          row[NFL.XPM] +
          2 * row[NFL.TWOPT];
      if (pts > r[side]) errs.push(`${side} box points ${pts} > score ${r[side]}`);
      if (sum(NFL.CMP) !== sum(NFL.REC)) errs.push("completions != receptions");
      if (sum(NFL.PYD) !== sum(NFL.REYD)) errs.push("passing yards != receiving yards");
    }
    const per = r.periods[side].reduce((a, b) => a + b, 0);
    if (m.league !== "nhl" && per !== r[side]) errs.push(`${side} periods ${per} != ${r[side]}`);
  }
  if (!r.tie && r.home === r.away) errs.push("level score without a tie");
  if (r.tie && m.league !== "nfl") errs.push("a tie outside the NFL");
  return errs;
}

function sameGame(a: GameResult, b: GameResult): boolean {
  return a.home === b.home && a.away === b.away && JSON.stringify(a.box) === JSON.stringify(b.box);
}

function rebuilt(r: GameResult): boolean {
  const box = {
    home: r.box.home.map((x) => x.map(() => 0)),
    away: r.box.away.map((x) => x.map(() => 0)),
  };
  for (const e of r.events ?? [])
    for (const [s, p, st, v] of e.deltas ?? []) box[s === 0 ? "home" : "away"][p][st] += v;
  return JSON.stringify(box) === JSON.stringify(r.box);
}

async function league(lg: SimLeague) {
  console.log(`\n── ${lg.toUpperCase()} ─────────────────────────────`);
  const date = todayET();
  const teams = await listTeams(lg);
  check(`${lg}: team list`, teams.length >= 30, `${teams.length} teams`);
  // Every team appears: pairs (0,1), (2,3), …
  const matchups: SimMatchup[] = [];
  for (let i = 0; i + 1 < teams.length; i += 2)
    matchups.push(
      await buildMatchup({ league: lg, homeId: teams[i].id, awayId: teams[i + 1].id, date }),
    );
  const m0 = matchups[0];
  check(
    `${lg}: matchups built`,
    matchups.length >= 15,
    `${matchups.length}, basis: ${m0.ctx.basis}`,
  );

  // 1 & 2 — invariants, determinism, replay.
  let bad = 0;
  let nondet = 0;
  let replay = 0;
  let first = "";
  for (const m of matchups.slice(0, 6)) {
    const play = runner(m, none);
    for (let s = 1; s <= 40; s++) {
      const quiet = play(s, false);
      const loud = play(s, true);
      const errs = invariants(m, quiet);
      if (errs.length) {
        bad++;
        first ||= errs[0];
      }
      if (!sameGame(quiet, loud)) nondet++;
      if (!rebuilt(loud)) replay++;
    }
  }
  check(`${lg}: box scores add up`, bad === 0, bad ? `${bad} games, e.g. ${first}` : "240 games");
  check(`${lg}: a seed replays the same game`, nondet === 0, nondet ? `${nondet} differ` : "");
  check(
    `${lg}: play-by-play deltas rebuild the box`,
    replay === 0,
    replay ? `${replay} differ` : "",
  );

  // A batch split in pieces (as across workers) merges to the whole.
  {
    const m = matchups[0];
    const play = runner(m, none);
    const whole = new Accumulator(m);
    const parts = [new Accumulator(m), new Accumulator(m), new Accumulator(m)];
    for (let s = 1; s <= 90; s++) {
      const r = play(s * 7919, false);
      whole.add(r);
      parts[s % 3].add(r);
    }
    const merged = new Accumulator(m);
    for (const p of parts) merged.merge(p.st);
    const a = whole.summary(0);
    const b = merged.summary(0);
    // Histogram keys can be negative, which objects keep in insertion order.
    const hist = (h: Record<number, number>) =>
      JSON.stringify(Object.entries(h).sort((x, y) => Number(x[0]) - Number(y[0])));
    // Ice time is continuous, so sums taken in a different order may differ
    // in the last bits.
    const flat = (r: typeof a) =>
      r.players.flatMap((p) => [...p.avgBox, ...p.props.map((x) => x.mean)]);
    const fa = flat(a);
    const fb = flat(b);
    const same =
      a.n === b.n &&
      a.homeWins === b.homeWins &&
      hist(a.margin) === hist(b.margin) &&
      fa.length === fb.length &&
      fa.every((v, i) => Math.abs(v - fb[i]) <= 1e-9 * Math.max(1, Math.abs(v)));
    check(`${lg}: a batch merged from pieces equals the whole`, same);
  }

  // 3 — league level: every pairing both ways at a neutral site.
  const teamsAll = matchups.flatMap((m) => [m.home, m.away]);
  let pts = 0;
  let games = 0;
  const n = lg === "nhl" ? 3 : 4;
  for (let i = 0; i < teamsAll.length; i++)
    for (let j = 0; j < teamsAll.length; j++) {
      if (i === j) continue;
      const m = {
        ...m0,
        home: teamsAll[i],
        away: teamsAll[j],
        ctx: { ...m0.ctx, neutral: true, park: 100, line: null },
      } as SimMatchup;
      const play = runner(m, none);
      for (let k = 0; k < n; k++) {
        const r = play(i * 7919 + j * 31 + k, false);
        // NHL standings count the shootout winner as a goal, so the sim does too.
        pts += r.home + r.away;
        games += 2;
      }
    }
  const simPpg = pts / games;
  const lgPpg = lgAverage(m0);
  const err = simPpg / lgPpg - 1;
  check(
    `${lg}: scoring matches the league`,
    Math.abs(err) < 0.04,
    `sim ${simPpg.toFixed(2)} vs league ${lgPpg.toFixed(2)} (${(err * 100).toFixed(1)}%)`,
  );

  // Home edge: each roster against itself.
  let hw = 0;
  let decided = 0;
  for (const [idx, m] of matchups.entries()) {
    const mirror = { ...m, away: m.home } as SimMatchup;
    const play = runner(mirror, none);
    // Enough games that baseball's ~2-point home edge clears the bar by
    // several standard errors rather than one.
    for (let k = 0; k < 400; k++) {
      // Distinct seeds per matchup: shared ones correlate the games and make
      // the estimate noisier than its sample size suggests.
      const r = play((k * 104729 + idx * 7919 + 3) >>> 0, false);
      if (r.home !== r.away) {
        decided++;
        if (r.home > r.away) hw++;
      }
    }
  }
  const home = hw / Math.max(1, decided);
  check(
    `${lg}: home side wins a mirror match 51–58%`,
    home > 0.51 && home < 0.58,
    `${(home * 100).toFixed(1)}% of ${decided}`,
  );
}

function lgAverage(m: SimMatchup): number {
  switch (m.league) {
    case "nba":
      return m.env.ppg;
    case "nfl":
      return m.env.ppg;
    case "nhl":
      return m.env.gpg;
    case "mlb":
      return m.env.rpg;
  }
}

async function main() {
  const wanted = (process.argv.slice(2) as SimLeague[]).filter((x) =>
    ["nfl", "nba", "nhl", "mlb"].includes(x),
  );
  for (const lg of wanted.length ? wanted : (["nfl", "nba", "nhl", "mlb"] as SimLeague[])) {
    try {
      await league(lg);
    } catch (err) {
      check(`${lg}: ran`, false, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`\n${fails ? `${fails} FAILED` : "All checks passed"}`);
  process.exit(fails ? 1 : 0);
}

void main();
