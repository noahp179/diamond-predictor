#!/usr/bin/env node
/**
 * The props ledger's settlement pieces, against real finished games.
 *
 * prop-ledger.server.ts scores every prop pick from the box score by the same
 * rule its model was fitted to. This checks each sport's piece on a game that
 * certainly finished — that the box score is read, that a stat line settles
 * the way its numbers say it should, and that a player with no line is a void
 * (null), not a miss.
 *
 * Run:  npx tsx scripts/test-prop-ledger.ts
 */
import { mlbBox } from "../src/lib/prop-ledger.server";
import { mlbPropOutcome } from "../src/lib/mlb-props.server";
import { fetchSummary } from "../src/lib/nfl-espn.server";
import { nflPropOutcome } from "../src/lib/nfl-props.server";
import { soccerMatchLines, soccerPropOutcome } from "../src/lib/soccer-props.server";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// ---------------------------------------------------------------- MLB
{
  const box = await mlbBox("823570"); // 2026-09-20
  check(
    `MLB box: ${box.bat.size} batters, ${box.pit.size} pitchers, score ${box.score}`,
    box.bat.size >= 18 && box.pit.size >= 2,
  );
  const [id, line] = [...box.bat.entries()].find(([, b]) => b.pa > 0)!;
  check(
    `MLB 1+ hit settles on hits (${line.h} hits → ${mlbPropOutcome("h1", line, null)})`,
    mlbPropOutcome("h1", line, null) === line.h >= 1,
  );
  check("MLB 2+ total bases settles on TB", mlbPropOutcome("tb2", line, null) === line.tb >= 2);
  check(
    "MLB batter with no plate appearance is a void",
    mlbPropOutcome("h1", { ...line, pa: 0 }, null) === null,
  );
  const starter = [...box.pit.values()].find((p) => p.gs > 0)!;
  check(
    `MLB 5+ strikeouts settles for a starter (${starter.k} K)`,
    mlbPropOutcome("k5", null, starter) === starter.k >= 5,
  );
  check(
    "MLB reliever's strikeouts never count",
    mlbPropOutcome("k5", null, { ...starter, gs: 0 }) === null,
  );
  check(
    "MLB unknown player is a void",
    mlbPropOutcome("h1", box.bat.get("1") ?? null, null) === null && !!id,
  );
}

// ---------------------------------------------------------------- NFL
{
  const box = await fetchSummary(401872971); // NE @ BUF, 2026-10-04
  const players = box?.teams.flatMap((t) => t.players) ?? [];
  check(`NFL box: ${players.length} players`, players.length >= 15);
  const wr = players.find((p) => p.rec > 0)!;
  check(
    `NFL 3+ receptions settles on catches (${wr.name}: ${wr.rec} rec)`,
    nflPropOutcome("rec3", wr) === wr.rec >= 3,
  );
  check(`NFL 40+ receiving yards (${wr.cy} yds)`, nflPropOutcome("recy40", wr) === wr.cy >= 40);
  check("NFL player with no line is a void", nflPropOutcome("rec3", undefined) === null);
}

// ------------------------------------------------------------- soccer
{
  const lines = await soccerMatchLines("epl", "401879268"); // Leeds at Arsenal, 2026-10-10
  check(`Soccer lines: ${lines?.length ?? 0} players`, (lines?.length ?? 0) >= 22);
  const shooter = lines?.find((l) => l.mins > 0 && l.sh > 0);
  if (shooter)
    check(
      `Soccer 1+ shots settles on shots (${shooter.name}: ${shooter.sh})`,
      soccerPropOutcome("sh1", shooter) === true,
    );
  const unused = lines?.find((l) => l.mins === 0);
  if (unused)
    check("Soccer unused substitute is a void", soccerPropOutcome("sh1", unused) === null);
  const live = await soccerMatchLines("epl", "999999999");
  check("Soccer: a match that is not final settles nothing", live === null);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
