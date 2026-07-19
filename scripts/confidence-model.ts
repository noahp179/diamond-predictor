#!/usr/bin/env -S npx tsx
/**
 * confidence-model.ts — a SEPARATE confidence signal, not the prediction itself.
 *
 *   npx tsx scripts/confidence-model.ts [nba|nfl|both]
 *
 * The prediction stays fixed: the margin-of-victory Elo pick (what the live
 * pages use). The question here is different — *how sure should we be that this
 * pick is right?* — and the whole point is to answer it WITHOUT just re-reading
 * the prediction's own probability (which is circular).
 *
 * So we build confidence estimators from OTHER signals and backtest how well
 * each one separates the picks that won from the picks that lost:
 *
 *   C0 self-prob      the Elo pick's own win prob   (the circular baseline)
 *   C1 agreement      how many independent models side with the pick
 *   C2 market-only    the market's own confidence in the pick
 *   C3 meta (no self) walk-forward logistic on {agreement, model spread,
 *                     market, rating-gap, rest, form} — Elo prob EXCLUDED
 *   C4 meta (+ self)  C3 plus the Elo prob as one feature among many
 *
 * Scored two ways: AUC (does higher confidence ⇒ more often correct?) and
 * accuracy at matched coverage (keep the top X% most-confident picks — whose
 * top slice wins most?). Everything walk-forward; fitted layers refit per
 * season on prior seasons only.
 */

import { readFileSync } from "node:fs";

import {
  BradleyTerry,
  EloEngine,
  Glicko2Engine,
  OffDefRidge,
  PastGame,
  PythagTracker,
  RidgeMargin,
  applyStandardizer,
  devig,
  fitStandardizer,
  logisticFit,
  logisticPredict,
  normCdf,
} from "./lib-zoo";

type Sport = "nba" | "nfl";

const CFG = {
  nba: {
    elo: { k: 8, hfa: 80, mov: true, carry: 0.75, mean: 1505, init: 1300 },
    glicko: { tau: 0.5, rd0: 100, sigma0: 0.06, hfa: 80, inflate: 80 },
    pythag: { exponent: 16, priorGames: 10, leagueAvgPts: 104, homeLogit: 0.46 },
    ridge: { lambda: 4, halflifeDays: 90, windowDays: 1200, refitDays: 14 },
    srsSigma: 10.25,
  },
  nfl: {
    elo: { k: 20, hfa: 55, mov: true, carry: 0.5, mean: 1505, init: 1300 },
    glicko: { tau: 0.5, rd0: 100, sigma0: 0.06, hfa: 65, inflate: 90 },
    pythag: { exponent: 3.4, priorGames: 8, leagueAvgPts: 22, homeLogit: 0.35 },
    ridge: { lambda: 2, halflifeDays: 150, windowDays: 1500, refitDays: 7 },
    srsSigma: 14.25,
  },
} as const;

type Raw = {
  date: string;
  season: number;
  home: string;
  away: string;
  hs: number;
  as: number;
  mlH: number | null;
  mlA: number | null;
  restH: number;
  restA: number;
  neutral?: number;
};

function load(sport: Sport): Raw[] {
  const file = sport === "nba" ? "nba-games.jsonl" : "nfl-games.jsonl";
  return readFileSync(`.backtest-cache/${file}`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Raw)
    .filter((r) => Number.isFinite(r.hs) && Number.isFinite(r.as) && r.hs !== r.as)
    .sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
}

// season form (last-10 win%)
class Form {
  private m = new Map<string, number[]>();
  private key(t: string, s: number) {
    return `${t}|${s}`;
  }
  last10(t: string, s: number) {
    const l = (this.m.get(this.key(t, s)) ?? []).slice(-10);
    return (l.reduce((a, b) => a + b, 0) + 3 * 0.5) / (l.length + 3);
  }
  push(t: string, s: number, r: number) {
    const k = this.key(t, s);
    const l = this.m.get(k) ?? [];
    l.push(r);
    this.m.set(k, l);
  }
}

/** One scored game: the fixed Elo prediction + the confidence features. All
 *  feature values are oriented toward THE PICK (so "market" = the market's prob
 *  for the side Elo chose, etc.). */
type Rec = {
  season: number;
  correct: number; // did the Elo pick win?
  // confidence signals, oriented to the pick:
  selfProb: number; // C0: Elo's own conf for the pick  (the circular one)
  agreement: number; // C1: share of independent models siding with the pick
  market: number; // C2: market prob for the pick
  spread: number; // model dispersion (std of home probs)
  gap: number; // |SRS margin| — rating-edge magnitude
  rest: number; // rest edge, pick perspective
  form: number; // last-10 form edge, pick perspective
};

function replay(sport: Sport, rows: Raw[]): Rec[] {
  const c = CFG[sport];
  const elo = new EloEngine(c.elo);
  const glicko = new Glicko2Engine(c.glicko);
  const pythag = new PythagTracker(c.pythag);
  const srs = new RidgeMargin(c.ridge);
  const offdef = new OffDefRidge(c.ridge);
  const bt = new BradleyTerry({
    l2: 1,
    halflifeDays: c.ridge.halflifeDays,
    windowDays: c.ridge.windowDays,
  });
  const form = new Form();
  const past: (PastGame & { result: number })[] = [];
  let lastFit = -Infinity;
  const out: Rec[] = [];

  for (const g of rows) {
    const t = Date.parse(g.date) / 86400000;
    const neutral = g.neutral ?? 0;
    if (t - lastFit >= c.ridge.refitDays && past.length > 200) {
      srs.fit(past, t);
      offdef.fit(past, t);
      bt.fit(past, t);
      lastFit = t;
    }

    const market = g.mlH != null && g.mlA != null && g.mlH !== g.mlA ? devig(g.mlH, g.mlA) : null;
    const eloHome = elo.prob(g.home, g.away, g.season, neutral);
    const glickoHome = glicko.prob(g.home, g.away, g.season, neutral);
    const pythagHome = pythag.prob(g.home, g.away, g.season, neutral);
    const srsM = srs.fitted ? srs.margin(g.home, g.away, neutral) : 0;
    const srsHome = normCdf(srsM / c.srsSigma);
    const odM = offdef.fitted ? offdef.margin(g.home, g.away, neutral) : 0;
    const odHome = normCdf(odM / c.srsSigma);
    const btHome = bt.fitted ? bt.prob(g.home, g.away, neutral) : 0.5;

    const result = g.hs > g.as ? 1 : 0;
    const homeL10 = form.last10(g.home, g.season);
    const awayL10 = form.last10(g.away, g.season);

    // only score games where every confidence signal is available
    if (market != null && srs.fitted && bt.fitted) {
      const pickIsHome = eloHome >= 0.5;
      const forPick = (pHome: number) => (pickIsHome ? pHome : 1 - pHome);
      // independent models — Elo deliberately NOT among the agreement voters
      const others = [glickoHome, pythagHome, srsHome, odHome, btHome, market];
      const agree = others.filter((p) => forPick(p) > 0.5).length / others.length;
      const allHome = [eloHome, glickoHome, pythagHome, srsHome, odHome, btHome, market];
      const mean = allHome.reduce((a, b) => a + b, 0) / allHome.length;
      const spread = Math.sqrt(allHome.reduce((a, b) => a + (b - mean) ** 2, 0) / allHome.length);

      out.push({
        season: g.season,
        correct: (pickIsHome ? result === 1 : result === 0) ? 1 : 0,
        selfProb: forPick(eloHome),
        agreement: agree,
        market: forPick(market),
        spread,
        gap: Math.abs(srsM),
        rest: pickIsHome ? g.restH - g.restA : g.restA - g.restH,
        form: pickIsHome ? homeL10 - awayL10 : awayL10 - homeL10,
      });
    }

    elo.update(g.home, g.away, g.season, result, g.hs - g.as, neutral);
    glicko.update(g.home, g.away, g.season, result, neutral);
    pythag.update(g.home, g.season, g.hs, g.as);
    pythag.update(g.away, g.season, g.as, g.hs);
    form.push(g.home, g.season, result);
    form.push(g.away, g.season, 1 - result);
    past.push({
      t,
      home: g.home,
      away: g.away,
      hs: g.hs,
      as: g.as,
      neutral: neutral as 0 | 1,
      result,
    });
  }
  return out;
}

// ------------------------------------------- fitted meta confidence (walk-fwd)

/** Walk-forward logistic predicting P(correct); refit per season on prior
 *  seasons. Options pick which signals the confidence model may use. Returns a
 *  confidence score per rec (0.5 for seasons too early to train). */
function metaConfidence(recs: Rec[], opts: { self: boolean; market: boolean }): number[] {
  const feats = (r: Rec) => {
    const f = [r.agreement, -r.spread, r.gap, r.rest, r.form];
    if (opts.market) f.push(r.market);
    if (opts.self) f.push(r.selfProb);
    return f;
  };
  const scores = new Array(recs.length).fill(0.5);
  const seasons = [...new Set(recs.map((r) => r.season))].sort();
  for (const s of seasons) {
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    recs.forEach((r, i) => (r.season < s ? trainIdx : r.season === s ? testIdx : null)?.push(i));
    if (trainIdx.length < 800 || testIdx.length === 0) continue;
    const X = trainIdx.map((i) => feats(recs[i]));
    const std = fitStandardizer(X);
    const beta = logisticFit(
      X.map((x) => applyStandardizer(std, x)),
      trainIdx.map((i) => recs[i].correct),
      5,
    );
    for (const i of testIdx)
      scores[i] = logisticPredict(beta, applyStandardizer(std, feats(recs[i])));
  }
  return scores;
}

// --------------------------------------------------------------- scoring

/** AUC = P(a random correct pick scores higher than a random wrong pick).
 *  0.5 = no discrimination; 1.0 = perfect. Computed via rank statistic. */
function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0;
  let i = 0;
  const n = idx.length;
  while (i < n) {
    let j = i;
    while (j < n && scores[idx[j]] === scores[idx[i]]) j++;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) if (labels[idx[k]] === 1) rankSum += avgRank;
    i = j;
  }
  const pos = labels.reduce((a, b) => a + b, 0);
  const neg = n - pos;
  if (pos === 0 || neg === 0) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Accuracy of the top `frac` of picks ranked by confidence. */
function topSliceAcc(scores: number[], labels: number[], frac: number): { acc: number; n: number } {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const n = Math.max(1, Math.floor(order.length * frac));
  const top = order.slice(0, n);
  return { acc: top.reduce((a, i) => a + labels[i], 0) / n, n };
}

function pctScoresOnly(recs: Rec[]) {
  return recs.map((r) => r.correct);
}

function fmt(x: number, d = 1) {
  return (x * 100).toFixed(d);
}
function pad(s: string, w: number) {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padl(s: string, w: number) {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function report(sport: Sport) {
  const recs = replay(sport, load(sport));
  const labels = pctScoresOnly(recs);
  const baseAcc = labels.reduce((a, b) => a + b, 0) / labels.length;

  // every confidence estimator, each a score per rec (higher = more confident)
  const estimators: { name: string; kind: string; scores: number[] }[] = [
    { name: "C0 · self-prob (baseline)", kind: "circular", scores: recs.map((r) => r.selfProb) },
    { name: "C1 · model agreement", kind: "separate", scores: recs.map((r) => r.agreement) },
    { name: "C2 · market-only", kind: "separate", scores: recs.map((r) => r.market) },
    {
      name: "C3 · meta (no self, no mkt)",
      kind: "separate·fit·nomkt",
      scores: metaConfidence(recs, { self: false, market: false }),
    },
    {
      name: "C4 · meta (no self, + mkt)",
      kind: "separate·fit",
      scores: metaConfidence(recs, { self: false, market: true }),
    },
    {
      name: "C5 · meta (+ self, + mkt)",
      kind: "combined·fit",
      scores: metaConfidence(recs, { self: true, market: true }),
    },
  ];

  // meta models can only be scored where they were trained; restrict all
  // estimators to the same evaluable set for a fair comparison
  const evalMask = estimators[3].scores.map((s) => s !== 0.5);
  const keep = (arr: number[]) => arr.filter((_, i) => evalMask[i]);
  const L = keep(labels);
  const evalBase = L.reduce((a, b) => a + b, 0) / L.length;

  console.log(
    `\n######## ${sport.toUpperCase()} — ${L.length.toLocaleString()} scored picks (walk-forward eval set) ########`,
  );
  console.log(
    `The prediction is the Elo pick; on this set it is right ${fmt(evalBase)}% of the time.`,
  );
  console.log(`Confidence's job: rank those picks so the confident ones win more.\n`);

  console.log(
    `${pad("confidence estimator", 30)}${padl("AUC", 7)}${padl("top25%", 8)}${padl("top50%", 8)}${padl("top75%", 8)}${padl("all", 7)}   kind`,
  );
  const rows = estimators.map((e) => {
    const sc = keep(e.scores);
    return {
      name: e.name,
      kind: e.kind,
      auc: auc(sc, L),
      t25: topSliceAcc(sc, L, 0.25).acc,
      t50: topSliceAcc(sc, L, 0.5).acc,
      t75: topSliceAcc(sc, L, 0.75).acc,
      all: evalBase,
    };
  });
  for (const r of rows)
    console.log(
      `${pad(r.name, 30)}${padl(r.auc.toFixed(3), 7)}${padl(fmt(r.t25) + "%", 8)}${padl(fmt(r.t50) + "%", 8)}${padl(fmt(r.t75) + "%", 8)}${padl(fmt(r.all) + "%", 7)}   ${r.kind}`,
    );

  // head-to-head: does a SEPARATE confidence signal out-select the circular one?
  const c0 = rows[0];
  const best = rows.slice(1).reduce((a, b) => (b.auc > a.auc ? b : a));
  console.log(
    `\nBest separate signal: ${best.name} (AUC ${best.auc.toFixed(3)}) vs C0 self-prob (AUC ${c0.auc.toFixed(3)}) → ` +
      `${best.auc > c0.auc + 0.003 ? "BEATS the circular baseline" : best.auc < c0.auc - 0.003 ? "worse than baseline" : "≈ tied with baseline"}.`,
  );
  console.log(`At top-25% coverage: best separate ${fmt(best.t25)}% vs self-prob ${fmt(c0.t25)}%.`);

  // reliability of the combined meta model (predicted P(correct) vs actual)
  const metaScores = keep(estimators[5].scores);
  console.log(`\nCalibration of C5 meta(+self,+mkt) — predicted P(pick correct) vs actual:`);
  for (const [lo, hi] of [
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 1.01],
  ] as const) {
    const sel: number[] = [];
    metaScores.forEach((sc, i) => {
      if (sc >= lo && sc < hi) sel.push(L[i]);
    });
    if (sel.length < 20) continue;
    const actual = sel.reduce((a, b) => a + b, 0) / sel.length;
    console.log(
      `  claims ${(lo * 100).toFixed(0)}–${(Math.min(1, hi) * 100).toFixed(0)}%  n=${padl(String(sel.length), 6)}  actually correct ${fmt(actual)}%`,
    );
  }
  void baseAcc;
}

const which = (process.argv[2] ?? "both") as Sport | "both";
console.log(
  "Separate confidence model — can a signal OTHER than the prediction's own probability tell us which picks to trust? Walk-forward, no lookahead.",
);
if (which === "both" || which === "nba") report("nba");
if (which === "both" || which === "nfl") report("nfl");
console.log(
  "\nAUC = how well confidence separates winning picks from losing ones (0.5 = useless). top-K% = accuracy if you keep only the K% most-confident picks. C0 reuses the prediction's own probability (circular); C1–C3 use only other signals; C4 combines.",
);
