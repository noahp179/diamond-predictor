/**
 * End-to-end smoke test for the college football surfaces, against live ESPN.
 *
 *   bun scripts/test-cfb-smoke.ts [YYYY-MM-DD]
 *
 * Checks the three things that are cheap to get wrong and expensive to notice:
 * that a slate resolves at all, that the board actually produces one or two
 * picks a game rather than zero or four, and how long a cold page load costs.
 */
import { predictSlate, bestOddsSlate } from "../src/lib/espn.server";
import { cfbTdSlate } from "../src/lib/cfb-td.server";

const date = process.argv[2] ?? "2026-09-19";
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

console.log(`=== CFB slate ${date} ===`);
let t = Date.now();
const { games, season, gamesReplayed, power } = await predictSlate("cfb", date);
console.log(
  `predictSlate: ${games.length} games, season ${season}, ${gamesReplayed.toLocaleString()} replayed, ${((Date.now() - t) / 1000).toFixed(1)}s`,
);
console.log(
  "top 5:",
  power
    .slice(0, 5)
    .map((p) => `${p.rank}.${p.abbr} ${p.elo}`)
    .join("  "),
);
check(games.length > 0, "slate is not empty");
check(power.length > 0 && power.length <= 25, `power ranking capped at 25 (got ${power.length})`);
check(
  games.every((g) => g.homeWinProb > 0 && g.homeWinProb < 1),
  "every win probability is in (0,1)",
);
for (const g of games.slice(0, 3)) {
  console.log(
    `  ${g.away.abbreviation} @ ${g.home.abbreviation}: home ${(g.homeWinProb * 100).toFixed(1)}%  market ${g.pickConfidence != null ? (g.pickConfidence * 100).toFixed(1) + "%" : "—"}`,
  );
}

t = Date.now();
const bo = await bestOddsSlate("cfb", date);
const fromSpread = bo.rows.filter((r) => r.odds?.fromSpread).length;
console.log(
  `\nbestOdds: ${bo.rows.length} rows, ${bo.priced} priced (${fromSpread} off the spread), blend weight ${bo.blendWeight}, ${((Date.now() - t) / 1000).toFixed(1)}s`,
);
check(
  bo.rows.every((r) => r.odds == null || (r.odds.devigHome > 0 && r.odds.devigHome < 1)),
  "every market probability is in (0,1)",
);

t = Date.now();
const td = await cfbTdSlate(date);
const elapsed = (Date.now() - t) / 1000;
const picks = td.games.flatMap((g) => g.picks);
const one = td.games.filter((g) => g.picks.length === 1).length;
console.log(
  `\nTD board: ${td.games.length} games, ${picks.length} picks (${(picks.length / Math.max(1, td.games.length)).toFixed(2)}/game), ${one} one-pick / ${td.games.length - one} two-pick, stale=${td.staleFeatures}, ${elapsed.toFixed(1)}s`,
);
const byTier: Record<string, number> = {};
for (const p of picks) byTier[p.tier] = (byTier[p.tier] ?? 0) + 1;
console.log("  tiers:", byTier);
check(td.games.length > 0, "TD board is not empty");
check(
  td.games.every((g) => g.picks.length >= 1 && g.picks.length <= 2),
  "every game has one or two picks",
);
check(
  td.games.every((g) => g.picks.every((p) => p.prob > 0 && p.prob < 1 && p.player.length > 0)),
  "every pick has a name and a probability in (0,1)",
);
check(
  td.games.every((g) => g.picks.length === 1 || g.picks[1].prob >= 0.45),
  "a second pick only appears at or above the 0.45 bar",
);
check(
  td.games.every((g) => g.picks.length === 1 || g.picks[0].prob >= g.picks[1].prob),
  "picks are ordered by probability",
);

for (const g of td.games.slice(0, 5)) {
  console.log(`  ${g.matchup}  (margin ${g.homeMargin.toFixed(1)}, O/U ${g.total ?? "—"})`);
  for (const p of g.picks)
    console.log(
      `     ${p.player} · ${p.team} ${p.position} · ${(p.prob * 100).toFixed(1)}% · ${p.tier}`,
    );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
