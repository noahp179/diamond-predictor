#!/usr/bin/env -S npx tsx
/**
 * backtest-accuracy.ts — the plain question: how often is each pick right?
 *
 *   npx tsx scripts/backtest-accuracy.ts
 *
 * Runs the exact margin-of-victory Elo the live NFL/NBA pages use
 * (src/lib/espn.server.ts, same K / home edge / carry) walk-forward over the
 * full odds-era datasets in .backtest-cache/, and for every completed game
 * with a closing moneyline records three straight-up picks:
 *
 *   • Model    — the Elo favorite (win prob ≥ 50%)
 *   • Market   — the moneyline favorite (shorter price)
 *   • Blend    — the model blended with the devigged line (Best Odds page)
 *
 * then reports pick accuracy — "X% of picks won" — overall, by season, by
 * confidence bucket, and head-to-head. No money, no ROI: just win rates.
 */

import { readFileSync } from "node:fs";

type Sport = "nba" | "nfl";

// Frozen live-model configuration (mirrors src/lib/espn.server.ts).
const ELO: Record<Sport, { k: number; hfa: number; carry: number }> = {
  nba: { k: 8, hfa: 80, carry: 0.75 },
  nfl: { k: 20, hfa: 55, carry: 0.5 },
};
const MEAN = 1505;
const INIT = 1300;
// Research-frozen market-blend weight (NBA-NFL-ANALYSIS.md §4/§5).
const BLEND_W: Record<Sport, number> = { nba: 0.9, nfl: 0.8 };

type Row = {
  date: string;
  season: number;
  home: string;
  away: string;
  hs: number;
  as: number;
  mlH: number | null;
  mlA: number | null;
  neutral: number;
};

function load(sport: Sport): Row[] {
  const file = sport === "nba" ? "nba-games.jsonl" : "nfl-games.jsonl";
  return readFileSync(`.backtest-cache/${file}`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row & { neutral?: number })
    .map((r) => ({ ...r, neutral: r.neutral ?? 0 }))
    .filter((r) => Number.isFinite(r.hs) && Number.isFinite(r.as) && r.hs !== r.as)
    .sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
}

// ------------------------------------------------------------------- Elo

class Elo {
  private r = new Map<string, number>();
  private seen = new Map<string, number>();
  constructor(private cfg: { k: number; hfa: number; carry: number }) {}
  rating(t: string) {
    return this.r.get(t) ?? INIT;
  }
  private carry(t: string, season: number) {
    const prev = this.seen.get(t);
    if (prev !== undefined && season > prev)
      this.r.set(t, MEAN + this.cfg.carry * (this.rating(t) - MEAN));
    this.seen.set(t, season);
  }
  prob(home: string, away: string, season: number, neutral: number) {
    this.carry(home, season);
    this.carry(away, season);
    const diff = this.rating(home) - this.rating(away) + (neutral ? 0 : this.cfg.hfa);
    return 1 / (1 + Math.pow(10, -diff / 400));
  }
  update(home: string, away: string, hs: number, as: number, season: number, neutral: number) {
    const p = this.prob(home, away, season, neutral);
    const result = hs > as ? 1 : 0;
    const diff = this.rating(home) - this.rating(away) + (neutral ? 0 : this.cfg.hfa);
    const winnerDiff = (result === 1 ? 1 : -1) * diff;
    let mult = Math.log(Math.abs(hs - as) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    if (!Number.isFinite(mult) || mult < 0) mult = 1;
    const d = this.cfg.k * mult * (result - p);
    this.r.set(home, this.rating(home) + d);
    this.r.set(away, this.rating(away) - d);
  }
}

// ------------------------------------------------------------ market math

const impliedProb = (ml: number) => (ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
const devigHome = (h: number, a: number) => impliedProb(h) / (impliedProb(h) + impliedProb(a));
const logit = (p: number) =>
  Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p)) / (1 - Math.min(1 - 1e-9, Math.max(1e-9, p))));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// ------------------------------------------------------------- scoring

type Scored = {
  season: number;
  result: number; // 1 home win
  modelHome: number; // model P(home)
  marketHome: number | null; // devigged market P(home)
  blendHome: number | null;
};

function replay(sport: Sport, rows: Row[]): Scored[] {
  const elo = new Elo(ELO[sport]);
  const out: Scored[] = [];
  for (const g of rows) {
    const modelHome = elo.prob(g.home, g.away, g.season, g.neutral);
    const marketHome =
      g.mlH != null && g.mlA != null && g.mlH !== g.mlA ? devigHome(g.mlH, g.mlA) : null;
    const blendHome =
      marketHome != null
        ? sigmoid((1 - BLEND_W[sport]) * logit(modelHome) + BLEND_W[sport] * logit(marketHome))
        : null;
    out.push({ season: g.season, result: g.hs > g.as ? 1 : 0, modelHome, marketHome, blendHome });
    elo.update(g.home, g.away, g.hs, g.as, g.season, g.neutral);
  }
  return out;
}

const pickCorrect = (pHome: number, result: number) => (pHome >= 0.5 ? 1 : 0) === result;
const conf = (pHome: number) => Math.max(pHome, 1 - pHome);
const pctOf = (correct: number, n: number) => (n ? (100 * correct) / n : 0);

function fmt(x: number, d = 1) {
  return x.toFixed(d);
}

function report(sport: Sport) {
  const rows = load(sport);
  const scored = replay(sport, rows);
  // Only games that have a market line, so every column scores the same games.
  const priced = scored.filter((s) => s.marketHome != null) as (Scored & {
    marketHome: number;
    blendHome: number;
  })[];

  const seasons = [...new Set(priced.map((s) => s.season))].sort();
  const label = sport.toUpperCase();
  console.log(
    `\n======== ${label} — ${priced.length.toLocaleString()} games with a moneyline (${seasons[0]}–${seasons[seasons.length - 1]}) ========`,
  );

  // headline accuracy on identical games
  const acc = (sel: typeof priced, f: (s: (typeof priced)[number]) => number) =>
    pctOf(sel.filter((s) => pickCorrect(f(s), s.result)).length, sel.length);
  console.log("\nStraight-up pick accuracy (all priced games, same set):");
  console.log(`  Model (Elo)      ${fmt(acc(priced, (s) => s.modelHome))}%`);
  console.log(`  Market (favorite) ${fmt(acc(priced, (s) => s.marketHome))}%`);
  console.log(`  Blend (model×mkt) ${fmt(acc(priced, (s) => s.blendHome))}%`);

  // agreement + head-to-head on disagreements
  const disagree = priced.filter(
    (s) => (s.modelHome >= 0.5 ? 1 : 0) !== (s.marketHome >= 0.5 ? 1 : 0),
  );
  const agreeN = priced.length - disagree.length;
  const modelWinsDisag = disagree.filter((s) => pickCorrect(s.modelHome, s.result)).length;
  console.log(
    `\n  Model & Market agree on the side ${fmt(pctOf(agreeN, priced.length))}% of games.`,
  );
  if (disagree.length)
    console.log(
      `  When they disagree (${disagree.length} games): model right ${fmt(pctOf(modelWinsDisag, disagree.length))}%, market right ${fmt(pctOf(disagree.length - modelWinsDisag, disagree.length))}%.`,
    );

  // confidence buckets — the "70%+ favorites actually win ~X%" view
  console.log("\nAccuracy by confidence in the pick (model / market on the SAME confident games):");
  console.log("  bucket        model picks  model win%   market win% (same games)");
  for (const [lo, hi] of [
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 1.01],
  ] as const) {
    const sel = priced.filter((s) => conf(s.modelHome) >= lo && conf(s.modelHome) < hi);
    if (!sel.length) continue;
    const mAcc = acc(sel, (s) => s.modelHome);
    const kAcc = acc(sel, (s) => s.marketHome);
    console.log(
      `  ${(lo * 100).toFixed(0)}–${(Math.min(1, hi) * 100).toFixed(0)}%       ${String(sel.length).padStart(7)}     ${fmt(mAcc).padStart(6)}%      ${fmt(kAcc).padStart(6)}%`,
    );
  }
  console.log("\n  Market's own confident games (how favorites do by market confidence):");
  for (const [lo, hi] of [
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 1.01],
  ] as const) {
    const sel = priced.filter((s) => conf(s.marketHome) >= lo && conf(s.marketHome) < hi);
    if (!sel.length) continue;
    console.log(
      `  ${(lo * 100).toFixed(0)}–${(Math.min(1, hi) * 100).toFixed(0)}%       ${String(sel.length).padStart(7)}     market ${fmt(acc(sel, (s) => s.marketHome))}%`,
    );
  }

  // per-season
  console.log("\nBy season (model win% / market win% / games):");
  for (const s of seasons) {
    const sel = priced.filter((x) => x.season === s);
    const lbl = sport === "nba" ? `${s - 1}-${String(s % 100).padStart(2, "0")}` : `${s}`;
    console.log(
      `  ${lbl.padEnd(8)} model ${fmt(acc(sel, (x) => x.modelHome)).padStart(5)}%   market ${fmt(acc(sel, (x) => x.marketHome)).padStart(5)}%   (${sel.length})`,
    );
  }

  // recent 3 seasons pooled (matches the live Track Record window)
  const recentSeasons = seasons.slice(-3);
  const recent = priced.filter((s) => recentSeasons.includes(s.season));
  console.log(`\nRecent 3 seasons (${recentSeasons.join(", ")}) — the live Track Record window:`);
  console.log(
    `  Model ${fmt(acc(recent, (s) => s.modelHome))}%   Market ${fmt(acc(recent, (s) => s.marketHome))}%   (${recent.length} games)`,
  );

  return { label, priced: priced.length, seasons };
}

console.log("Backtest: straight-up pick accuracy, model vs market. No ROI — win rates only.");
report("nba");
report("nfl");
console.log(
  "\nNote: the model is the exact margin-of-victory Elo the live pages use, replayed walk-forward (each pick uses only prior games). Market = the closing moneyline favorite, from the same datasets.",
);
