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
 *     of clearing each common line.
 */

import { MLB, NBA, NHL } from "./columns";
import { seedFor } from "./core";
import { boxPlayers, PROPS, type BoxPlayer, type PropDef } from "./props";
import type { GameResult, SimMatchup, Side } from "./types";

/** Integer histogram: value → count. */
export type Hist = Record<number, number>;

export interface PropSummary {
  key: string;
  mean: number;
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
  /** Seeds worth replaying: a typical game, the biggest upset, a thriller. */
  featured: { label: string; seed: number; home: number; away: number }[];
  baseSeed: number;
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

/** Accumulates games one at a time; `summary()` can be called at any point. */
export class Accumulator {
  private n = 0;
  private homeWins = 0;
  private awayWins = 0;
  private ties = 0;
  private ot = 0;
  private so = 0;
  private sumH = 0;
  private sumA = 0;
  private margin: Hist = {};
  private total: Hist = {};
  private hs: Hist = {};
  private as: Hist = {};
  private exact = new Map<string, number>();
  private teamSum = { home: {} as Record<string, number>, away: {} as Record<string, number> };
  private readonly roster: { side: Side; p: BoxPlayer; props: PropDef[] }[];
  /** Per roster entry: games played, and per prop a histogram. */
  private readonly played: number[];
  private readonly hists: Hist[][];
  private typical: { seed: number; home: number; away: number; dist: number } | null = null;
  private upset: { seed: number; home: number; away: number; by: number } | null = null;
  private thriller: { seed: number; home: number; away: number; score: number } | null = null;
  private favourite: Side | null = null;
  private expMargin = 0;

  constructor(
    private m: SimMatchup,
    readonly baseSeed: number,
  ) {
    const defs = PROPS[m.league];
    this.roster = (["home", "away"] as const).flatMap((side) =>
      boxPlayers(m, side).map((p) => ({
        side,
        p,
        props: defs.filter((d) => d.groups.includes(p.group) && (!d.pos || d.pos.includes(p.pos))),
      })),
    );
    this.played = this.roster.map(() => 0);
    this.hists = this.roster.map((r) => r.props.map(() => ({})));
    // Who the market (or failing that the season) has as the favourite, so an
    // "upset" means something.
    const sp = m.ctx.line?.spread;
    this.expMargin = sp != null ? -sp : m.home.pf - m.home.pa - (m.away.pf - m.away.pa);
    this.favourite = this.expMargin >= 0 ? "home" : "away";
  }

  add(r: GameResult, seed: number) {
    this.n++;
    if (r.home > r.away) this.homeWins++;
    else if (r.away > r.home) this.awayWins++;
    else this.ties++;
    if (r.ot) this.ot++;
    if (r.so) this.so++;
    this.sumH += r.home;
    this.sumA += r.away;
    inc(this.margin, r.home - r.away);
    inc(this.total, r.home + r.away);
    inc(this.hs, r.home);
    inc(this.as, r.away);
    const key = `${r.home}-${r.away}`;
    this.exact.set(key, (this.exact.get(key) ?? 0) + 1);
    for (const side of ["home", "away"] as const)
      for (const [k, v] of Object.entries(r.team[side]))
        this.teamSum[side][k] = (this.teamSum[side][k] ?? 0) + v;

    for (let i = 0; i < this.roster.length; i++) {
      const { side, p, props } = this.roster[i];
      const row = r.box[side][p.idx];
      if (!row || !appeared(this.m.league, p.group, row)) continue;
      this.played[i]++;
      const hs = this.hists[i];
      for (let k = 0; k < props.length; k++) inc(hs[k], props[k].get(row));
    }

    // Featured games.
    const margin = r.home - r.away;
    const dist = Math.abs(margin - this.expMargin);
    if (!this.typical || dist < this.typical.dist)
      this.typical = { seed, home: r.home, away: r.away, dist };
    const dogWonBy = this.favourite === "home" ? -margin : margin;
    if (dogWonBy > 0 && (!this.upset || dogWonBy > this.upset.by))
      this.upset = { seed, home: r.home, away: r.away, by: dogWonBy };
    const excitement = (r.ot ? 100 : 0) + (r.home + r.away) - 5 * Math.abs(margin);
    if (!this.thriller || excitement > this.thriller.score)
      this.thriller = { seed, home: r.home, away: r.away, score: excitement };
  }

  summary(ms: number): MassResult {
    const n = Math.max(1, this.n);
    const line = this.m.ctx.line;
    let lineOut: MassResult["line"] = null;
    if (line && (line.spread != null || line.total != null)) {
      let cover = 0;
      let push = 0;
      let over = 0;
      let under = 0;
      let tpush = 0;
      if (line.spread != null)
        for (const [k, v] of Object.entries(this.margin)) {
          const adj = Number(k) + line.spread;
          if (adj > 0) cover += v;
          else if (adj === 0) push += v;
        }
      if (line.total != null)
        for (const [k, v] of Object.entries(this.total)) {
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
        const games = this.played[i];
        const props: PropSummary[] = r.props
          .map((d, k) => {
            const h = { ...this.hists[i][k] };
            // Games he didn't play count as zeros: the projection is for the
            // game, not conditional on him appearing.
            const zeros = this.n - games;
            if (zeros > 0) inc(h, 0, zeros);
            let sum = 0;
            for (const [v, c] of Object.entries(h)) sum += Number(v) * c;
            return {
              key: d.key,
              mean: sum / n,
              median: quantile(h, n, 0.5),
              p10: quantile(h, n, 0.1),
              p90: quantile(h, n, 0.9),
              over: d.lines.map((l) => overProb(h, n, l)),
              hist: h,
            };
          })
          .filter((s, k) => s.mean >= (r.props[k].minMean ?? 0));
        return { ...r.p, side: r.side, played: games / n, props };
      })
      .filter((p) => p.played > 0.02 && p.props.length > 0);
    const team = { home: {} as Record<string, number>, away: {} as Record<string, number> };
    for (const side of ["home", "away"] as const)
      for (const [k, v] of Object.entries(this.teamSum[side])) team[side][k] = v / n;
    const featured: MassResult["featured"] = [];
    if (this.typical) featured.push({ label: "Most typical result", ...pick(this.typical) });
    if (this.upset) featured.push({ label: "Biggest upset", ...pick(this.upset) });
    if (this.thriller) featured.push({ label: "Wildest game", ...pick(this.thriller) });
    return {
      n: this.n,
      homeWins: this.homeWins / n,
      awayWins: this.awayWins / n,
      ties: this.ties / n,
      ot: this.ot / n,
      so: this.so / n,
      avgHome: this.sumH / n,
      avgAway: this.sumA / n,
      margin: this.margin,
      total: this.total,
      homeScore: this.hs,
      awayScore: this.as,
      topScores: [...this.exact.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, count]) => {
          const [home, away] = k.split("-").map(Number);
          return { home, away, count: count / n };
        }),
      line: lineOut,
      team,
      players,
      featured,
      baseSeed: this.baseSeed,
      ms,
    };
  }
}

const pick = (x: { seed: number; home: number; away: number }) => ({
  seed: x.seed,
  home: x.home,
  away: x.away,
});

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
      return row.some((v) => v !== 0);
  }
}

/** Seeds for a batch, so game i of batch `base` can be replayed alone. */
export const batchSeed = seedFor;
