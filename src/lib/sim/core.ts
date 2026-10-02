/**
 * core.ts — the pieces every engine shares: a seeded random source, the box
 * score with its replay deltas, and the play-by-play recorder.
 *
 * Seeded so a game can be replayed exactly: the same matchup, the same
 * overrides and the same seed produce the same game, play for play. That is
 * what makes "watch that one again" and a shareable seed possible, and it is
 * what lets the tests pin an engine's behaviour.
 */

import type { GameResult, PlayEvent, Side, StatDelta } from "./types";

// ------------------------------------------------------------------ RNG

export class Rng {
  private a: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.a = seed >>> 0 || 0x9e3779b9;
  }

  /** mulberry32 — small, fast, and plenty for Monte Carlo at this scale. */
  next(): number {
    let t = (this.a = (this.a + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  uniform(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  normal(mu = 0, sd = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mu + sd * v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mu + sd * r * Math.cos(2 * Math.PI * v);
  }

  /** Gamma(shape, scale) — Marsaglia & Tsang. Mean = shape × scale. */
  gamma(shape: number, scale: number): number {
    if (shape < 1) return this.gamma(shape + 1, scale) * Math.pow(this.next(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** Index drawn in proportion to `w`. Non-positive weights are never picked
   *  unless every weight is, in which case it is uniform. */
  pick(w: ArrayLike<number>, n = w.length): number {
    let total = 0;
    for (let i = 0; i < n; i++) if (w[i] > 0) total += w[i];
    if (total <= 0) return Math.floor(this.next() * n);
    let r = this.next() * total;
    for (let i = 0; i < n; i++) {
      if (w[i] <= 0) continue;
      r -= w[i];
      if (r < 0) return i;
    }
    for (let i = n - 1; i >= 0; i--) if (w[i] > 0) return i;
    return 0;
  }
}

/** A fresh seed for a new game. */
export function newSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}

/** Seeds for game i of a batch: decorrelated, but the batch replays exactly. */
export function seedFor(base: number, i: number): number {
  let h = (base ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ------------------------------------------------------------ box score

export const sideIdx = (s: Side) => (s === "home" ? 0 : 1);
export const other = (s: Side): Side => (s === "home" ? "away" : "home");

/**
 * The box score, plus — when a game is being recorded for replay — the list of
 * changes since the last play was logged. Each logged play carries its changes
 * so the viewer can rebuild the box at any point in the game.
 */
export class Box {
  readonly rows: [number[][], number[][]];
  private pending: StatDelta[] | null;

  constructor(nHome: number, nAway: number, nStats: number, record: boolean) {
    const mk = (n: number) => Array.from({ length: n }, () => new Array<number>(nStats).fill(0));
    this.rows = [mk(nHome), mk(nAway)];
    this.pending = record ? [] : null;
  }

  add(side: number, p: number, stat: number, v = 1) {
    if (p < 0) return;
    this.rows[side][p][stat] += v;
    if (this.pending) this.pending.push([side, p, stat, v]);
  }

  /** Keep the larger of the current value and `v` (longest gain, longest FG). */
  max(side: number, p: number, stat: number, v: number) {
    if (p < 0) return;
    const cur = this.rows[side][p][stat];
    if (v > cur) this.add(side, p, stat, v - cur);
  }

  get(side: number, p: number, stat: number) {
    return this.rows[side][p][stat];
  }

  flush(): StatDelta[] | undefined {
    if (!this.pending || this.pending.length === 0) return undefined;
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

// ------------------------------------------------------------ recorder

export class Log {
  readonly events: PlayEvent[] | null;
  constructor(
    record: boolean,
    private box: Box,
  ) {
    this.events = record ? [] : null;
  }

  get on(): boolean {
    return this.events !== null;
  }

  push(ev: Omit<PlayEvent, "deltas">) {
    if (!this.events) return;
    const deltas = this.box.flush();
    this.events.push(deltas ? { ...ev, deltas } : ev);
  }
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function finish(
  home: number,
  away: number,
  periods: { home: number[]; away: number[] },
  box: Box,
  log: Log,
  extra: Partial<GameResult> & { status: string },
): GameResult {
  return {
    home,
    away,
    periods,
    ot: false,
    tie: home === away,
    box: { home: box.rows[0], away: box.rows[1] },
    team: { home: {}, away: {} },
    events: log.events ?? undefined,
    ...extra,
  };
}

/** Is this player available, given the injury report and the user's edits? */
export function available(
  p: { id: string; status: string },
  benched: Set<string>,
  activated: Set<string>,
): boolean {
  if (benched.has(p.id)) return false;
  if (activated.has(p.id)) return true;
  return p.status !== "out";
}
