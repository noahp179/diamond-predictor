/**
 * Run the site's actual soccer engine (src/lib/sim/soccer.ts runBatch) on a
 * sample of 2025-26 test fixtures, to check the closed forms the backtest uses.
 *
 * Input: data/engine_fixtures.json (written by first_goal.py): per fixture,
 * each side's expected goals and its starters' shares under two definitions:
 *   site  the site's shares (src/lib/ucl.server.ts uclSquad formula)
 *   on    per-on-pitch share x m_start (the backtest's chosen sim variant),
 *         scaled down to 0.972 in total if the XI's shares exceed it
 * Every side also gets a "rest" scorer holding 1 - 0.028 - sum(starters'
 * shares) -- the bench and the rest of the squad -- because the engine's
 * pickScorer hands any unassigned remainder to the LAST scorer in the list.
 *
 * Output: data/engine_out/<variant>_<n>_<shard>.json with, per fixture, each
 * starter's anytime and first-scorer frequencies and the mean goals per side.
 *
 * Usage (from the repo root):
 *   npx tsx research/soccer-scorers/engine_check.ts --variant on --n 100000 --shard 0 --shards 2
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBatch, SOCCER_SIM, SoccerEngine, type SoccerSide } from "../../src/lib/sim/soccer";

type Share = { id: string; share: number };
type Side = { team: string; rate: number; site: Share[]; on: Share[] };
type Fixture = { matchId: string; league: string; home: Side; away: Side };

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const variant = arg("variant", "on") as "site" | "on";
const n = Number(arg("n", "1000"));
const shard = Number(arg("shard", "0"));
const shards = Number(arg("shards", "1"));

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "data", "engine_fixtures.json"), "utf8"),
) as Fixture[];
const engine = new SoccerEngine();
const OG = SOCCER_SIM.ownGoalShare;

function side(s: Side, name: string): SoccerSide {
  const scorers = s[variant].map((p) => ({ id: p.id, name: p.id, pos: "", share: p.share }));
  const used = scorers.reduce((a, p) => a + p.share, 0);
  scorers.push({ id: "rest", name: "rest", pos: "", share: Math.max(0, 1 - OG - used) });
  return { name, abbr: name, rate: s.rate, scorers };
}

const out: Record<string, unknown> = {};
const t0 = Date.now();
let k = 0;
for (let i = shard; i < fixtures.length; i += shards) {
  const f = fixtures[i];
  const seed = (Number(f.matchId) * 2654435761) >>> 0;
  const b = runBatch(n, seed, side(f.home, "home"), side(f.away, "away"), {}, engine);
  const ids = [...f.home[variant], ...f.away[variant]].map((p) => p.id);
  out[f.matchId] = {
    n: b.n,
    homeGoals: b.homeGoals / b.n,
    awayGoals: b.awayGoals / b.n,
    goalless: b.scores[0][0] / b.n,
    anytime: Object.fromEntries(ids.map((id) => [id, (b.anytime[id] ?? 0) / b.n])),
    first: Object.fromEntries(ids.map((id) => [id, (b.first[id] ?? 0) / b.n])),
  };
  k += 1;
  if (k % 20 === 0)
    console.log(
      `${variant} n=${n} shard ${shard}: ${k} fixtures, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
}
mkdirSync(join(here, "data", "engine_out"), { recursive: true });
writeFileSync(
  join(here, "data", "engine_out", `${variant}_${n}_${shard}.json`),
  JSON.stringify(out),
);
console.log(
  `${variant} n=${n} shard ${shard}: ${k} fixtures in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
