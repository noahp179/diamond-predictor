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
import { PROPS } from "./sim/props";

export type SimPropsLeague = "nba" | "nhl" | "nfl" | "cfb";

/** The prop keys each league's boards read from the simulator. */
export const SIM_KEYS: Record<SimPropsLeague, string[]> = {
  nba: ["pts", "reb", "ast", "3pm", "pra", "pr", "pa", "ra", "dd", "stl", "blk", "stk"],
  nhl: ["pts", "g", "a", "sog", "sv"],
  nfl: ["td", "rec", "reyd", "ryd", "rry", "pyd", "ptd", "cmp", "car"],
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
  /** "20+ points" */
  label: string;
  /** "20+" — the chip when the board's stat is already chosen */
  short: string;
  /** "scores 20 or more points" — for sentences on the page */
  phrase: string;
  /** "score 20 or more points" — after "most likely to" */
  todo: string;
  /** The stat this market belongs to, when a board holds several ("Pts+Reb") */
  group?: string;
};

export type BoardDef = {
  key: string;
  label: string;
  hint: string;
  markets: Market[];
  /** the market a reader lands on */
  open?: string;
  /** what one row is, for the record panel */
  unit: string;
};

/** How each stat reads in a sentence. */
type StatWords = {
  /** plural noun after the number: "rebounds" */
  noun: string;
  /** chip / heading name of the stat: "Rebounds" */
  name: string;
  /** verb, third person and base: ["gets", "get"] */
  verb: [string, string];
  /** for the 1+ line: ["scores a goal", "score a goal"] */
  one?: [string, string];
  /** "averages 9.4 rebounds" — what the mean is called */
  per?: string;
  /** the 1+ line's name: "Anytime goal" */
  sing?: string;
  /** the noun in a sentence, when it differs: "throws for 250 or more yards" */
  said?: string;
};

const W: Record<string, StatWords> = {
  "nba:pts": { noun: "points", name: "Points", verb: ["scores", "score"] },
  "nba:reb": { noun: "rebounds", name: "Rebounds", verb: ["grabs", "grab"] },
  "nba:ast": { noun: "assists", name: "Assists", verb: ["hands out", "hand out"] },
  "nba:3pm": {
    noun: "threes",
    name: "Threes",
    verb: ["makes", "make"],
    one: ["makes a three", "make a three"],
    sing: "1+ three",
  },
  "nba:pra": {
    noun: "points + rebounds + assists",
    name: "Pts+Reb+Ast",
    verb: ["puts up", "put up"],
  },
  "nba:pr": { noun: "points + rebounds", name: "Pts+Reb", verb: ["puts up", "put up"] },
  "nba:pa": { noun: "points + assists", name: "Pts+Ast", verb: ["puts up", "put up"] },
  "nba:ra": { noun: "rebounds + assists", name: "Reb+Ast", verb: ["puts up", "put up"] },
  "nba:stl": {
    noun: "steals",
    name: "Steals",
    verb: ["records", "record"],
    one: ["records a steal", "record a steal"],
    sing: "1+ steal",
  },
  "nba:blk": {
    noun: "blocks",
    name: "Blocks",
    verb: ["records", "record"],
    one: ["records a block", "record a block"],
    sing: "1+ block",
  },
  "nba:stk": {
    noun: "steals + blocks",
    name: "Stl+Blk",
    verb: ["records", "record"],
    one: ["records a steal or a block", "record a steal or a block"],
    sing: "1+ steal or block",
  },
  "nhl:pts": {
    noun: "points",
    name: "Points",
    verb: ["gets", "get"],
    one: ["gets a point (goal or assist)", "get a point (goal or assist)"],
    sing: "1+ point",
  },
  "nhl:g": {
    noun: "goals",
    name: "Goals",
    verb: ["scores", "score"],
    one: ["scores a goal", "score a goal"],
    sing: "Anytime goal",
  },
  "nhl:a": {
    noun: "assists",
    name: "Assists",
    verb: ["gets", "get"],
    one: ["gets an assist", "get an assist"],
    sing: "1+ assist",
  },
  "nhl:sog": { noun: "shots on goal", name: "Shots on goal", verb: ["puts up", "put up"] },
  "nhl:sv": { noun: "saves", name: "Saves", verb: ["makes", "make"] },
  "nfl:td": {
    noun: "touchdowns",
    name: "Touchdowns",
    verb: ["scores", "score"],
    one: ["scores a touchdown", "score a touchdown"],
    per: "touchdowns a game",
    sing: "Anytime TD",
  },
  "nfl:rec": { noun: "catches", name: "Receptions", verb: ["makes", "make"] },
  "nfl:reyd": { noun: "receiving yards", name: "Receiving yards", verb: ["gains", "gain"] },
  "nfl:ryd": { noun: "rushing yards", name: "Rushing yards", verb: ["gains", "gain"] },
  "nfl:rry": { noun: "rushing + receiving yards", name: "Rush+Rec yards", verb: ["gains", "gain"] },
  "nfl:car": { noun: "carries", name: "Carries", verb: ["gets", "get"] },
  "nfl:pyd": {
    noun: "passing yards",
    name: "Passing yards",
    said: "yards",
    verb: ["throws for", "throw for"],
  },
  "nfl:ptd": {
    noun: "touchdown passes",
    name: "Passing TDs",
    verb: ["throws", "throw"],
    one: ["throws a touchdown pass", "throw a touchdown pass"],
    sing: "1+ TD pass",
  },
  "nfl:cmp": {
    noun: "completions",
    name: "Completions",
    said: "passes",
    verb: ["completes", "complete"],
  },
};

/** The simulator's lines for a stat (src/lib/sim/props.ts). */
export function linesOf(league: SimPropsLeague, stat: string): number[] {
  return PROPS[league].find((d) => d.key === stat)?.lines ?? [];
}

export function statWords(league: SimPropsLeague, stat: string): StatWords | undefined {
  return W[`${league === "cfb" ? "nfl" : league}:${stat}`];
}

/** One rung of a stat's ladder: the simulator's line at index i. */
function rung(league: SimPropsLeague, stat: string, i: number, group = false): Market {
  const line = linesOf(league, stat)[i];
  const w = statWords(league, stat)!;
  const key = `${stat}:${i}`;
  if (stat === "dd") {
    const what = line >= 3 ? "triple-double" : "double-double";
    return {
      key,
      label: line >= 3 ? "Triple-double" : "Double-double",
      short: line >= 3 ? "Triple" : "Double",
      phrase: `records a ${what}`,
      todo: `record a ${what}`,
    };
  }
  const [v3, v] = w.verb;
  const single = line === 1 && w.one;
  return {
    key,
    label: line === 1 && w.sing ? w.sing : `${line}+ ${w.noun}`,
    short: `${line}+`,
    phrase: single ? w.one![0] : `${v3} ${line} or more ${w.said ?? w.noun}`,
    todo: single ? w.one![1] : `${v} ${line} or more ${w.said ?? w.noun}`,
    group: group ? w.name : undefined,
  };
}

/** A stat's ladder at the given line indices. */
const ladder = (league: SimPropsLeague, stat: string, idx: number[], group = false) =>
  idx.map((i) => rung(league, stat, i, group));

const FIRST: Record<"nhl" | "nfl", Market> = {
  nhl: {
    key: "first",
    label: "First goal",
    short: "First",
    phrase: "scores the first goal",
    todo: "score the first goal",
  },
  nfl: {
    key: "first",
    label: "First TD",
    short: "First",
    phrase: "scores the first touchdown",
    todo: "score the first touchdown",
  },
};

export const SIM_BOARDS: Record<SimPropsLeague, BoardDef[]> = {
  nba: [
    {
      key: "points",
      label: "Points",
      hint: "10, 15, 20, 25 or 30+",
      markets: ladder("nba", "pts", [0, 1, 2, 3, 4]),
      open: "pts:2",
      unit: "picks",
    },
    {
      key: "rebounds",
      label: "Rebounds",
      hint: "4 to 12+ boards",
      markets: ladder("nba", "reb", [0, 1, 2, 3, 4]),
      open: "reb:2",
      unit: "picks",
    },
    {
      key: "assists",
      label: "Assists",
      hint: "2 to 10+ dimes",
      markets: ladder("nba", "ast", [0, 1, 2, 3, 4]),
      open: "ast:2",
      unit: "picks",
    },
    {
      key: "threes",
      label: "Threes",
      hint: "1 to 5+ made",
      markets: ladder("nba", "3pm", [0, 1, 2, 3, 4]),
      open: "3pm:1",
      unit: "picks",
    },
    {
      key: "combos",
      label: "Combos",
      hint: "PRA, Pts+Reb, Pts+Ast, Reb+Ast",
      markets: [
        ...ladder("nba", "pra", [1, 2, 3, 4, 5], true),
        ...ladder("nba", "pr", [1, 2, 3, 4, 5], true),
        ...ladder("nba", "pa", [1, 2, 3, 4, 5], true),
        ...ladder("nba", "ra", [0, 1, 2, 3, 4], true),
      ],
      open: "pra:3",
      unit: "picks",
    },
    {
      key: "double-double",
      label: "Double-double",
      hint: "double- and triple-doubles",
      markets: ladder("nba", "dd", [0, 1]),
      unit: "picks",
    },
    {
      key: "defense",
      label: "Steals & blocks",
      hint: "steals, blocks, both",
      markets: [
        ...ladder("nba", "stl", [0, 1], true),
        ...ladder("nba", "blk", [0, 1], true),
        ...ladder("nba", "stk", [0, 1, 2], true),
      ],
      open: "stk:1",
      unit: "picks",
    },
  ],
  nhl: [
    {
      key: "points",
      label: "Points",
      hint: "a goal or an assist",
      markets: ladder("nhl", "pts", [0, 1, 2]),
      unit: "picks",
    },
    {
      key: "goals",
      label: "Goalscorers",
      hint: "who scores a goal",
      markets: ladder("nhl", "g", [0, 1]),
      unit: "picks",
    },
    {
      key: "assists",
      label: "Assists",
      hint: "1+ or 2+ assists",
      markets: ladder("nhl", "a", [0, 1]),
      unit: "picks",
    },
    {
      key: "shots",
      label: "Shots on goal",
      hint: "2 to 5+ shots",
      markets: ladder("nhl", "sog", [1, 2, 3, 4]),
      open: "sog:2",
      unit: "picks",
    },
    {
      key: "first-goal",
      label: "First goal",
      hint: "who scores the game's first goal",
      markets: [FIRST.nhl],
      unit: "picks",
    },
    {
      key: "saves",
      label: "Goalie saves",
      hint: "20, 25 or 30+ saves",
      markets: ladder("nhl", "sv", [0, 1, 3]),
      open: "sv:1",
      unit: "picks",
    },
  ],
  nfl: [
    {
      key: "receiving",
      label: "Receiving",
      hint: "catches and receiving yards",
      markets: [
        ...ladder("nfl", "rec", [1, 2, 3, 4, 5], true),
        ...ladder("nfl", "reyd", [1, 2, 3, 4, 5, 6, 7], true),
      ],
      open: "reyd:4",
      unit: "picks",
    },
    {
      key: "rushing",
      label: "Rushing",
      hint: "rushing yards and carries",
      markets: [
        ...ladder("nfl", "ryd", [1, 2, 3, 4, 5, 6, 7], true),
        ...ladder("nfl", "car", [1, 2, 3, 4], true),
      ],
      open: "ryd:3",
      unit: "picks",
    },
    {
      key: "scrimmage",
      label: "Rush+Rec yards",
      hint: "yards from scrimmage",
      markets: ladder("nfl", "rry", [1, 2, 3, 4, 5, 6]),
      open: "rry:3",
      unit: "picks",
    },
    {
      key: "passing",
      label: "Passing",
      hint: "yards, TDs, completions",
      markets: [
        ...ladder("nfl", "pyd", [2, 3, 4, 5, 6], true),
        ...ladder("nfl", "ptd", [0, 1, 2], true),
        ...ladder("nfl", "cmp", [1, 2, 3, 4], true),
      ],
      open: "pyd:4",
      unit: "picks",
    },
    {
      key: "td-scorers",
      label: "TD scorers",
      hint: "who scores a touchdown",
      markets: ladder("nfl", "td", [0]),
      unit: "picks",
    },
    {
      key: "first-td",
      label: "First TD",
      hint: "who scores the first touchdown",
      markets: [FIRST.nfl],
      unit: "picks",
    },
  ],
  // College stays on its touchdown model: on 2025-26 it beat the simulator
  // for anytime and (split by share) for the first touchdown.
  cfb: [],
};

/** Every market a league's boards price, once each. */
export function simMarkets(league: SimPropsLeague): Market[] {
  const seen = new Map<string, Market>();
  for (const b of SIM_BOARDS[league]) for (const m of b.markets) seen.set(m.key, m);
  return [...seen.values()];
}

export function simBoard(league: SimPropsLeague, board: string): BoardDef | undefined {
  return SIM_BOARDS[league].find((b) => b.key === board);
}

// ------------------------------------------------------------ calibration

type Curve = { x: number[]; y: number[] };
const CAL = calibration as unknown as { curves: Record<string, Record<string, Curve>> };

/** The backtest's calibration map for a market: simulator share in, the share
 *  that actually came in out. Linear between knots, flat above the top one,
 *  and below the lowest knot scaled down to zero — the map was fitted on the
 *  players the simulator gave a real chance, and holding its bottom value flat
 *  under them priced a defenceman at 29% for 20 saves and a running back at
 *  20% for two touchdown passes. A market without a map (first scorer) is
 *  shown as the simulator has it. */
export function calibrate(league: SimPropsLeague, market: string, p: number): number {
  const c = CAL.curves[league]?.[market];
  if (!c || !c.x.length) return p;
  const { x, y } = c;
  if (p <= x[0]) return x[0] > 0 ? (y[0] * Math.max(0, p)) / x[0] : y[0];
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

/** A player's projected average for a stat: the simulator's, through the
 *  backtest's map from what it projected to what such players actually
 *  averaged (research/player-props/fit_means.py) — the number to hold up
 *  against a sportsbook's line. */
export function projectionOf(league: SimPropsLeague, stat: string, simMean: number): number {
  return calibrate(league, `mean:${stat}`, simMean);
}

/** The simulator's raw number for a market. */
export function rawOf(pl: SimPlayer, market: string): number {
  if (market === "first") return pl.first;
  const [key, i] = market.split(":");
  return pl.p[key]?.[Number(i)] ?? 0;
}

/** The number the board shows: raw, then calibrated where a map exists. A
 *  player the simulator never saw do it in 100,000 games is not priced at all —
 *  the map's floor is for players with some role in the market, not for a
 *  receiver's carries or a defenceman's saves. */
export function probOf(league: SimPropsLeague, pl: SimPlayer, market: string): number {
  const raw = rawOf(pl, market);
  if (!(raw > 0)) return 0;
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

// ------------------------------------------------------------- the record

/** The ledger's code for a market: "pts:2" in the NBA -> "pts20", the NHL's
 *  "g:0" -> "g1", "3pm:1" -> "3pm2", "first" -> "firstgoal" / "firsttd". */
export function marketSlug(league: SimPropsLeague, key: string): string {
  if (key === "first") return league === "nhl" ? "firstgoal" : "firsttd";
  const [stat, i] = key.split(":");
  return `${stat}${linesOf(league, stat)[Number(i)] ?? i}`;
}

/** Each market carries its own model version, so a player can be on several
 *  lines of the same game (20+ and 25+ points) under the ledger's
 *  one-row-per-version-player-game rule. */
export function simModelVersion(league: SimPropsLeague, slug: string): string {
  return `${league}-sim-${slug}-v1`;
}

/** A ledger code back to its stat and line: "3pm2" -> ["3pm", 2]. */
export function parseSlug(slug: string): [string, number] | null {
  const m = slug.match(/^(.+?)(\d+)$/);
  return m ? [m[1], Number(m[2])] : null;
}

/** A ledger code's bet name: "reb10" -> "10+ rebounds". */
export function simMarketLabel(league: SimPropsLeague, slug: string): string {
  return simMarkets(league).find((m) => marketSlug(league, m.key) === slug)?.label ?? slug;
}

/** Ledger code -> bet name for every simulation market (the NFL's "rec5" is
 *  "5+ catches" whichever model wrote it). */
export const SIM_MARKET_LABELS: Record<string, string> = Object.fromEntries(
  (["nba", "nhl", "nfl"] as const).flatMap((lg) =>
    simMarkets(lg).map((m) => [marketSlug(lg, m.key), m.label]),
  ),
);
