/**
 * dump_markets.ts — the boards' markets, for the Python evaluation, so the
 * backtest scores exactly the lines the site shows.
 *
 *   npx tsx research/player-props/dump_markets.ts
 *
 * Writes research/player-props/data/markets.json:
 *   { nba: [{ key: "reb:2", stat: "reb", idx: 2, line: 8, slug: "reb8", label: "8+ rebounds", board: "rebounds" }, ...], ... }
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { linesOf, marketSlug, SIM_BOARDS } from "../../src/lib/sim-props-shared";

const out: Record<string, unknown[]> = {};
for (const league of ["nba", "nhl", "nfl"] as const) {
  out[league] = SIM_BOARDS[league].flatMap((b) =>
    b.markets.map((m) => {
      const [stat, i] = m.key.split(":");
      return {
        key: m.key,
        stat,
        idx: i == null ? null : Number(i),
        line: i == null ? null : linesOf(league, stat)[Number(i)],
        slug: marketSlug(league, m.key),
        label: m.label,
        group: m.group ?? null,
        board: b.key,
      };
    }),
  );
}
mkdirSync("research/player-props/data", { recursive: true });
writeFileSync("research/player-props/data/markets.json", JSON.stringify(out, null, 1));
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
