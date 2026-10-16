#!/usr/bin/env node
/**
 * Checks a simulation board's grading on finished games, without writing
 * anything.
 *
 * For each game it plays the simulation the way the morning job does
 * (simulateGame; baseball with the day's lineup), takes each market's three
 * likeliest players — the picks the job would record — and grades them
 * against the box score the way the settle job does (boxFor + outcome). Then
 * it grades every player the board priced (pricedBands), as game_results
 * stores it.
 *
 *   npx tsx scripts/test-sim-grading.ts mlb|cfb|nfl|nba|nhl [event ids...]
 *
 * A picked player who did play but comes back void means his id did not meet
 * the box score (baseball: MLB's, matched by name) — the failure this exists
 * to catch. The server module reads import.meta.env, so it is loaded through
 * Vite's SSR loader.
 */
import { createServer } from "vite";

type League = "mlb" | "cfb" | "nfl" | "nba" | "nhl";
const league = (process.argv[2] ?? "mlb") as League;
const ESPN: Record<League, string> = {
  mlb: "baseball/mlb",
  cfb: "football/college-football",
  nfl: "football/nfl",
  nba: "basketball/nba",
  nhl: "hockey/nhl",
};
// a few finished games to try when none are named: MLB's 2026 playoffs
const DEFAULT: Partial<Record<League, string[]>> = {
  mlb: ["401908024", "401908032", "401908025", "401908033"],
};
const ids = process.argv.slice(3).length ? process.argv.slice(3) : (DEFAULT[league] ?? []);
const RUNS = Number(process.env.RUNS ?? 5000);
/** The regulars a box score must have: batters with a real share of the
 *  plate, football's ball carriers, targets and passers. */
const regular = (mean: Record<string, number>) =>
  league === "mlb"
    ? (mean.h ?? 0) > 0.05
    : (mean.car ?? 0) >= 5 || (mean.rec ?? 0) >= 2 || (mean.pyd ?? 0) >= 100;

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const mod = await vite.ssrLoadModule("/src/lib/sim-props.server.ts");
  const shared = await vite.ssrLoadModule("/src/lib/sim-props-shared.ts");
  const build = await vite.ssrLoadModule("/src/lib/sim/build.server.ts");
  const date = await vite.ssrLoadModule("/src/lib/date.ts");

  for (const id of ids) {
    const sb = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${ESPN[league]}/summary?event=${id}`,
    ).then((r) => r.json());
    const start = String(sb.header?.competitions?.[0]?.date ?? "");
    const day = date.etDateOf(start);
    const slate = await build.buildSlate(league, day);
    const g = slate.find((x: { id: string }) => x.id === id);
    if (!g) {
      check(`${id}: on the ${day} slate`, false);
      continue;
    }
    const sim = await mod.simulateGame(league, g, day, RUNS, Date.now() + 120_000);
    const box = await mod.boxFor(league, id);
    console.log(`\n${box?.matchup ?? id} ${day} — ${box?.score ?? "no box"}`);
    console.log(`      basis: ${sim.basis}`);
    if (!box) {
      check(`${id}: box score`, false);
      continue;
    }
    check(`${id}: game is final`, box.final);

    // The regulars each side was simulated with, and whether each played.
    const batters = sim.players.filter((p: { mean: Record<string, number> }) => regular(p.mean));
    const missing = batters.filter((p: { id: string }) => !box.lines.has(String(p.id)));
    const label = `${id}: simulated regulars in the box (${batters.length - missing.length}/${batters.length})`;
    if (league === "mlb")
      // baseball's ids are matched to MLB's box score by name: a miss is a bug
      check(label, missing.length <= 2, missing.map((p: { name: string }) => p.name).join(", "));
    else
      // ESPN's ids on both sides: a miss is a player who sat — re-simulating a
      // past game today cannot know who was hurt that day
      console.log(
        `      ${label}${missing.length ? `; sat: ${missing.map((p: { name: string }) => p.name).join(", ")}` : ""}`,
      );

    // The recorded picks: every market's top three, graded.
    let graded = 0;
    let hits = 0;
    let said = 0;
    const voids: string[] = [];
    for (const m of shared.simMarkets(league)) {
      const slug = shared.marketSlug(league, m.key);
      const top = sim.players
        .map((p: { id: string }) => ({ p, prob: shared.probOf(league, p, m.key) }))
        .filter((x: { prob: number }) => x.prob > 0.001)
        .sort((a: { prob: number }, b: { prob: number }) => b.prob - a.prob)
        .slice(0, 3);
      for (const { p, prob } of top) {
        const hit = mod.outcome(slug, box, String(p.id));
        if (hit == null) {
          voids.push(`${slug} ${p.name}`);
          continue;
        }
        graded += 1;
        said += prob;
        if (hit) hits += 1;
        // The verdict agrees with the stat line it was read from.
        const ms = mod.marketStat(league, slug) as [string, number] | null;
        if (!ms) {
          // the first scorer: the box score's first touchdown / goal
          if ((box.first === String(p.id)) !== hit)
            check(`${id}: ${slug} ${p.name} verdict matches the first scorer`, false);
          continue;
        }
        const v = box.lines.get(String(p.id))?.[ms[0]];
        if ((v != null && v >= ms[1]) !== hit)
          check(`${id}: ${slug} ${p.name} verdict matches line`, false, `${v} vs ${ms[1]}`);
      }
    }
    console.log(
      `      picks: ${graded} graded, ${hits} came in (board said ${said.toFixed(1)}), ${voids.length} void`,
    );
    // A pick on a player who appeared in the box is never void.
    const badVoid = voids.filter((v) => {
      const name = v.split(" ").slice(1).join(" ");
      return [...box.who.values()].some((w: { name: string }) => w.name === name);
    });
    check(`${id}: no pick voided on a player who played`, badVoid.length === 0, badVoid.join("; "));

    // Every priced player at every line, as game_results.priced stores it.
    const priced = mod.pricedBands(league, sim.players, box) as Record<
      string,
      [number, number, number, number][]
    >;
    const markets = Object.keys(priced);
    const n = (k: string) => (priced[k] ?? []).reduce((s, b) => s + b[1], 0);
    const did = (k: string) => (priced[k] ?? []).reduce((s, b) => s + b[2], 0);
    const all = shared
      .simMarkets(league)
      .map((m: { key: string }) => shared.marketSlug(league, m.key));
    const unpriced = all.filter((s: string) => !markets.includes(s));
    check(
      `${id}: every market priced (${markets.length}/${all.length})`,
      // football's first touchdown goes unpriced in a game with none
      unpriced.length === 0 || (unpriced.join() === "firsttd" && box.first == null),
      unpriced.join(", "),
    );
    console.log(
      "      priced: " +
        (league === "mlb"
          ? ["h1", "tb2", "hr1", "hrr2", "k6", "outs15", "er2"]
          : ["td1", "firsttd", "rec5", "reyd60", "ryd60", "rry75", "pyd250", "ptd2"]
        )
          .map((k) => `${k} ${did(k)}/${n(k)}`)
          .join(" · "),
    );
  }
} finally {
  await vite.close();
}
console.log(`\n${fails ? `${fails} FAILED` : "all checks passed"}`);
process.exit(fails ? 1 : 0);
