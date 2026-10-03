/**
 * tendencies.server.ts — what each team does, and what it lets opponents do.
 *
 * Player statistics describe offense well and defense badly: nobody records
 * the yards a cornerback prevented. Team statistics fill that gap, because
 * ESPN publishes every team's season totals *and its opponents'* — the
 * completion percentage it allows, the yards per carry it allows, the shooting
 * percentages opponents post against it. Those are the defensive tendencies
 * the engines play against.
 *
 * Each tendency is a rate with a denominator (attempts, carries, games), so it
 * can be regressed toward the league the same way player rates are: three
 * games of a pass defense allowing 8.5 yards a completion is mostly the
 * league's 10.9 still; a full season of it is mostly the team's own.
 *
 * Keys by league — the engines read these names:
 *
 *   NFL  passRate, pace, defCmp, defYpc, defSack, defInt, defYpcRush, defTd, def3rd
 *   CFB  the same, counted college's way (a sack is a rush)
 *   NBA  pace, defOpp2p, defOpp3p, defOpp3aRate, defOppFtRate, defForcedTov, defDreb
 *   NHL  shotsFor, shotsAgainst, ppPct, pkPct, pim
 *   MLB  errors, ops, era
 */

import type { TeamTotals } from "./espn-stats.server";
import type { SimLeague, Tendency } from "./types";

type Pooled = { own: Record<string, number>; opp: Record<string, number> };

const v = (r: Record<string, number>, k: string) => r[k] ?? 0;

/** Totals that cannot be summed as published: a percentage, or innings in
 *  baseball's ".1 = one third" notation. Converted per season, then pooled. */
function derive(league: SimLeague, r: Record<string, number>): Record<string, number> {
  if (league === "nhl")
    return {
      ...r,
      "defensive.pkGames": (v(r, "defensive.penaltyKillPct") / 100) * v(r, "general.games"),
    };
  if (league === "mlb") {
    const ip = v(r, "pitching.innings");
    const whole = Math.floor(ip + 1e-9);
    return { ...r, "pitching.outs": whole * 3 + Math.round((ip - whole) * 10) };
  }
  return r;
}

/** This season's team totals plus `w` × last season's. */
export function poolTeams(
  league: SimLeague,
  cur: Map<string, TeamTotals>,
  old: Map<string, TeamTotals>,
  w: number,
): Map<string, Pooled> {
  const out = new Map<string, Pooled>();
  const add = (into: Record<string, number>, from: Record<string, number>, k: number) => {
    for (const [key, val] of Object.entries(from)) into[key] = (into[key] ?? 0) + k * val;
  };
  for (const id of new Set([...cur.keys(), ...old.keys()])) {
    const p: Pooled = { own: {}, opp: {} };
    const a = cur.get(id);
    const b = old.get(id);
    if (a) {
      add(p.own, derive(league, a.own), 1);
      add(p.opp, a.opp, 1);
    }
    if (b) {
      add(p.own, derive(league, b.own), w);
      add(p.opp, b.opp, w);
    }
    out.set(id, p);
  }
  return out;
}

/** A rate num/den regressed toward the league's with k pseudo-units. */
function rate(
  label: string,
  num: number,
  den: number,
  lgNum: number,
  lgDen: number,
  k: number,
  fmt: Tendency["fmt"],
  good: Tendency["good"],
): Tendency {
  const league = lgDen > 0 ? lgNum / lgDen : 0;
  return {
    label,
    value: den + k > 0 ? (num + k * league) / (den + k) : league,
    raw: den > 0 ? num / den : league,
    league,
    fmt,
    good,
  };
}

type Spec = {
  key: string;
  label: string;
  num: (p: Pooled) => number;
  den: (p: Pooled) => number;
  k: number;
  fmt: Tendency["fmt"];
  good: Tendency["good"];
};

function build(specs: Spec[], pool: Map<string, Pooled>): Map<string, Record<string, Tendency>> {
  const totals = specs.map((s) => {
    let n = 0;
    let d = 0;
    for (const p of pool.values()) {
      n += s.num(p);
      d += s.den(p);
    }
    return { n, d };
  });
  const out = new Map<string, Record<string, Tendency>>();
  for (const [id, p] of pool) {
    const rec: Record<string, Tendency> = {};
    specs.forEach((s, i) => {
      rec[s.key] = rate(s.label, s.num(p), s.den(p), totals[i].n, totals[i].d, s.k, s.fmt, s.good);
    });
    out.set(id, rec);
  }
  return out;
}

// ------------------------------------------------------------------ NFL

const nflPlays = (r: Record<string, number>) =>
  v(r, "passing.passingAttempts") + v(r, "passing.sacks") + v(r, "rushing.rushingAttempts");

const NFL: Spec[] = [
  {
    key: "passRate",
    label: "Pass rate (dropbacks per play)",
    num: (p) => v(p.own, "passing.passingAttempts") + v(p.own, "passing.sacks"),
    den: (p) => nflPlays(p.own),
    k: 250,
    fmt: "pct",
    good: "style",
  },
  {
    key: "pace",
    label: "Offensive plays per game",
    num: (p) => nflPlays(p.own),
    den: (p) => v(p.own, "general.gamesPlayed"),
    k: 4,
    fmt: 1,
    good: "style",
  },
  {
    key: "defCmp",
    label: "Completion % allowed",
    num: (p) => v(p.opp, "passing.completions"),
    den: (p) => v(p.opp, "passing.passingAttempts"),
    k: 200,
    fmt: "pct",
    good: "low",
  },
  {
    key: "defYpc",
    label: "Yards per completion allowed",
    num: (p) => v(p.opp, "passing.passingYards"),
    den: (p) => v(p.opp, "passing.completions"),
    k: 120,
    fmt: 1,
    good: "low",
  },
  {
    key: "defSack",
    label: "Sack rate (per dropback)",
    num: (p) => v(p.opp, "passing.sacks"),
    den: (p) => v(p.opp, "passing.passingAttempts") + v(p.opp, "passing.sacks"),
    k: 200,
    fmt: "pct",
    good: "high",
  },
  {
    key: "defInt",
    label: "Interception rate (per attempt)",
    num: (p) => v(p.opp, "passing.interceptions"),
    den: (p) => v(p.opp, "passing.passingAttempts"),
    k: 400,
    fmt: "pct",
    good: "high",
  },
  {
    key: "defYpcRush",
    label: "Yards per carry allowed",
    num: (p) => v(p.opp, "rushing.rushingYards"),
    den: (p) => v(p.opp, "rushing.rushingAttempts"),
    k: 200,
    fmt: 2,
    good: "low",
  },
  {
    key: "defTd",
    label: "Touchdowns allowed per 100 plays",
    num: (p) =>
      100 * (v(p.opp, "passing.passingTouchdowns") + v(p.opp, "rushing.rushingTouchdowns")),
    den: (p) => nflPlays(p.opp),
    k: 500,
    fmt: 2,
    good: "low",
  },
  {
    key: "def3rd",
    label: "3rd-down conversions allowed",
    num: (p) => v(p.opp, "miscellaneous.thirdDownConvs"),
    den: (p) => v(p.opp, "miscellaneous.thirdDownAttempts"),
    k: 80,
    fmt: "pct",
    good: "low",
  },
];

// -------------------------------------------------------------- college

/**
 * College counts a sack as a rush (and passing yards gross), so plays are
 * attempts plus rushes, and yards per carry allowed takes the sacks back out.
 */
const cfbPlays = (r: Record<string, number>) =>
  v(r, "passing.passingAttempts") + v(r, "rushing.rushingAttempts");

const CFB: Spec[] = NFL.map((spec): Spec => {
  switch (spec.key) {
    case "passRate":
      return { ...spec, den: (p) => cfbPlays(p.own) };
    case "pace":
      return { ...spec, num: (p) => cfbPlays(p.own) };
    case "defYpcRush":
      return {
        ...spec,
        num: (p) => v(p.opp, "rushing.rushingYards") + v(p.opp, "passing.sackYardsLost"),
        den: (p) => v(p.opp, "rushing.rushingAttempts") - v(p.opp, "passing.sacks"),
      };
    case "defTd":
      return { ...spec, den: (p) => cfbPlays(p.opp) };
    default:
      return spec;
  }
});

// ------------------------------------------------------------------ NBA

const nbaPoss = (r: Record<string, number>) =>
  v(r, "offensive.fieldGoalsAttempted") -
  v(r, "offensive.offensiveRebounds") +
  v(r, "offensive.turnovers") +
  0.44 * v(r, "offensive.freeThrowsAttempted");

const NBA: Spec[] = [
  {
    key: "pace",
    label: "Possessions per game",
    num: (p) => (nbaPoss(p.own) + nbaPoss(p.opp)) / 2,
    den: (p) => v(p.own, "general.gamesPlayed"),
    k: 10,
    fmt: 1,
    good: "style",
  },
  {
    key: "defOpp2p",
    label: "Opponent 2-point %",
    num: (p) =>
      v(p.opp, "offensive.fieldGoalsMade") - v(p.opp, "offensive.threePointFieldGoalsMade"),
    den: (p) =>
      v(p.opp, "offensive.fieldGoalsAttempted") -
      v(p.opp, "offensive.threePointFieldGoalsAttempted"),
    k: 1200,
    fmt: "pct",
    good: "low",
  },
  {
    key: "defOpp3p",
    label: "Opponent 3-point %",
    // Three-point defense is mostly luck; it takes thousands of attempts to
    // separate a good one from a fortunate one.
    num: (p) => v(p.opp, "offensive.threePointFieldGoalsMade"),
    den: (p) => v(p.opp, "offensive.threePointFieldGoalsAttempted"),
    k: 2500,
    fmt: "pct",
    good: "low",
  },
  {
    key: "defOpp3aRate",
    label: "Opponent shots that are threes",
    num: (p) => v(p.opp, "offensive.threePointFieldGoalsAttempted"),
    den: (p) => v(p.opp, "offensive.fieldGoalsAttempted"),
    k: 500,
    fmt: "pct",
    good: "low",
  },
  {
    key: "defOppFtRate",
    label: "Opponent free throws per shot",
    num: (p) => v(p.opp, "offensive.freeThrowsAttempted"),
    den: (p) => v(p.opp, "offensive.fieldGoalsAttempted"),
    k: 600,
    fmt: 3,
    good: "low",
  },
  {
    key: "defForcedTov",
    label: "Turnovers forced per 100 possessions",
    num: (p) => 100 * v(p.opp, "offensive.turnovers"),
    den: (p) => nbaPoss(p.opp),
    k: 600,
    fmt: 1,
    good: "high",
  },
  {
    key: "defDreb",
    label: "Defensive rebound %",
    num: (p) => v(p.own, "defensive.defensiveRebounds"),
    den: (p) => v(p.own, "defensive.defensiveRebounds") + v(p.opp, "offensive.offensiveRebounds"),
    k: 400,
    fmt: "pct",
    good: "high",
  },
];

// ------------------------------------------------------------------ NHL

const NHL: Spec[] = [
  {
    key: "shotsFor",
    label: "Shots on goal per game",
    num: (p) => v(p.own, "offensive.shotsTotal"),
    den: (p) => v(p.own, "general.games"),
    k: 8,
    fmt: 1,
    good: "high",
  },
  {
    key: "shotsAgainst",
    label: "Shots allowed per game",
    num: (p) => v(p.own, "defensive.shotsAgainst"),
    den: (p) => v(p.own, "general.games"),
    k: 8,
    fmt: 1,
    good: "low",
  },
  {
    key: "ppPct",
    label: "Power-play conversion",
    num: (p) => v(p.own, "offensive.powerPlayGoals"),
    den: (p) => v(p.own, "offensive.powerPlayOpportunities"),
    k: 80,
    fmt: "pct",
    good: "high",
  },
  {
    key: "pkPct",
    label: "Penalty kill",
    // ESPN gives the percentage, not the kills behind it, so it is weighted
    // by games played instead.
    num: (p) => v(p.own, "defensive.pkGames"),
    den: (p) => v(p.own, "general.games"),
    k: 25,
    fmt: "pct",
    good: "high",
  },
  {
    key: "pim",
    label: "Penalty minutes per game",
    num: (p) => v(p.own, "penalties.penaltyMinutes"),
    den: (p) => v(p.own, "general.games"),
    k: 10,
    fmt: 1,
    good: "low",
  },
];

// ------------------------------------------------------------------ MLB

const MLB: Spec[] = [
  {
    key: "errors",
    label: "Errors per game",
    num: (p) => v(p.own, "fielding.errors"),
    den: (p) => v(p.own, "fielding.gamesPlayed"),
    k: 40,
    fmt: 2,
    good: "low",
  },
  {
    key: "ops",
    label: "Team OPS",
    num: (p) => {
      const ab = v(p.own, "batting.atBats");
      const h = v(p.own, "batting.hits");
      const bb = v(p.own, "batting.walks");
      const tb = v(p.own, "batting.totalBases");
      if (ab <= 0) return 0;
      return ((h + bb) / (ab + bb) + tb / ab) * ab;
    },
    den: (p) => v(p.own, "batting.atBats"),
    k: 1500,
    fmt: 3,
    good: "high",
  },
  {
    key: "era",
    label: "Team ERA",
    num: (p) => 9 * v(p.own, "pitching.earnedRuns"),
    den: (p) => v(p.own, "pitching.outs") / 3,
    k: 300,
    fmt: 2,
    good: "low",
  },
];

const SPECS: Record<SimLeague, Spec[]> = { nfl: NFL, cfb: CFB, nba: NBA, nhl: NHL, mlb: MLB };

/** Tendencies for every team in the league. */
export function tendencies(
  league: SimLeague,
  pool: Map<string, Pooled>,
): Map<string, Record<string, Tendency>> {
  return build(SPECS[league], pool);
}
