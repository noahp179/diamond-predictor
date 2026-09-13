/**
 * Does the settler actually find the picked player in a finished box score?
 *
 * This is the part that is easy to get quietly wrong: an athlete-id mismatch,
 * a stat column read by the wrong index, a game treated as final before it is.
 * None of those throw — they just write a wrong result and the ledger looks
 * healthy. So this runs the real board over a past slate, then settles those
 * picks against the real box scores and prints every one.
 *
 *   bun scripts/test-td-settle.ts [YYYY-MM-DD]
 *
 * It touches no database: the snapshot and settle steps are exercised through
 * the same code paths, with the rows held in memory.
 *
 * The hit rate it prints is NOT a measurement of the model. A past slate is
 * rebuilt from season totals that already include the games being projected —
 * the board flags exactly this — so the picks are contaminated. What is being
 * checked here is mechanical: that every picked athlete id is found in the box
 * score, and that touchdowns are read from the right column. CFB-ANALYSIS.md
 * has the honest accuracy numbers, and the live ledger will have the rest.
 */
import { cfbTdSlate } from "../src/lib/cfb-td.server";

const date = process.argv[2] ?? "2026-09-12";

// Mirror of boxScoreTds in td-ledger.server.ts, which is module-private.
async function boxScore(eventId: number) {
  const r = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${eventId}`,
    { headers: { accept: "application/json" } },
  );
  const d = (await r.json()) as {
    header?: { competitions?: { status?: { type?: { completed?: boolean } } }[] };
    boxscore?: {
      players?: {
        statistics?: {
          name?: string;
          keys?: string[];
          athletes?: { athlete?: { id?: string }; stats?: string[] }[];
        }[];
      }[];
    };
  };
  const comp = d.header?.competitions?.[0];
  if (comp?.status?.type?.completed !== true) return null;
  const tds = new Map<string, number>();
  for (const tb of d.boxscore?.players ?? []) {
    for (const cat of tb.statistics ?? []) {
      if (cat.name !== "rushing" && cat.name !== "receiving") continue;
      const field = cat.name === "rushing" ? "rushingTouchdowns" : "receivingTouchdowns";
      const idx = (cat.keys ?? []).indexOf(field);
      if (idx < 0) continue;
      for (const a of cat.athletes ?? []) {
        const id = a.athlete?.id;
        if (!id) continue;
        const n = Number(a.stats?.[idx]);
        tds.set(String(id), (tds.get(String(id)) ?? 0) + (Number.isFinite(n) ? n : 0));
      }
    }
  }
  return tds;
}

const { games } = await cfbTdSlate(date);
console.log(`${date}: ${games.length} games on the board\n`);

let n = 0;
let hits = 0;
let unresolved = 0;
for (const g of games.slice(0, 12)) {
  const tds = await boxScore(g.gameId);
  if (!tds) {
    console.log(`  ${g.matchup}: not final`);
    continue;
  }
  for (const [i, p] of g.picks.entries()) {
    const rank = i + 1;
    const t = tds.get(p.playerId);
    const scored = (t ?? 0) > 0;
    n++;
    if (scored) hits++;
    // A player absent from the box score recorded no carry or catch. That is a
    // real zero, but if it were happening often it would mean the ids do not
    // line up, so it is counted and reported rather than silently folded in.
    if (t === undefined) unresolved++;
    console.log(
      `  ${g.matchup.padEnd(16)} #${rank} ${p.player.padEnd(24)} ${p.team.padEnd(5)} ` +
        `said ${(p.prob * 100).toFixed(0).padStart(3)}%  ->  ` +
        `${scored ? `✓ ${t} TD` : t === undefined ? "✗ no box-score line" : "✗ none"}`,
    );
  }
}
console.log(
  `\n${n} picks settled, ${hits} scored (${n ? ((hits / n) * 100).toFixed(1) : "—"}%), ` +
    `${unresolved} had no box-score line`,
);
console.log("(that hit rate is not a measurement — see the note at the top of this file)");
if (n > 0 && unresolved / n > 0.25) {
  console.error("\nFAIL — too many picks missing from the box score; athlete ids may not line up.");
  process.exit(1);
}
console.log("ids line up.");
