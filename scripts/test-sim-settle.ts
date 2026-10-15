#!/usr/bin/env node
/**
 * Checks the simulation boards' settlement reader against finished games: every
 * stat a market settles on, read from ESPN's summary by boxFor(), must equal the
 * same game's box score as the backtest data recorded it
 * (research/player-props/data), and every market's ledger code must grade.
 *
 *   npx tsx scripts/test-sim-settle.ts
 *
 * Needs network (ESPN). The research data is gitignored; without it the NBA
 * and NHL comparisons are skipped and only the shape checks run.
 */
import { existsSync, readFileSync } from "node:fs";

import { boxFor, nbaLine, outcome } from "../src/lib/sim-props.server";
import { marketSlug, simMarkets } from "../src/lib/sim-props-shared";

let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) fails += 1;
};

function research(sport: string, season: number, id: string) {
  const path = `research/player-props/data/${sport}_${season}.jsonl`;
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n"))
    if (line.includes(`"id":"${id}"`)) return JSON.parse(line);
  return null;
}

async function main() {
  // NBA: HOU @ OKC, opening night 2025-26 (double overtime).
  const nba = await boxFor("nba", "401809243");
  check(!!nba?.final, "NBA game reads as final");
  const g = research("nba", 2025, "401809243");
  if (nba && g) {
    let same = 0;
    let n = 0;
    for (const p of g.players) {
      if (!(p.min > 0)) continue;
      n += 1;
      const want = nbaLine(p.pts, p.reb, p.ast, p.tpm, p.stl, p.blk);
      const got = nba.lines.get(p.pid);
      if (got && Object.entries(want).every(([k, v]) => got[k] === v)) same += 1;
      else console.log("  mismatch", p.name, want, got);
    }
    check(n > 0 && same === n, `NBA: ${same}/${n} players' every stat matches the box score`);
  }
  // NHL: CHI @ FLA, 2025-10-07.
  const nhl = await boxFor("nhl", "401801798");
  check(!!nhl?.final, "NHL game reads as final");
  const h = research("nhl", 2025, "401801798");
  if (nhl && h) {
    let same = 0;
    let n = 0;
    for (const p of h.players) {
      if (!(p.toi > 0)) continue;
      n += 1;
      const got = nhl.lines.get(p.pid);
      const ok =
        p.grp === "goalies"
          ? got?.sv === p.sv
          : got?.g === p.g && got?.a === p.a && got?.pts === p.g + p.a && got?.sog === p.shots;
      if (ok) same += 1;
      else console.log("  mismatch", p.name, p, got);
    }
    check(n > 0 && same === n, `NHL: ${same}/${n} players (goalie saves too) match the box score`);
  }
  // NFL: every market grades on a finished game; yards add up.
  const nfl = await boxFor("nfl", "401772510");
  check(!!nfl?.final, "NFL game reads as final");
  if (nfl) {
    const rows = [...nfl.lines.entries()];
    check(
      rows.every(([, r]) => r.rry === r.ryd + r.reyd),
      `NFL: rush+rec yards add up for all ${rows.length} players`,
    );
    const qb = rows.sort((a, b) => b[1].pyd - a[1].pyd)[0];
    check(
      qb[1].pyd > 0 && qb[1].cmp > 0,
      `NFL: leading passer read (${qb[1].cmp} cmp, ${qb[1].pyd} yds)`,
    );
    for (const m of simMarkets("nfl")) {
      const slug = marketSlug("nfl", m.key);
      const r = outcome(slug, nfl, qb[0]);
      if (r == null && !slug.startsWith("first"))
        check(false, `NFL ${slug} graded for a player who played`);
    }
    check(outcome("rec3", nfl, "no-such-player") === null, "NFL: a player not in the box is void");
  }
  // Every NBA and NHL market grades for a player who played.
  for (const [lg, box] of [
    ["nba", nba],
    ["nhl", nhl],
  ] as const) {
    if (!box) continue;
    const skater = [...box.lines.entries()].find(([, r]) => r.pts != null)?.[0];
    const keeper = [...box.lines.entries()].find(([, r]) => r.sv != null)?.[0];
    const bad = simMarkets(lg)
      .map((m) => marketSlug(lg, m.key))
      .filter((s) => !s.startsWith("first"))
      .filter((s) => outcome(s, box, s.startsWith("sv") ? keeper! : skater!) == null);
    check(
      bad.length === 0,
      `${lg.toUpperCase()}: every market grades (${bad.join(", ") || "all"})`,
    );
  }
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
}

void main();
