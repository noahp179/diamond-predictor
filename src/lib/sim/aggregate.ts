/**
 * aggregate.ts — turning thousands of simulated games into answers.
 *
 * Every game's final score and every player's box-score row is folded into
 * histograms as it finishes, so memory does not grow with the number of games
 * and a batch can be stopped part-way and still summarised. From those:
 *
 *   - who wins, how often, by how much, and how often it goes to overtime;
 *   - the full distribution of margins and totals, and so the chance of
 *     covering the posted spread and going over the posted total;
 *   - for every player who saw the field, the distribution of each stat —
 *     mean, median, the 10th-to-90th percentile range, and the probability
 *     of clearing each common line — and his average box-score line.
 *
 * The running totals are a plain object (`AccState`) so a batch can be split
 * across several workers and the pieces added back together: the counts and
 * histograms of two halves sum to those of the whole.
 */

import { MLB, NBA, NHL } from "./columns";
import { boxPlayers, PROPS, type BoxPlayer, type PropDef } from "./props";
import type { GameResult, SimMatchup, Side } from "./types";

/** Integer histogram: value → count. */
export type Hist = Record<number, number>;

export interface PropSummary {
  key: string;
  mean: number;
  /** Standard deviation across games (not of the mean). */
  sd: number;
  median: number;
  p10: number;
  p90: number;
  /** P(value ≥ line), same order as the prop's lines. */
  over: number[];
  hist: Hist;
}

export interface PlayerSummary extends BoxPlayer {
  side: Side;
  /** Share of games in which he recorded any playing time. */
  played: number;
  props: PropSummary[];
  /** His box-score row averaged over every game (zeros when he sat). */
  avgBox: number[];
}

export interface MassResult {
  n: number;
  homeWins: number;
  awayWins: number;
  ties: number;
  ot: number;
  so: number;
  avgHome: number;
  avgAway: number;
  /** Game-to-game standard deviations, for the Monte Carlo error. */
  sd: { home: number; away: number; margin: number; total: number };
  margin: Hist; // home − away
  total: Hist;
  homeScore: Hist;
  awayScore: Hist;
  /** Most frequent exact final scores. */
  topScores: { home: number; away: number; count: number }[];
  /** Against the posted line, when there is one. */
  line: {
    spread: number | null;
    total: number | null;
    homeCover: number;
    push: number;
    over: number;
    under: number;
    totalPush: number;
  } | null;
  /** Team-level extras, averaged (shots, yards, hits…). */
  team: { home: Record<string, number>; away: Record<string, number> };
  players: PlayerSummary[];
  ms: number;
}

const inc = (h: Hist, v: number, by = 1) => {
  h[v] = (h[v] ?? 0) + by;
};

function quantile(h: Hist, n: number, q: number): number {
  const keys = Object.keys(h)
    .map(Number)
    .sort((a, b) => a - b);
  const target = q * n;
  let acc = 0;
  for (const k of keys) {
    acc += h[k];
    if (acc >= target) return k;
  }
  return keys[keys.length - 1] ?? 0;
}

function overProb(h: Hist, n: number, line: number): number {
  let c = 0;
  for (const [k, v] of Object.entries(h)) if (Number(k) >= line) c += v;
  return c / n;
}

/** Everything a batch has counted so far. Plain data: it crosses a worker
 *  boundary by structured clone, and two of them add. */
export interface AccState {
  n: number;
  homeWins: number;
  awayWins: number;
  ties: number;
  ot: number;
  so: number;
  sumH: number;
  sumA: number;
  margin: Hist;
  total: Hist;
  hs: Hist;
  as: Hist;
  exact: Record<string, number>;
  teamSum: { home: Record<string, number>; away: Record<string, number> };
  /** Per roster entry: games played, a histogram per prop, box-row sums. */
  played: number[];
  hists: Hist[][];
  box: number[][];
}

const addHist = (into: Hist, from: Hist) => {
  for (const [k, v] of Object.entries(from)) inc(into, Number(k), v);
};

function sdOf(h: Hist, n: number): number {
  if (n < 2) return 0;
  let s = 0;
  let s2 = 0;
  for (const [k, c] of Object.entries(h)) {
    const v = Number(k);
    s += v * c;
    s2 += v * v * c;
  }
  const mean = s / n;
  return Math.sqrt(Math.max(0, s2 / n - mean * mean));
}

/** Accumulates games one at a time; `summary()` can be called at any point. */
export class Accumulator {
  readonly st: AccState;
  private readonly roster: { side: Side; p: BoxPlayer; props: PropDef[] }[];

  constructor(private m: SimMatchup) {
    const defs = PROPS[m.league];
    this.roster = (["home", "away"] as const).flatMap((side) =>
      boxPlayers(m, side).map((p) => ({
        side,
        p,
        props: defs.filter((d) => d.groups.includes(p.group) && (!d.pos || d.pos.includes(p.pos))),
      })),
    );
    this.st = {
      n: 0,
      homeWins: 0,
      awayWins: 0,
      ties: 0,
      ot: 0,
      so: 0,
      sumH: 0,
      sumA: 0,
      margin: {},
      total: {},
      hs: {},
      as: {},
      exact: {},
      teamSum: { home: {}, away: {} },
      played: this.roster.map(() => 0),
      hists: this.roster.map((r) => r.props.map(() => ({}))),
      box: this.roster.map(() => []),
    };
  }

  add(r: GameResult) {
    const st = this.st;
    st.n++;
    if (r.home > r.away) st.homeWins++;
    else if (r.away > r.home) st.awayWins++;
    else st.ties++;
    if (r.ot) st.ot++;
    if (r.so) st.so++;
    st.sumH += r.home;
    st.sumA += r.away;
    inc(st.margin, r.home - r.away);
    inc(st.total, r.home + r.away);
    inc(st.hs, r.home);
    inc(st.as, r.away);
    const key = `${r.home}-${r.away}`;
    st.exact[key] = (st.exact[key] ?? 0) + 1;
    for (const side of ["home", "away"] as const)
      for (const [k, v] of Object.entries(r.team[side]))
        st.teamSum[side][k] = (st.teamSum[side][k] ?? 0) + v;

    for (let i = 0; i < this.roster.length; i++) {
      const { side, p, props } = this.roster[i];
      const row = r.box[side][p.idx];
      if (!row || !appeared(this.m.league, p.group, row)) continue;
      st.played[i]++;
      const hs = st.hists[i];
      for (let k = 0; k < props.length; k++) inc(hs[k], props[k].get(row));
      const sum = st.box[i];
      for (let c = 0; c < row.length; c++) sum[c] = (sum[c] ?? 0) + row[c];
    }
  }

  /** Fold in another accumulator's totals for the same matchup. */
  merge(o: AccState) {
    const st = this.st;
    st.n += o.n;
    st.homeWins += o.homeWins;
    st.awayWins += o.awayWins;
    st.ties += o.ties;
    st.ot += o.ot;
    st.so += o.so;
    st.sumH += o.sumH;
    st.sumA += o.sumA;
    addHist(st.margin, o.margin);
    addHist(st.total, o.total);
    addHist(st.hs, o.hs);
    addHist(st.as, o.as);
    for (const [k, v] of Object.entries(o.exact)) st.exact[k] = (st.exact[k] ?? 0) + v;
    for (const side of ["home", "away"] as const)
      for (const [k, v] of Object.entries(o.teamSum[side]))
        st.teamSum[side][k] = (st.teamSum[side][k] ?? 0) + v;
    for (let i = 0; i < st.played.length; i++) {
      st.played[i] += o.played[i] ?? 0;
      o.hists[i]?.forEach((h, k) => addHist(st.hists[i][k], h));
      o.box[i]?.forEach((v, c) => (st.box[i][c] = (st.box[i][c] ?? 0) + v));
    }
  }

  summary(ms: number): MassResult {
    const st = this.st;
    const n = Math.max(1, st.n);
    const line = this.m.ctx.line;
    let lineOut: MassResult["line"] = null;
    if (line && (line.spread != null || line.total != null)) {
      let cover = 0;
      let push = 0;
      let over = 0;
      let under = 0;
      let tpush = 0;
      if (line.spread != null)
        for (const [k, v] of Object.entries(st.margin)) {
          const adj = Number(k) + line.spread;
          if (adj > 0) cover += v;
          else if (adj === 0) push += v;
        }
      if (line.total != null)
        for (const [k, v] of Object.entries(st.total)) {
          if (Number(k) > line.total) over += v;
          else if (Number(k) < line.total) under += v;
          else tpush += v;
        }
      lineOut = {
        spread: line.spread,
        total: line.total,
        homeCover: cover / n,
        push: push / n,
        over: over / n,
        under: under / n,
        totalPush: tpush / n,
      };
    }
    const players: PlayerSummary[] = this.roster
      .map((r, i) => {
        const games = st.played[i];
        const props: PropSummary[] = r.props
          .map((d, k) => {
            const h = { ...st.hists[i][k] };
            // Games he didn't play count as zeros: the projection is for the
            // game, not conditional on him appearing.
            const zeros = st.n - games;
            if (zeros > 0) inc(h, 0, zeros);
            let sum = 0;
            for (const [v, c] of Object.entries(h)) sum += Number(v) * c;
            return {
              key: d.key,
              mean: sum / n,
              sd: sdOf(h, n),
              median: quantile(h, n, 0.5),
              p10: quantile(h, n, 0.1),
              p90: quantile(h, n, 0.9),
              over: d.lines.map((l) => overProb(h, n, l)),
              hist: h,
            };
          })
          .filter((s, k) => s.mean >= (r.props[k].minMean ?? 0));
        const avgBox = Array.from(st.box[i], (v) => (v ?? 0) / n);
        return { ...r.p, side: r.side, played: games / n, props, avgBox };
      })
      // Players with no projected stat (a punter, a little-used defender)
      // still belong in the average box score.
      .filter((p) => p.played > 0.02);
    const team = { home: {} as Record<string, number>, away: {} as Record<string, number> };
    for (const side of ["home", "away"] as const)
      for (const [k, v] of Object.entries(st.teamSum[side])) team[side][k] = v / n;
    return {
      n: st.n,
      homeWins: st.homeWins / n,
      awayWins: st.awayWins / n,
      ties: st.ties / n,
      ot: st.ot / n,
      so: st.so / n,
      avgHome: st.sumH / n,
      avgAway: st.sumA / n,
      sd: {
        home: sdOf(st.hs, n),
        away: sdOf(st.as, n),
        margin: sdOf(st.margin, n),
        total: sdOf(st.total, n),
      },
      margin: st.margin,
      total: st.total,
      homeScore: st.hs,
      awayScore: st.as,
      topScores: Object.entries(st.exact)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, count]) => {
          const [home, away] = k.split("-").map(Number);
          return { home, away, count: count / n };
        }),
      line: lineOut,
      team,
      players,
      ms,
    };
  }
}

/** Did this player get on the field? */
function appeared(league: SimMatchup["league"], group: string, row: number[]): boolean {
  switch (league) {
    case "nba":
      return row[NBA.SEC] > 0;
    case "nhl":
      return row[NHL.SEC] > 0;
    case "mlb":
      return group === "pitcher" ? row[MLB.APP] > 0 : row[MLB.PA] > 0;
    case "nfl":
    case "cfb":
      return row.some((v) => v !== 0);
  }
}
