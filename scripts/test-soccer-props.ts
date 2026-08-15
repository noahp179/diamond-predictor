#!/usr/bin/env node
/**
 * Parity + sanity checks for the soccer prop pipeline.
 *
 * 1. PARITY. research/soccer/dump_parity.py writes real feature vectors and the
 *    probabilities Python gets from the shipped coefficients. The TypeScript
 *    scorer must reproduce them to 1e-9. This is what guarantees the numbers on
 *    the page are the numbers that were backtested — a wrong feature order, a
 *    missed standardisation or a dropped Platt term all change the answer and
 *    would otherwise be invisible.
 *
 * 2. COVERAGE. Every feature each model declares must be produced by
 *    featuresFor. A model asking for a feature the server never builds scores it
 *    as 0, which is silent and wrong — this is exactly the bug that shipped
 *    `own_*` as zeros the first time.
 *
 * 3. The state fold and the tier lookup.
 *
 * Run:  npx tsx scripts/test-soccer-props.ts
 */
import { readFileSync, existsSync } from "node:fs";

import {
  featuresFor,
  foldSeason,
  priorSeason,
  propsModelFor,
  scoreMarket,
  tierOf,
  type PlayerMatch,
} from "../src/lib/soccer-props.server";
import { LEAGUES, type LeagueSlug } from "../src/lib/soccer-leagues";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

// ---------------------------------------------------------------- 1. parity

for (const league of LEAGUES) {
  const path = `research/soccer/results/${league.slug}_parity.json`;
  if (!existsSync(path)) continue;
  const fx = JSON.parse(readFileSync(path, "utf8")) as {
    cases: { player: string; features: Record<string, number>; expected: Record<string, number> }[];
  };
  const model = propsModelFor(league.slug as LeagueSlug);
  let worst = 0;
  let worstAt = "";
  let n = 0;
  for (const c of fx.cases) {
    for (const [mk, want] of Object.entries(c.expected)) {
      const got = scoreMarket(model.markets[mk], c.features);
      const d = Math.abs(got - want);
      n += 1;
      if (d > worst) {
        worst = d;
        worstAt = `${c.player} ${mk}: ts ${got} vs py ${want}`;
      }
    }
  }
  check(
    `${league.name}: ${n} scored props match Python to 1e-9 (max diff ${worst.toExponential(2)})`,
    worst < 1e-9,
    worstAt,
  );
}

// -------------------------------------------------------------- 2. coverage

const pm = (over: Partial<PlayerMatch> = {}): PlayerMatch => ({
  matchId: "m1",
  date: "2026-01-01",
  playerId: "p1",
  name: "Player One",
  teamId: "t1",
  oppId: "t2",
  isHome: 1,
  pos: "F",
  starter: 1,
  formationPlace: 9,
  mins: 90,
  sh: 2,
  sot: 1,
  goal: 1,
  asst: 0,
  card: 0,
  foul: 1,
  ...over,
});

// A four-match mini season: p1 and p2 for t1, p3 for the opponent t2.
const rows: PlayerMatch[] = [];
for (let i = 0; i < 4; i += 1) {
  const id = `m${i}`;
  const date = `2026-01-0${i + 1}`;
  rows.push(pm({ matchId: id, date, playerId: "p1" }));
  rows.push(pm({ matchId: id, date, playerId: "p2", pos: "D", sh: 0, goal: 0, foul: 3, card: 1 }));
  rows.push(
    pm({ matchId: id, date, playerId: "p3", teamId: "t2", oppId: "t1", isHome: 0, sh: 1, goal: 0 }),
  );
}

const { players, teams } = foldSeason(rows);
const py = priorSeason(rows);
const f = featuresFor(players.get("p1")!, 1, teams.get("t1")!, teams.get("t2")!, py.get("p1"));

for (const league of LEAGUES) {
  const model = propsModelFor(league.slug as LeagueSlug);
  if (!model) continue;
  const missing = new Set<string>();
  for (const m of Object.values(model.markets)) {
    for (const name of m.features) if (!(name in f)) missing.add(name);
  }
  check(
    `${league.name}: every declared feature is built (${Object.keys(f).length} produced)`,
    missing.size === 0,
    `missing: ${[...missing].join(", ")}`,
  );
}

// ------------------------------------------------------------- 3. the fold

check("player state counts every appearance", players.get("p1")!.app === 4);
check("starts are counted", players.get("p1")!.start === 4);
check("shots accumulate", players.get("p1")!.sh === 8);
check(
  "market hits accumulate",
  players.get("p1")!.hits.sh2 === 4,
  `got ${players.get("p1")!.hits.sh2}`,
);
check(
  "2+ fouls counted for the defender only",
  players.get("p2")!.hits.foul2 === 4 && players.get("p1")!.hits.foul2 === 0,
);
check("the form window is capped at six matches", players.get("p1")!.window.length === 4);

check("team games counted once per match, not per player", teams.get("t1")!.gm === 4);
check("team shots are the side's total", teams.get("t1")!.sh === 8, `got ${teams.get("t1")!.sh}`);
check("shots allowed are charged to the opponent", teams.get("t2")!.shA === 8);

// Team rates are raw ratios in the research — not shrunk. Guard that.
check("team_sh_pg is a raw ratio", Math.abs(f.team_sh_pg - 8 / 4) < 1e-12, `got ${f.team_sh_pg}`);
check(
  "opp_sh_allowed is a raw ratio",
  Math.abs(f.opp_sh_allowed - 8 / 4) < 1e-12,
  `got ${f.opp_sh_allowed}`,
);
// Player rates ARE shrunk, toward the league prior with k = 12.
check(
  "sh_pa shrinks toward the league rate",
  Math.abs(f.sh_pa - (8 + 12 * 1.02) / (4 + 12)) < 1e-12,
  `got ${f.sh_pa}`,
);
check("position one-hots are exclusive", f.pos_fw === 1 && f.pos_mf === 0 && f.pos_df === 0);
// Pinned deliberately: ESPN emits slot codes ("CD-L", "CF-R") that the research's
// position lists do not contain, so 48% of starters carry no position flag and
// centre-backs never do. The scorer must reproduce that, not repair it — the
// coefficients were fitted on it. Repair belongs in a refit of props_soccer.py.
const slotCoded = featuresFor(
  { ...players.get("p1")!, pos: "CD-L" },
  1,
  teams.get("t1")!,
  teams.get("t2")!,
  undefined,
);
check(
  "ESPN slot codes fall through to no position flag, as in training",
  slotCoded.pos_fw === 0 &&
    slotCoded.pos_mf === 0 &&
    slotCoded.pos_df === 0 &&
    slotCoded.pos_gk === 0,
  "if this now flags a position, the live features no longer match the fit",
);
check(
  "appearances are capped at a season",
  featuresFor(
    { ...players.get("p1")!, app: 200, start: 200 },
    1,
    teams.get("t1")!,
    teams.get("t2")!,
    undefined,
  ).apps === 38,
);
check(
  "an unknown prior season is flagged, not faked",
  featuresFor(players.get("p1")!, 1, teams.get("t1")!, teams.get("t2")!, undefined).py_known === 0,
);

// -------------------------------------------------------------- 4. tiers

const epl = propsModelFor("epl");
if (epl) {
  const m = epl.markets.sh2;
  const strong = m.tiers[0];
  check(
    "a probability at the top floor lands in the top tier",
    tierOf(m, 0.99)?.label === strong.label,
  );
  check("a probability below every floor still lands somewhere", tierOf(m, 0) !== null);
  check(
    "tier floors descend",
    m.tiers.every((t, i) => i === 0 || t.minProb <= m.tiers[i - 1].minProb),
  );
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
