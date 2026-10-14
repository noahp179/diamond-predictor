/**
 * Parity check: does features.py's Python port of the live props code give the
 * same goal1 probabilities as the site's own TypeScript?
 *
 * features.py writes data/parity_sample.json: for five (league, date) slates,
 * the exact player rows the live board would fold that morning (this season
 * before the date, with last season prepended under the early-season rule), last
 * season's rows, and every starter with the Python probability. This script
 * runs those rows through the site's exported foldSeason / priorSeason /
 * featuresFor / scoreMarket (src/lib/soccer-props.server.ts) and reports the
 * largest disagreement.
 *
 * Usage (from the repo root):  npx tsx research/soccer-scorers/parity_props.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  featuresFor,
  foldSeason,
  priorSeason,
  propsModelFor,
  scoreMarket,
  type PlayerMatch,
} from "../../src/lib/soccer-props.server";

type Sample = {
  league: string;
  date: string;
  rows: PlayerMatch[];
  last: PlayerMatch[];
  candidates: {
    matchId: string;
    playerId: string;
    teamId: string;
    oppId: string;
    isHome: number;
    p: number | null;
  }[];
};

const here = dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(readFileSync(join(here, "data", "parity_sample.json"), "utf8")) as Sample[];

const norm = (r: PlayerMatch): PlayerMatch => ({
  ...r,
  matchId: String(r.matchId),
  playerId: String(r.playerId),
  teamId: String(r.teamId),
  oppId: String(r.oppId),
  name: r.name ?? "",
  pos: r.pos ?? "",
  formationPlace: Number(r.formationPlace) || 0,
});

let worst = 0;
let compared = 0;
let bothNull = 0;
let mismatchNull = 0;
for (const s of samples) {
  const model = propsModelFor(s.league as never).markets.goal1;
  const { players, teams } = foldSeason(s.rows.map(norm));
  const py = priorSeason(s.last.map(norm));
  let w = 0;
  for (const c of s.candidates) {
    const p = players.get(String(c.playerId));
    const team = teams.get(String(c.teamId));
    const opp = teams.get(String(c.oppId));
    let ts: number | null = null;
    if (p && team && opp && team.gm > 0 && opp.gm > 0) {
      ts = scoreMarket(model, featuresFor(p, c.isHome, team, opp, py.get(String(c.playerId))));
    }
    if (ts === null && c.p === null) {
      bothNull += 1;
      continue;
    }
    if (ts === null || c.p === null) {
      mismatchNull += 1;
      continue;
    }
    const d = Math.abs(ts - c.p);
    w = Math.max(w, d);
    compared += 1;
  }
  worst = Math.max(worst, w);
  console.log(
    `${s.league.padEnd(11)} ${s.date}  rows ${String(s.rows.length).padStart(6)}  starters ${String(
      s.candidates.length,
    ).padStart(3)}  max |TS - Python| = ${w.toExponential(2)}`,
  );
}
console.log(
  `\ncompared ${compared} probabilities, unscored by both ${bothNull}, scored by only one ${mismatchNull}; ` +
    `largest difference ${worst.toExponential(2)}`,
);
if (worst > 1e-9 || mismatchNull > 0) process.exit(1);
