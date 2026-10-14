/**
 * sim-props-shared.ts — what the simulation-driven prop boards show, shared
 * by the server (scheduled runs, the ledger) and the browser (the board, and
 * its fallback that plays an unsimulated game right there).
 *
 * A board is a set of markets. Each market reads one number from a player's
 * simulated distribution — P(points >= 20), P(scores a goal), P(scores the
 * game's first touchdown) — and, where the backtest showed it helps, passes
 * it through that market's calibration map (research/player-props
 * export_calibration.py).
 */

import calibration from "./sim-props-calibration.json";
import type { MassResult } from "./sim/aggregate";

export type SimPropsLeague = "nba" | "nhl" | "nfl" | "cfb";

/** The prop keys each league's boards read from the simulator. */
export const SIM_KEYS: Record<SimPropsLeague, string[]> = {
  nba: ["pts"],
  nhl: ["pts", "g", "a"],
  nfl: ["td"],
  cfb: ["td"],
};

export type SimPlayer = {
  id: string;
  name: string;
  team: string;
  side: "home" | "away";
  pos: string;
  played: number;
  first: number;
  /** prop key -> P(value >= line) for each of the simulator's lines */
  p: Record<string, number[]>;
  mean: Record<string, number>;
};

export type Market = {
  /** "pts:2" = the simulator's pts prop at its third line; "first" = first scorer */
  key: string;
  label: string;
  short: string;
  /** "a player scores 20 or more points" — for sentences on the page */
  phrase: string;
};

export type BoardDef = {
  key: string;
  label: string;
  hint: string;
  markets: Market[];
  /** what one row is, for the record panel */
  unit: string;
};

const pts = (i: number, n: number): Market => ({
  key: `pts:${i}`,
  label: `${n}+ points`,
  short: `${n}+`,
  phrase: `scores ${n} or more points`,
});

export const SIM_BOARDS: Record<SimPropsLeague, BoardDef[]> = {
  nba: [
    {
      key: "points",
      label: "Points",
      hint: "who scores 10, 15, 20, 25 or 30+",
      markets: [pts(0, 10), pts(1, 15), pts(2, 20), pts(3, 25), pts(4, 30)],
      unit: "picks",
    },
  ],
  nhl: [
    {
      key: "points",
      label: "Points",
      hint: "a goal or an assist",
      markets: [
        { key: "pts:0", label: "1+ point", short: "1+", phrase: "gets a point (goal or assist)" },
        { key: "pts:1", label: "2+ points", short: "2+", phrase: "gets two or more points" },
      ],
      unit: "picks",
    },
    {
      key: "goals",
      label: "Goalscorers",
      hint: "who scores a goal",
      markets: [{ key: "g:0", label: "Anytime goal", short: "Goal", phrase: "scores a goal" }],
      unit: "picks",
    },
    {
      key: "first-goal",
      label: "First goal",
      hint: "who scores the game's first goal",
      markets: [
        { key: "first", label: "First goal", short: "First", phrase: "scores the first goal" },
      ],
      unit: "picks",
    },
  ],
  nfl: [
    {
      key: "td-scorers",
      label: "TD scorers",
      hint: "who scores a touchdown",
      markets: [{ key: "td:0", label: "Anytime TD", short: "TD", phrase: "scores a touchdown" }],
      unit: "picks",
    },
    {
      key: "first-td",
      label: "First TD",
      hint: "who scores the first touchdown",
      markets: [
        { key: "first", label: "First TD", short: "First", phrase: "scores the first touchdown" },
      ],
      unit: "picks",
    },
  ],
  cfb: [
    {
      key: "first-td",
      label: "First TD",
      hint: "who scores the first touchdown",
      markets: [
        { key: "first", label: "First TD", short: "First", phrase: "scores the first touchdown" },
      ],
      unit: "picks",
    },
  ],
};

export function simBoard(league: SimPropsLeague, board: string): BoardDef | undefined {
  return SIM_BOARDS[league].find((b) => b.key === board);
}

// ------------------------------------------------------------ calibration

type Curve = { x: number[]; y: number[] };
const CAL = calibration as unknown as { curves: Record<string, Record<string, Curve>> };

/** The backtest's calibration map for a market: simulator share in, the share
 *  that actually came in out. Linear between knots, flat beyond the ends. A
 *  market without a map (first scorer) is shown as the simulator has it. */
export function calibrate(league: SimPropsLeague, market: string, p: number): number {
  const c = CAL.curves[league]?.[market];
  if (!c || !c.x.length) return p;
  const { x, y } = c;
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= p) lo = mid;
    else hi = mid;
  }
  const t = x[hi] === x[lo] ? 0 : (p - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + t * (y[hi] - y[lo]);
}

/** The simulator's raw number for a market. */
export function rawOf(pl: SimPlayer, market: string): number {
  if (market === "first") return pl.first;
  const [key, i] = market.split(":");
  return pl.p[key]?.[Number(i)] ?? 0;
}

/** The number the board shows: raw, then calibrated where a map exists. */
export function probOf(league: SimPropsLeague, pl: SimPlayer, market: string): number {
  const raw = rawOf(pl, market);
  return market === "first" ? raw : calibrate(league, market, raw);
}

const round = (x: number, d = 5) => Math.round(x * 10 ** d) / 10 ** d;

/** A simulation's players, as the boards store and read them. */
export function playersFrom(
  league: SimPropsLeague,
  r: MassResult,
  abbr: { home: string; away: string },
): SimPlayer[] {
  const keys = SIM_KEYS[league];
  return r.players
    .filter((p) => p.played > 0.02)
    .map((p) => {
      const pp: Record<string, number[]> = {};
      const mean: Record<string, number> = {};
      for (const s of p.props)
        if (keys.includes(s.key)) {
          pp[s.key] = s.over.map((x) => round(x));
          mean[s.key] = round(s.mean, 3);
        }
      return {
        id: p.id,
        name: p.name,
        team: abbr[p.side],
        side: p.side,
        pos: p.pos,
        played: round(p.played, 3),
        first: round(p.first ?? 0),
        p: pp,
        mean,
      };
    })
    .filter((p) => Object.keys(p.p).length > 0 || p.first > 0);
}
