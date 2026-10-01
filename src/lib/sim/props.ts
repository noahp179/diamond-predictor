/**
 * props.ts — what the simulator reports about each player.
 *
 * Two tables per league, both reading the engines' box-score rows:
 *
 *   box columns   what a box score shows, grouped the way a broadcast groups
 *                 them (passing / rushing / receiving, batters / pitchers…)
 *   projections   the stats a batch of games is summarised by — mean, median,
 *                 range, and the chance of clearing each common line
 *
 * The lines are the ones books post most often. Nothing here is a price: the
 * probabilities are the simulation's own, and the page says so.
 */

import { MLB, NBA, NFL, NHL } from "./columns";
import type { SimLeague, SimMatchup, Side } from "./types";

export type Group =
  | "player"
  | "skater"
  | "goalie"
  | "batter"
  | "pitcher"
  | "qb"
  | "skill"
  | "kicker"
  | "punter"
  | "def";

export interface BoxPlayer {
  /** Row index in the engine's box score for this side. */
  idx: number;
  id: string;
  name: string;
  short: string;
  pos: string;
  jersey: string;
  group: Group;
}

export function boxPlayers(m: SimMatchup, side: Side): BoxPlayer[] {
  const base = (p: { id: string; name: string; short: string; pos: string; jersey: string }) => ({
    id: p.id,
    name: p.name,
    short: p.short,
    pos: p.pos,
    jersey: p.jersey,
  });
  switch (m.league) {
    case "nba":
      return m[side].players.map((p, idx) => ({ ...base(p), idx, group: "player" }));
    case "nhl": {
      const t = m[side];
      return [
        ...t.skaters.map((p, idx) => ({ ...base(p), idx, group: "skater" as const })),
        ...t.goalies.map((p, k) => ({
          ...base(p),
          idx: t.skaters.length + k,
          group: "goalie" as const,
        })),
      ];
    }
    case "mlb": {
      const t = m[side];
      return [
        ...t.batters.map((p, idx) => ({ ...base(p), idx, group: "batter" as const })),
        ...t.pitchers.map((p, k) => ({
          ...base(p),
          idx: t.batters.length + k,
          group: "pitcher" as const,
        })),
      ];
    }
    case "nfl":
      return m[side].players.map((p, idx) => {
        let group: Group = "def";
        if (p.pos === "QB") group = "qb";
        else if (p.pos === "PK" || p.pos === "K") group = "kicker";
        else if (p.pos === "P") group = "punter";
        else if (p.unit !== "def") group = "skill";
        return { ...base(p), idx, group };
      });
  }
}

// ------------------------------------------------------------ box columns

export interface BoxColumn {
  label: string;
  title?: string;
  get: (r: number[]) => number;
  fmt?: (v: number, r: number[]) => string;
}

export interface BoxSection {
  title: string;
  groups: Group[];
  /** Only rows where this returns true are shown. */
  show: (r: number[]) => boolean;
  sort: (r: number[]) => number;
  cols: BoxColumn[];
}

const mmss = (sec: number) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const ip = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;

export const BOX: Record<SimLeague, BoxSection[]> = {
  nba: [
    {
      title: "Players",
      groups: ["player"],
      show: (r) => r[NBA.SEC] > 0,
      sort: (r) => r[NBA.START] * 1e6 + r[NBA.SEC],
      cols: [
        { label: "MIN", get: (r) => r[NBA.SEC], fmt: (v) => String(Math.round(v / 60)) },
        { label: "PTS", get: (r) => r[NBA.PTS] },
        { label: "REB", get: (r) => r[NBA.OREB] + r[NBA.DREB] },
        { label: "AST", get: (r) => r[NBA.AST] },
        { label: "FG", get: (r) => r[NBA.FGM], fmt: (_, r) => `${r[NBA.FGM]}-${r[NBA.FGA]}` },
        { label: "3PT", get: (r) => r[NBA.TPM], fmt: (_, r) => `${r[NBA.TPM]}-${r[NBA.TPA]}` },
        { label: "FT", get: (r) => r[NBA.FTM], fmt: (_, r) => `${r[NBA.FTM]}-${r[NBA.FTA]}` },
        { label: "OREB", get: (r) => r[NBA.OREB] },
        { label: "STL", get: (r) => r[NBA.STL] },
        { label: "BLK", get: (r) => r[NBA.BLK] },
        { label: "TO", get: (r) => r[NBA.TOV] },
        { label: "PF", get: (r) => r[NBA.PF] },
        { label: "+/-", get: (r) => r[NBA.PM], fmt: (v) => (v > 0 ? `+${v}` : String(v)) },
      ],
    },
  ],
  nhl: [
    {
      title: "Skaters",
      groups: ["skater"],
      show: (r) => r[NHL.SEC] > 0,
      sort: (r) => r[NHL.G] * 1e5 + (r[NHL.G] + r[NHL.A]) * 1e4 + r[NHL.SEC],
      cols: [
        { label: "G", get: (r) => r[NHL.G] },
        { label: "A", get: (r) => r[NHL.A] },
        { label: "PTS", get: (r) => r[NHL.G] + r[NHL.A] },
        { label: "SOG", get: (r) => r[NHL.SOG] },
        { label: "+/-", get: (r) => r[NHL.PM], fmt: (v) => (v > 0 ? `+${v}` : String(v)) },
        { label: "PIM", get: (r) => r[NHL.PIM] },
        { label: "PPP", get: (r) => r[NHL.PPP] },
        {
          label: "FO",
          get: (r) => r[NHL.FOW],
          fmt: (_, r) => (r[NHL.FOW] + r[NHL.FOL] ? `${r[NHL.FOW]}-${r[NHL.FOL]}` : "—"),
        },
        { label: "TOI", get: (r) => r[NHL.SEC], fmt: (v) => mmss(v) },
      ],
    },
    {
      title: "Goalies",
      groups: ["goalie"],
      show: (r) => r[NHL.SEC] > 0,
      sort: (r) => r[NHL.SEC],
      cols: [
        { label: "SA", get: (r) => r[NHL.SA] },
        { label: "SV", get: (r) => r[NHL.SA] - r[NHL.GA] },
        { label: "GA", get: (r) => r[NHL.GA] },
        {
          label: "SV%",
          get: (r) => (r[NHL.SA] ? (r[NHL.SA] - r[NHL.GA]) / r[NHL.SA] : 0),
          fmt: (v) => v.toFixed(3).replace(/^0/, ""),
        },
        { label: "DEC", get: (r) => r[NHL.DEC], fmt: (v) => ["", "W", "L", "OTL"][v] ?? "" },
        { label: "TOI", get: (r) => r[NHL.SEC], fmt: (v) => mmss(v) },
      ],
    },
  ],
  mlb: [
    {
      title: "Batting",
      groups: ["batter"],
      show: (r) => r[MLB.PA] > 0,
      sort: (r) => (r[MLB.ORDER] ? 100 - r[MLB.ORDER] : 0),
      cols: [
        { label: "AB", get: (r) => r[MLB.AB] },
        { label: "R", get: (r) => r[MLB.R] },
        { label: "H", get: (r) => r[MLB.H] },
        { label: "2B", get: (r) => r[MLB.D2] },
        { label: "3B", get: (r) => r[MLB.D3] },
        { label: "HR", get: (r) => r[MLB.HR] },
        { label: "RBI", get: (r) => r[MLB.RBI] },
        { label: "BB", get: (r) => r[MLB.BB] },
        { label: "SO", get: (r) => r[MLB.SO] },
        { label: "SB", get: (r) => r[MLB.SB] },
      ],
    },
    {
      title: "Pitching",
      groups: ["pitcher"],
      show: (r) => r[MLB.APP] > 0,
      sort: (r) => 100 - r[MLB.APP],
      cols: [
        { label: "IP", get: (r) => r[MLB.OUTS], fmt: (v) => ip(v) },
        { label: "H", get: (r) => r[MLB.PH] },
        { label: "R", get: (r) => r[MLB.PR] },
        { label: "ER", get: (r) => r[MLB.PER] },
        { label: "BB", get: (r) => r[MLB.PBB] },
        { label: "K", get: (r) => r[MLB.PSO] },
        { label: "HR", get: (r) => r[MLB.PHR] },
        { label: "PC", get: (r) => r[MLB.NP] },
        { label: "DEC", get: (r) => r[MLB.DEC], fmt: (v) => ["", "W", "L", "S", "H"][v] ?? "" },
      ],
    },
  ],
  nfl: [
    {
      title: "Passing",
      groups: ["qb", "skill"],
      show: (r) => r[NFL.ATT] > 0 || r[NFL.SK] > 0,
      sort: (r) => r[NFL.ATT],
      cols: [
        { label: "C/ATT", get: (r) => r[NFL.CMP], fmt: (_, r) => `${r[NFL.CMP]}/${r[NFL.ATT]}` },
        { label: "YDS", get: (r) => r[NFL.PYD] },
        { label: "TD", get: (r) => r[NFL.PTD] },
        { label: "INT", get: (r) => r[NFL.INT] },
        { label: "SACKS", get: (r) => r[NFL.SK], fmt: (_, r) => `${r[NFL.SK]}-${r[NFL.SKY]}` },
      ],
    },
    {
      title: "Rushing",
      groups: ["qb", "skill"],
      show: (r) => r[NFL.CAR] > 0,
      sort: (r) => r[NFL.CAR] * 1000 + r[NFL.RYD],
      cols: [
        { label: "CAR", get: (r) => r[NFL.CAR] },
        { label: "YDS", get: (r) => r[NFL.RYD] },
        {
          label: "AVG",
          get: (r) => (r[NFL.CAR] ? r[NFL.RYD] / r[NFL.CAR] : 0),
          fmt: (v) => v.toFixed(1),
        },
        { label: "TD", get: (r) => r[NFL.RTD] },
        { label: "LONG", get: (r) => r[NFL.RLNG] },
      ],
    },
    {
      title: "Receiving",
      groups: ["skill", "qb"],
      show: (r) => r[NFL.TGT] > 0,
      sort: (r) => r[NFL.REYD] * 100 + r[NFL.REC],
      cols: [
        { label: "REC", get: (r) => r[NFL.REC] },
        { label: "TGT", get: (r) => r[NFL.TGT] },
        { label: "YDS", get: (r) => r[NFL.REYD] },
        {
          label: "AVG",
          get: (r) => (r[NFL.REC] ? r[NFL.REYD] / r[NFL.REC] : 0),
          fmt: (v) => v.toFixed(1),
        },
        { label: "TD", get: (r) => r[NFL.RETD] },
        { label: "LONG", get: (r) => r[NFL.RELNG] },
      ],
    },
    {
      title: "Kicking",
      groups: ["kicker", "punter"],
      show: (r) => r[NFL.FGA] + r[NFL.XPA] + r[NFL.PUNT] > 0,
      sort: (r) => r[NFL.FGA] * 10 + r[NFL.XPA],
      cols: [
        {
          label: "FG",
          get: (r) => r[NFL.FGM],
          fmt: (_, r) => (r[NFL.FGA] ? `${r[NFL.FGM]}/${r[NFL.FGA]}` : "—"),
        },
        { label: "LONG", get: (r) => r[NFL.FGLNG], fmt: (v) => (v ? String(v) : "—") },
        {
          label: "XP",
          get: (r) => r[NFL.XPM],
          fmt: (_, r) => (r[NFL.XPA] ? `${r[NFL.XPM]}/${r[NFL.XPA]}` : "—"),
        },
        { label: "PTS", get: (r) => 3 * r[NFL.FGM] + r[NFL.XPM] },
        {
          label: "PUNTS",
          get: (r) => r[NFL.PUNT],
          fmt: (_, r) =>
            r[NFL.PUNT] ? `${r[NFL.PUNT]} · ${(r[NFL.PNYD] / r[NFL.PUNT]).toFixed(1)} net` : "—",
        },
      ],
    },
    {
      title: "Defense",
      groups: ["def"],
      show: (r) => r[NFL.TKL] + r[NFL.DSK] + r[NFL.DINT] > 0,
      sort: (r) => r[NFL.DSK] * 100 + r[NFL.DINT] * 100 + r[NFL.TKL],
      cols: [
        { label: "TKL", get: (r) => r[NFL.TKL] },
        { label: "SACK", get: (r) => r[NFL.DSK] },
        { label: "INT", get: (r) => r[NFL.DINT] },
        { label: "TD", get: (r) => r[NFL.DTD] },
      ],
    },
  ],
};

// ------------------------------------------------------------ projections

export interface PropDef {
  key: string;
  label: string;
  groups: Group[];
  get: (r: number[]) => number;
  /** "k+" lines to price. */
  lines: number[];
  /** Positions this prop is shown for (NFL distinguishes RB from WR). */
  pos?: string[];
  /** Hide for players whose mean is below this — nobody needs an
   *  offensive lineman's receiving yards. */
  minMean?: number;
}

export const PROPS: Record<SimLeague, PropDef[]> = {
  nba: [
    {
      key: "pts",
      label: "Points",
      groups: ["player"],
      get: (r) => r[NBA.PTS],
      lines: [10, 15, 20, 25, 30, 35, 40],
      minMean: 2,
    },
    {
      key: "reb",
      label: "Rebounds",
      groups: ["player"],
      get: (r) => r[NBA.OREB] + r[NBA.DREB],
      lines: [4, 6, 8, 10, 12, 15],
      minMean: 1,
    },
    {
      key: "ast",
      label: "Assists",
      groups: ["player"],
      get: (r) => r[NBA.AST],
      lines: [2, 4, 6, 8, 10, 12],
      minMean: 0.8,
    },
    {
      key: "pra",
      label: "Pts+Reb+Ast",
      groups: ["player"],
      get: (r) => r[NBA.PTS] + r[NBA.OREB] + r[NBA.DREB] + r[NBA.AST],
      lines: [15, 20, 25, 30, 35, 40, 45, 50],
      minMean: 4,
    },
    {
      key: "3pm",
      label: "Threes made",
      groups: ["player"],
      get: (r) => r[NBA.TPM],
      lines: [1, 2, 3, 4, 5, 6],
      minMean: 0.3,
    },
    {
      key: "stl",
      label: "Steals",
      groups: ["player"],
      get: (r) => r[NBA.STL],
      lines: [1, 2, 3],
      minMean: 0.2,
    },
    {
      key: "blk",
      label: "Blocks",
      groups: ["player"],
      get: (r) => r[NBA.BLK],
      lines: [1, 2, 3],
      minMean: 0.2,
    },
    {
      key: "tov",
      label: "Turnovers",
      groups: ["player"],
      get: (r) => r[NBA.TOV],
      lines: [1, 2, 3, 4, 5],
      minMean: 0.3,
    },
    {
      key: "min",
      label: "Minutes",
      groups: ["player"],
      get: (r) => Math.round(r[NBA.SEC] / 60),
      lines: [20, 25, 30, 35, 40],
      minMean: 4,
    },
  ],
  nhl: [
    {
      key: "g",
      label: "Goals",
      groups: ["skater"],
      get: (r) => r[NHL.G],
      lines: [1, 2, 3],
      minMean: 0.02,
    },
    {
      key: "a",
      label: "Assists",
      groups: ["skater"],
      get: (r) => r[NHL.A],
      lines: [1, 2, 3],
      minMean: 0.02,
    },
    {
      key: "pts",
      label: "Points",
      groups: ["skater"],
      get: (r) => r[NHL.G] + r[NHL.A],
      lines: [1, 2, 3, 4],
      minMean: 0.05,
    },
    {
      key: "sog",
      label: "Shots on goal",
      groups: ["skater"],
      get: (r) => r[NHL.SOG],
      lines: [1, 2, 3, 4, 5, 6],
      minMean: 0.3,
    },
    {
      key: "ppp",
      label: "Power-play points",
      groups: ["skater"],
      get: (r) => r[NHL.PPP],
      lines: [1, 2],
      minMean: 0.05,
    },
    {
      key: "toi",
      label: "Time on ice (min)",
      groups: ["skater"],
      get: (r) => Math.round(r[NHL.SEC] / 60),
      lines: [15, 18, 20, 22, 25],
      minMean: 3,
    },
    {
      key: "sv",
      label: "Saves",
      groups: ["goalie"],
      get: (r) => r[NHL.SA] - r[NHL.GA],
      lines: [20, 25, 28, 30, 35],
      minMean: 5,
    },
    {
      key: "ga",
      label: "Goals against",
      groups: ["goalie"],
      get: (r) => r[NHL.GA],
      lines: [1, 2, 3, 4, 5],
      minMean: 0.5,
    },
  ],
  mlb: [
    {
      key: "h",
      label: "Hits",
      groups: ["batter"],
      get: (r) => r[MLB.H],
      lines: [1, 2, 3],
      minMean: 0.2,
    },
    {
      key: "tb",
      label: "Total bases",
      groups: ["batter"],
      get: (r) => r[MLB.H] + r[MLB.D2] + 2 * r[MLB.D3] + 3 * r[MLB.HR],
      lines: [1, 2, 3, 4],
      minMean: 0.3,
    },
    {
      key: "hr",
      label: "Home runs",
      groups: ["batter"],
      get: (r) => r[MLB.HR],
      lines: [1, 2],
      minMean: 0.02,
    },
    {
      key: "r",
      label: "Runs",
      groups: ["batter"],
      get: (r) => r[MLB.R],
      lines: [1, 2],
      minMean: 0.1,
    },
    {
      key: "rbi",
      label: "RBI",
      groups: ["batter"],
      get: (r) => r[MLB.RBI],
      lines: [1, 2, 3],
      minMean: 0.1,
    },
    {
      key: "hrr",
      label: "Hits+Runs+RBI",
      groups: ["batter"],
      get: (r) => r[MLB.H] + r[MLB.R] + r[MLB.RBI],
      lines: [1, 2, 3, 4, 5],
      minMean: 0.3,
    },
    {
      key: "bb",
      label: "Walks",
      groups: ["batter"],
      get: (r) => r[MLB.BB],
      lines: [1, 2],
      minMean: 0.1,
    },
    {
      key: "so",
      label: "Strikeouts (batter)",
      groups: ["batter"],
      get: (r) => r[MLB.SO],
      lines: [1, 2, 3],
      minMean: 0.2,
    },
    {
      key: "sb",
      label: "Stolen bases",
      groups: ["batter"],
      get: (r) => r[MLB.SB],
      lines: [1, 2],
      minMean: 0.03,
    },
    {
      key: "k",
      label: "Strikeouts (pitcher)",
      groups: ["pitcher"],
      get: (r) => r[MLB.PSO],
      lines: [3, 4, 5, 6, 7, 8, 9, 10],
      minMean: 0.5,
    },
    {
      key: "outs",
      label: "Outs recorded",
      groups: ["pitcher"],
      get: (r) => r[MLB.OUTS],
      lines: [12, 15, 16, 17, 18, 19, 21],
      minMean: 4,
    },
    {
      key: "ha",
      label: "Hits allowed",
      groups: ["pitcher"],
      get: (r) => r[MLB.PH],
      lines: [3, 4, 5, 6, 7],
      minMean: 1,
    },
    {
      key: "er",
      label: "Earned runs",
      groups: ["pitcher"],
      get: (r) => r[MLB.PER],
      lines: [1, 2, 3, 4],
      minMean: 0.5,
    },
    {
      key: "pbb",
      label: "Walks allowed",
      groups: ["pitcher"],
      get: (r) => r[MLB.PBB],
      lines: [1, 2, 3],
      minMean: 0.3,
    },
    {
      key: "win",
      label: "Pitcher win",
      groups: ["pitcher"],
      get: (r) => (r[MLB.DEC] === 1 ? 1 : 0),
      lines: [1],
      minMean: 0.05,
    },
  ],
  nfl: [
    {
      key: "pyd",
      label: "Passing yards",
      groups: ["qb"],
      get: (r) => r[NFL.PYD],
      lines: [150, 175, 200, 225, 250, 275, 300, 350],
      minMean: 40,
    },
    {
      key: "ptd",
      label: "Passing TDs",
      groups: ["qb"],
      get: (r) => r[NFL.PTD],
      lines: [1, 2, 3, 4],
      minMean: 0.3,
    },
    {
      key: "cmp",
      label: "Completions",
      groups: ["qb"],
      get: (r) => r[NFL.CMP],
      lines: [15, 18, 20, 22, 25, 28],
      minMean: 5,
    },
    {
      key: "int",
      label: "Interceptions thrown",
      groups: ["qb"],
      get: (r) => r[NFL.INT],
      lines: [1, 2],
      minMean: 0.2,
    },
    {
      key: "ryd",
      label: "Rushing yards",
      groups: ["qb", "skill"],
      get: (r) => r[NFL.RYD],
      lines: [10, 25, 40, 50, 60, 75, 100, 125],
      minMean: 8,
    },
    {
      key: "car",
      label: "Carries",
      groups: ["skill"],
      get: (r) => r[NFL.CAR],
      lines: [5, 10, 12, 15, 18, 20],
      minMean: 2,
    },
    {
      key: "rec",
      label: "Receptions",
      groups: ["skill"],
      get: (r) => r[NFL.REC],
      lines: [2, 3, 4, 5, 6, 7, 8],
      minMean: 0.8,
    },
    {
      key: "reyd",
      label: "Receiving yards",
      groups: ["skill"],
      get: (r) => r[NFL.REYD],
      lines: [10, 25, 40, 50, 60, 75, 100, 125],
      minMean: 8,
    },
    {
      key: "rry",
      label: "Rush+Rec yards",
      groups: ["skill"],
      get: (r) => r[NFL.RYD] + r[NFL.REYD],
      lines: [25, 50, 75, 100, 125, 150],
      minMean: 15,
    },
    {
      key: "td",
      label: "Anytime TD",
      groups: ["skill", "qb"],
      get: (r) => r[NFL.RTD] + r[NFL.RETD],
      lines: [1, 2, 3],
      minMean: 0.05,
    },
    {
      key: "fgm",
      label: "Field goals made",
      groups: ["kicker"],
      get: (r) => r[NFL.FGM],
      lines: [1, 2, 3, 4],
      minMean: 0.3,
    },
    {
      key: "kpts",
      label: "Kicking points",
      groups: ["kicker"],
      get: (r) => 3 * r[NFL.FGM] + r[NFL.XPM],
      lines: [4, 5, 6, 7, 8, 9, 10],
      minMean: 2,
    },
    {
      key: "dsk",
      label: "Sacks",
      groups: ["def"],
      get: (r) => r[NFL.DSK],
      lines: [1, 2],
      minMean: 0.12,
    },
    {
      key: "tkl",
      label: "Tackles",
      groups: ["def"],
      get: (r) => r[NFL.TKL],
      lines: [3, 4, 5, 6, 8, 10],
      minMean: 1.5,
    },
    {
      key: "dint",
      label: "Interceptions",
      groups: ["def"],
      get: (r) => r[NFL.DINT],
      lines: [1],
      minMean: 0.04,
    },
  ],
};

/** What to call points in each sport, for headings. */
export const UNITS: Record<
  SimLeague,
  { pts: string; one: string; period: string; periods: string[] }
> = {
  nba: { pts: "points", one: "point", period: "Q", periods: ["1", "2", "3", "4"] },
  nfl: { pts: "points", one: "point", period: "Q", periods: ["1", "2", "3", "4"] },
  nhl: { pts: "goals", one: "goal", period: "P", periods: ["1", "2", "3"] },
  mlb: {
    pts: "runs",
    one: "run",
    period: "",
    periods: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  },
};
