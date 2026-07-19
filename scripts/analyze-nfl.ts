#!/usr/bin/env -S npx tsx
/**
 * analyze-nfl.ts — the NFL leg of the NBA/NFL expedition.
 *
 *   npx tsx scripts/analyze-nfl.ts                # frozen run: all report tables
 *   npx tsx scripts/analyze-nfl.ts --tune-engines # dev-only grids for rating engines
 *   npx tsx scripts/analyze-nfl.ts --tune-fitted  # dev-only grids for fitted models
 *
 * Protocol (pre-committed before any test-set number was seen):
 *   - Corpus: .backtest-cache/nfl-games.jsonl (1999 → 2025 incl. playoffs;
 *     closing spread on every game, moneylines from 2011).
 *   - 1999 is rating burn-in and is never scored.
 *   - Walk-forward everywhere; DEV = seasons 2000–2015 (all tuning),
 *     TEST = 2016–2025 (frozen, scored once).
 *   - Moneyline-based comparisons run on the games that have one (2011+).
 *   - Ties (15 games) update ratings at 0.5 but are excluded from scoring.
 *   - Fitted models refit once per season on all completed prior seasons.
 */

import { readFileSync } from "node:fs";
import {
  BradleyTerry,
  EloEngine,
  Glicko2Engine,
  GbmModel,
  MlpModel,
  OffDefRidge,
  PastGame,
  PythagTracker,
  RidgeMargin,
  Scored,
  applyStandardizer,
  bootstrapCI,
  calibrationTable,
  devig,
  fitStandardizer,
  fitTemperature,
  fmtPct,
  logisticFit,
  logisticPredict,
  logit,
  metrics,
  normCdf,
  pad,
  payout,
  sigmoid,
} from "./lib-zoo";

// ----------------------------------------------------------------- protocol

const DEV_SEASONS = new Set(
  Array.from({ length: 16 }, (_, i) => 2000 + i), // 2000–2015
);
const TEST_SEASONS = new Set(
  Array.from({ length: 10 }, (_, i) => 2016 + i), // 2016–2025
);
const FITTED_FIRST_SEASON = 2003;

// Frozen hyperparameters — chosen by --tune-engines / --tune-fitted on DEV.
const FROZEN = {
  eloBasic: { k: 40, hfa: 55, mov: false, carry: 0.6, mean: 1505, init: 1300 },
  eloMov: { k: 20, hfa: 55, mov: true, carry: 0.5, mean: 1505, init: 1300 },
  eloCtx: { bye: 35, short: 45, qbChange: 80 }, // rating-point bumps on eloMov
  glicko: { tau: 0.5, rd0: 100, sigma0: 0.06, hfa: 65, inflate: 90 },
  pythag: { exponent: 3.4, priorGames: 8, leagueAvgPts: 22, homeLogit: 0.35 },
  srs: { lambda: 2, halflifeDays: 150, windowDays: 1500, refitDays: 7, sigma: 14.25 },
  offdef: { lambda: 2, halflifeDays: 150, windowDays: 1500, refitDays: 7, sigma: 14.25 },
  bt: { l2: 1, halflifeDays: 200, windowDays: 1500, refitDays: 7 },
  logit: { l2: 50 },
  gbm: { trees: 100, lr: 0.05, subsample: 0.8, seed: 42, minLeaf: 60 },
  mlp: { hidden: 8, epochs: 15, lr: 0.01, l2: 1e-4, seed: 42 },
  sigmaMkt: 12, // spread → prob (dev-fit)
  temperature: {} as Record<string, number>,
  blendW: 0.8, // market weight in the model×market blend (dev-fit)
};

// ------------------------------------------------------------------- corpus

type Game = {
  date: string;
  season: number;
  week: number;
  type: string;
  home: string;
  away: string;
  hs: number;
  as: number;
  spread: number | null;
  total: number | null;
  mlH: number | null;
  mlA: number | null;
  restH: number;
  restA: number;
  div: 0 | 1;
  dome: 0 | 1;
  qbH: string;
  qbA: string;
  neutral: 0 | 1;
};

function loadCorpus(): Game[] {
  return readFileSync(".backtest-cache/nfl-games.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l) as Game);
}

// -------------------------------------------------------------- form tracker

class FormTracker {
  private hist = new Map<string, { r: number; m: number }[]>();

  private list(team: string, season: number) {
    const key = `${team}|${season}`;
    let l = this.hist.get(key);
    if (!l) {
      l = [];
      this.hist.set(key, l);
    }
    return l;
  }

  /** last-5 win% (prior 2 pseudo-games at 0.5), mean margin last 5,
   *  season win% (prior 4 at 0.5). */
  features(team: string, season: number) {
    const l = this.list(team, season);
    const last5 = l.slice(-5);
    const l5 = (last5.reduce((a, g) => a + g.r, 0) + 2 * 0.5) / (last5.length + 2);
    const net5 = last5.length ? last5.reduce((a, g) => a + g.m, 0) / last5.length : 0;
    const wp = (l.reduce((a, g) => a + g.r, 0) + 4 * 0.5) / (l.length + 4);
    return { l5, net5, wp };
  }

  update(team: string, season: number, result: number, margin: number) {
    this.list(team, season).push({ r: result, m: margin });
  }
}

/** Walk-forward QB starter tracking: change vs previous game, career debut. */
class QbTracker {
  private lastQb = new Map<string, string>();
  private starts = new Map<string, number>();

  flags(team: string, qb: string) {
    const change = this.lastQb.has(team) && this.lastQb.get(team) !== qb ? 1 : 0;
    const debut = qb && !this.starts.has(qb) ? 1 : 0;
    return { change, debut };
  }

  update(team: string, qb: string) {
    if (!qb) return;
    this.lastQb.set(team, qb);
    this.starts.set(qb, (this.starts.get(qb) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------- main pass

const FEATURE_NAMES = [
  "eloD",
  "glickoD",
  "srsM",
  "offdefM",
  "btL",
  "pythagD",
  "wpD",
  "l5D",
  "net5D",
  "restH",
  "restA",
  "byeH",
  "byeA",
  "shortH",
  "shortA",
  "qbChgH",
  "qbChgA",
  "qbDebH",
  "qbDebA",
  "div",
  "dome",
  "week",
  "playoff",
  "neutral",
] as const;

type Row = {
  date: string;
  season: number;
  playoff: 0 | 1;
  y: number;
  margin: number;
  mlH: number | null;
  mlA: number | null;
  spread: number | null;
  probs: Record<string, number>;
  feats: number[];
};

function runPass(games: Game[], cfg = FROZEN): Row[] {
  const eloB = new EloEngine(cfg.eloBasic);
  const eloM = new EloEngine(cfg.eloMov);
  const glicko = new Glicko2Engine(cfg.glicko);
  const pythag = new PythagTracker(cfg.pythag);
  const srs = new RidgeMargin(cfg.srs);
  const offdef = new OffDefRidge(cfg.offdef);
  const bt = new BradleyTerry(cfg.bt);
  const form = new FormTracker();
  const qbs = new QbTracker();

  const past: (PastGame & { result: number })[] = [];
  let lastFit = -Infinity;
  const rows: Row[] = [];

  for (const g of games) {
    const t = Date.parse(g.date) / 86400000;
    if (t - lastFit >= cfg.srs.refitDays && past.length > 300) {
      srs.fit(past, t);
      offdef.fit(past, t);
      bt.fit(past, t);
      lastFit = t;
    }

    const playoff: 0 | 1 = g.type === "REG" ? 0 : 1;
    const tie = g.hs === g.as;

    if (g.season >= 2000 && !tie) {
      const fH = form.features(g.home, g.season);
      const fA = form.features(g.away, g.season);
      const byeH = g.restH >= 13 && g.week > 1 ? 1 : 0;
      const byeA = g.restA >= 13 && g.week > 1 ? 1 : 0;
      const shortH = g.restH <= 5 ? 1 : 0;
      const shortA = g.restA <= 5 ? 1 : 0;
      const qbFH = qbs.flags(g.home, g.qbH);
      const qbFA = qbs.flags(g.away, g.qbA);

      const pEloB = eloB.prob(g.home, g.away, g.season, g.neutral);
      const pEloM = eloM.prob(g.home, g.away, g.season, g.neutral);
      const ctxBump =
        cfg.eloCtx.bye * (byeH - byeA) +
        cfg.eloCtx.short * (shortA - shortH) +
        cfg.eloCtx.qbChange * (qbFA.change - qbFH.change);
      const eloDiffCtx =
        eloM.rating(g.home) - eloM.rating(g.away) + (g.neutral ? 0 : cfg.eloMov.hfa) + ctxBump;
      const pEloC = 1 / (1 + Math.pow(10, -eloDiffCtx / 400));
      const pGlicko = glicko.prob(g.home, g.away, g.season, g.neutral);
      const pPythag = pythag.prob(g.home, g.away, g.season, g.neutral);
      const srsM = srs.fitted ? srs.margin(g.home, g.away, g.neutral) : 0;
      const odM = offdef.fitted ? offdef.margin(g.home, g.away, g.neutral) : 0;
      let paceRatio = 1;
      if (offdef.fitted) {
        const { eh, ea } = offdef.points(g.home, g.away, g.neutral);
        paceRatio = Math.sqrt(Math.max(0.6, (eh + ea) / offdef.avgTotal()));
      }
      const btL = bt.fitted ? bt.logitDiff(g.home, g.away, g.neutral) : 0;

      const feats = [
        eloM.rating(g.home) - eloM.rating(g.away),
        glicko.rating(g.home) - glicko.rating(g.away),
        srsM,
        odM,
        btL,
        logit(pythag.expectation(g.home, g.season)) - logit(pythag.expectation(g.away, g.season)),
        fH.wp - fA.wp,
        fH.l5 - fA.l5,
        fH.net5 - fA.net5,
        g.restH,
        g.restA,
        byeH,
        byeA,
        shortH,
        shortA,
        qbFH.change,
        qbFA.change,
        qbFH.debut,
        qbFA.debut,
        g.div,
        g.dome,
        g.week,
        playoff,
        g.neutral,
      ];

      rows.push({
        date: g.date,
        season: g.season,
        playoff,
        y: g.hs > g.as ? 1 : 0,
        margin: g.hs - g.as,
        mlH: g.mlH,
        mlA: g.mlA,
        spread: g.spread,
        probs: {
          "elo-basic": pEloB,
          "elo-mov": pEloM,
          "elo-ctx": pEloC,
          glicko2: pGlicko,
          pythag: pPythag,
          "srs-normal": normCdf(srsM / cfg.srs.sigma),
          "offdef-pace": normCdf(odM / (cfg.offdef.sigma * paceRatio)),
          "bradley-terry": sigmoid(btL),
        },
        feats,
      });
    }

    const result = tie ? 0.5 : g.hs > g.as ? 1 : 0;
    const margin = g.hs - g.as;
    eloB.update(g.home, g.away, g.season, result, margin, g.neutral);
    eloM.update(g.home, g.away, g.season, result, margin, g.neutral);
    glicko.update(g.home, g.away, g.season, result, g.neutral);
    pythag.update(g.home, g.season, g.hs, g.as);
    pythag.update(g.away, g.season, g.as, g.hs);
    form.update(g.home, g.season, result, margin);
    form.update(g.away, g.season, 1 - result, -margin);
    qbs.update(g.home, g.qbH);
    qbs.update(g.away, g.qbA);
    past.push({
      t,
      home: g.home,
      away: g.away,
      hs: g.hs,
      as: g.as,
      neutral: g.neutral,
      result,
    });
  }
  return rows;
}

// ------------------------------------------------- fitted models (walk-fwd)

function addFittedModels(rows: Row[], cfg = FROZEN) {
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  for (const s of seasons) {
    if (s < FITTED_FIRST_SEASON) continue;
    const train = rows.filter((r) => r.season < s);
    const testRows = rows.filter((r) => r.season === s);
    if (train.length < 600) continue;

    const X = train.map((r) => r.feats);
    const y = train.map((r) => r.y);
    const std = fitStandardizer(X);
    const Xs = X.map((x) => applyStandardizer(std, x));

    const beta = logisticFit(Xs, y, cfg.logit.l2);
    const gbm = new GbmModel(cfg.gbm);
    gbm.fit(Xs, y);
    const mlp = new MlpModel(cfg.mlp);
    mlp.fit(Xs, y);

    const trainM = train.filter((r) => r.mlH !== null && r.mlA !== null);
    let betaM: number[] | null = null;
    let stdM: ReturnType<typeof fitStandardizer> | null = null;
    if (trainM.length >= 400) {
      const XM = trainM.map((r) => [...r.feats, logit(devig(r.mlH!, r.mlA!))]);
      stdM = fitStandardizer(XM);
      betaM = logisticFit(
        XM.map((x) => applyStandardizer(stdM!, x)),
        trainM.map((r) => r.y),
        cfg.logit.l2,
      );
    }

    for (const r of testRows) {
      const xs = applyStandardizer(std, r.feats);
      r.probs["logit-wf"] = logisticPredict(beta, xs);
      r.probs["gbm-wf"] = gbm.predict(xs);
      r.probs["mlp-wf"] = mlp.predict(xs);
      if (betaM && stdM && r.mlH !== null && r.mlA !== null) {
        const xm = applyStandardizer(stdM, [...r.feats, logit(devig(r.mlH, r.mlA))]);
        r.probs["logit+mkt-wf"] = logisticPredict(betaM, xm);
      }
    }
  }
}

// --------------------------------------------------- market & derived probs

function addMarketAndDerived(rows: Row[], cfg = FROZEN) {
  for (const r of rows) {
    if (r.mlH !== null && r.mlA !== null) r.probs["market-ml"] = devig(r.mlH, r.mlA);
    if (r.spread !== null) r.probs["market-spread"] = normCdf(r.spread / cfg.sigmaMkt);
  }
}

// -------------------------------------------------------------- evaluation

function scoredRows(rows: Row[], model: string, seasons: Set<number>): Scored[] {
  return rows
    .filter((r) => seasons.has(r.season) && r.probs[model] !== undefined)
    .map((r) => ({ y: r.y, p: r.probs[model] }));
}

function table(rows: Row[], models: string[], seasons: Set<number>, label: string) {
  console.log(`\n### ${label}`);
  console.log(
    `${"model".padEnd(16)} ${pad("n", 6)} ${pad("acc", 7)} ${pad("brier", 8)} ${pad("logloss", 8)}`,
  );
  const out: { model: string; n: number; acc: number; brier: number; logLoss: number }[] = [];
  for (const m of models) {
    const sr = scoredRows(rows, m, seasons);
    if (sr.length === 0) continue;
    out.push({ model: m, ...metrics(sr) });
  }
  out.sort((a, b) => a.brier - b.brier);
  for (const o of out)
    console.log(
      `${o.model.padEnd(16)} ${pad(o.n, 6)} ${pad(fmtPct(o.acc), 7)} ${pad(o.brier.toFixed(4), 8)} ${pad(o.logLoss.toFixed(4), 8)}`,
    );
  return out;
}

function edgeTest(rows: Row[], model: string, seasons: Set<number>, evMin: number) {
  const rets: number[] = [];
  for (const r of rows) {
    if (!seasons.has(r.season) || r.mlH === null || r.mlA === null) continue;
    const p = r.probs[model];
    if (p === undefined) continue;
    const evH = p * payout(r.mlH) - (1 - p);
    const evA = (1 - p) * payout(r.mlA) - p;
    if (evH > evMin && evH >= evA) rets.push(r.y === 1 ? payout(r.mlH) : -1);
    else if (evA > evMin) rets.push(r.y === 0 ? payout(r.mlA) : -1);
  }
  if (rets.length < 30) return null;
  const roi = rets.reduce((a, b) => a + b, 0) / rets.length;
  const [lo, hi] = bootstrapCI(rets);
  const h1 = rets.slice(0, Math.floor(rets.length / 2));
  const h2 = rets.slice(Math.floor(rets.length / 2));
  return {
    n: rets.length,
    roi,
    lo,
    hi,
    r1: h1.reduce((a, b) => a + b, 0) / h1.length,
    r2: h2.reduce((a, b) => a + b, 0) / h2.length,
  };
}

// -------------------------------------------------------------------- tune

function tuneEngines(games: Game[]) {
  console.log("== engine grids (dev Brier; walk-forward replays) ==");

  for (const mov of [false, true]) {
    let best = { k: 0, hfa: 0, carry: 0, brier: 1 };
    for (const k of mov ? [16, 20, 24] : [24, 32, 40, 48])
      for (const hfa of [35, 45, 55, 65])
        for (const carry of [0.4, 0.5, 0.6, 0.75]) {
          const elo = new EloEngine({ k, hfa, mov, carry, mean: 1505, init: 1300 });
          let s = 0;
          let n = 0;
          for (const g of games) {
            const tie = g.hs === g.as;
            const p = elo.prob(g.home, g.away, g.season, g.neutral);
            if (g.season >= 2000 && DEV_SEASONS.has(g.season) && !tie) {
              s += (p - (g.hs > g.as ? 1 : 0)) ** 2;
              n++;
            }
            elo.update(
              g.home,
              g.away,
              g.season,
              tie ? 0.5 : g.hs > g.as ? 1 : 0,
              g.hs - g.as,
              g.neutral,
            );
          }
          const brier = s / n;
          if (brier < best.brier) best = { k, hfa, carry, brier };
        }
    console.log(`elo${mov ? "-mov" : "-basic"} best:`, best);
  }

  // elo-ctx bumps post-hoc on the frozen elo-mov replay
  {
    const elo = new EloEngine(FROZEN.eloMov);
    const qbs = new QbTracker();
    const recs: { diff: number; bye: number; short: number; qbc: number; y: number }[] = [];
    for (const g of games) {
      const tie = g.hs === g.as;
      if (g.season >= 2000 && DEV_SEASONS.has(g.season) && !tie) {
        elo.prob(g.home, g.away, g.season, g.neutral);
        const qbFH = qbs.flags(g.home, g.qbH);
        const qbFA = qbs.flags(g.away, g.qbA);
        recs.push({
          diff: elo.rating(g.home) - elo.rating(g.away) + (g.neutral ? 0 : FROZEN.eloMov.hfa),
          bye: (g.restH >= 13 && g.week > 1 ? 1 : 0) - (g.restA >= 13 && g.week > 1 ? 1 : 0),
          short: (g.restA <= 5 ? 1 : 0) - (g.restH <= 5 ? 1 : 0),
          qbc: qbFA.change - qbFH.change,
          y: g.hs > g.as ? 1 : 0,
        });
      }
      elo.update(g.home, g.away, g.season, tie ? 0.5 : g.hs > g.as ? 1 : 0, g.hs - g.as, g.neutral);
      qbs.update(g.home, g.qbH);
      qbs.update(g.away, g.qbA);
    }
    let best = { bye: 0, short: 0, qbChange: 0, brier: 1 };
    for (const bye of [20, 35, 50, 70])
      for (const short of [20, 30, 45])
        for (const qbChange of [50, 80, 120, 160]) {
          let s = 0;
          for (const r of recs) {
            const p =
              1 /
              (1 +
                Math.pow(10, -(r.diff + bye * r.bye + short * r.short + qbChange * r.qbc) / 400));
            s += (p - r.y) ** 2;
          }
          const brier = s / recs.length;
          if (brier < best.brier) best = { bye, short, qbChange, brier };
        }
    console.log("elo-ctx bumps best:", best);
  }

  // Glicko grid
  {
    let best: Record<string, number> = { brier: 1 };
    for (const tau of [0.5, 0.8])
      for (const rd0 of [60, 80, 100])
        for (const hfa of [55, 65, 75])
          for (const inflate of [60, 90, 120]) {
            const gl = new Glicko2Engine({ tau, rd0, sigma0: 0.06, hfa, inflate });
            let s = 0;
            let n = 0;
            for (const g of games) {
              const tie = g.hs === g.as;
              const p = gl.prob(g.home, g.away, g.season, g.neutral);
              if (g.season >= 2000 && DEV_SEASONS.has(g.season) && !tie) {
                s += (p - (g.hs > g.as ? 1 : 0)) ** 2;
                n++;
              }
              gl.update(g.home, g.away, g.season, tie ? 0.5 : g.hs > g.as ? 1 : 0, g.neutral);
            }
            const brier = s / n;
            if (brier < best.brier) best = { tau, rd0, hfa, inflate, brier };
          }
    console.log("glicko2 best:", best);
  }

  // Pythag grid
  {
    let best: Record<string, number> = { brier: 1 };
    for (const exponent of [2.8, 3.4, 4.0, 4.6])
      for (const priorGames of [8, 12, 16])
        for (const homeLogit of [0.25, 0.35, 0.45]) {
          const py = new PythagTracker({ exponent, priorGames, leagueAvgPts: 22, homeLogit });
          let s = 0;
          let n = 0;
          for (const g of games) {
            const tie = g.hs === g.as;
            const p = py.prob(g.home, g.away, g.season, g.neutral);
            if (g.season >= 2000 && DEV_SEASONS.has(g.season) && !tie) {
              s += (p - (g.hs > g.as ? 1 : 0)) ** 2;
              n++;
            }
            py.update(g.home, g.season, g.hs, g.as);
            py.update(g.away, g.season, g.as, g.hs);
          }
          const brier = s / n;
          if (brier < best.brier) best = { exponent, priorGames, homeLogit, brier };
        }
    console.log("pythag best:", best);
  }

  // Ridge families
  for (const fam of ["srs", "offdef", "bt"] as const) {
    let best: Record<string, number> = { brier: 1 };
    for (const lambda of [0.5, 1, 2, 4, 8])
      for (const halflifeDays of [100, 150, 200, 300]) {
        const cfgRidge = { lambda, halflifeDays, windowDays: 1500, refitDays: 7 };
        const eng =
          fam === "srs"
            ? new RidgeMargin(cfgRidge)
            : fam === "offdef"
              ? new OffDefRidge(cfgRidge)
              : new BradleyTerry({ l2: lambda, halflifeDays, windowDays: 1500 });
        const past: (PastGame & { result: number })[] = [];
        let lastFit = -Infinity;
        const preds: { v: number; ratio: number; y: number }[] = [];
        for (const g of games) {
          const t = Date.parse(g.date) / 86400000;
          const tie = g.hs === g.as;
          if (t - lastFit >= 7 && past.length > 300) {
            (eng as { fit: (g: typeof past, t: number) => void }).fit(past, t);
            lastFit = t;
          }
          if (
            g.season >= 2000 &&
            DEV_SEASONS.has(g.season) &&
            !tie &&
            (eng as RidgeMargin).fitted
          ) {
            let v: number;
            let ratio = 1;
            if (fam === "bt") v = (eng as BradleyTerry).prob(g.home, g.away, g.neutral);
            else {
              v = (eng as RidgeMargin).margin(g.home, g.away, g.neutral);
              if (fam === "offdef") {
                const od = eng as OffDefRidge;
                const { eh, ea } = od.points(g.home, g.away, g.neutral);
                ratio = Math.sqrt(Math.max(0.6, (eh + ea) / od.avgTotal()));
              }
            }
            preds.push({ v, ratio, y: g.hs > g.as ? 1 : 0 });
          }
          past.push({
            t,
            home: g.home,
            away: g.away,
            hs: g.hs,
            as: g.as,
            neutral: g.neutral,
            result: tie ? 0.5 : g.hs > g.as ? 1 : 0,
          });
        }
        let brier: number;
        let sigmaBest = 0;
        if (fam === "bt") {
          brier = preds.reduce((a, p) => a + (p.v - p.y) ** 2, 0) / preds.length;
        } else {
          brier = 1;
          for (let sig = 10; sig <= 17.01; sig += 0.25) {
            const b =
              preds.reduce((a, p) => a + (normCdf(p.v / (sig * p.ratio)) - p.y) ** 2, 0) /
              preds.length;
            if (b < brier) {
              brier = b;
              sigmaBest = sig;
            }
          }
        }
        if (brier < best.brier) best = { lambda, halflifeDays, sigma: sigmaBest, brier };
      }
    console.log(`${fam} best:`, best);
  }

  // market spread sigma on dev
  {
    let best = { sigma: 0, brier: 1 };
    for (let sig = 10; sig <= 17.01; sig += 0.25) {
      let s = 0;
      let n = 0;
      for (const g of games) {
        if (g.season < 2000 || !DEV_SEASONS.has(g.season) || g.spread === null || g.hs === g.as)
          continue;
        s += (normCdf(g.spread / sig) - (g.hs > g.as ? 1 : 0)) ** 2;
        n++;
      }
      const brier = s / n;
      if (brier < best.brier) best = { sigma: sig, brier };
    }
    console.log("market-spread sigma best:", best);
  }
}

function tuneFitted(rows: Row[]) {
  console.log("== fitted-model grids (dev walk-forward Brier) ==");
  const devSeasons = [...DEV_SEASONS].filter((s) => s >= FITTED_FIRST_SEASON);
  const evalCfg = (
    name: string,
    fitPredict: (Xs: number[][], y: number[], Xt: number[][]) => number[],
  ) => {
    const scored: Scored[] = [];
    for (const s of devSeasons) {
      const train = rows.filter((r) => r.season < s);
      const test = rows.filter((r) => r.season === s);
      if (train.length < 600) continue;
      const std = fitStandardizer(train.map((r) => r.feats));
      const Xs = train.map((r) => applyStandardizer(std, r.feats));
      const Xt = test.map((r) => applyStandardizer(std, r.feats));
      const preds = fitPredict(
        Xs,
        train.map((r) => r.y),
        Xt,
      );
      test.forEach((r, i) => scored.push({ y: r.y, p: preds[i] }));
    }
    const m = metrics(scored);
    console.log(`${name}: n=${m.n} acc=${fmtPct(m.acc)} brier=${m.brier.toFixed(4)}`);
  };

  for (const l2 of [20, 50, 100])
    evalCfg(`logit l2=${l2}`, (Xs, y, Xt) => {
      const beta = logisticFit(Xs, y, l2);
      return Xt.map((x) => logisticPredict(beta, x));
    });
  for (const trees of [100, 200, 400])
    for (const lr of [0.05, 0.08])
      evalCfg(`gbm trees=${trees} lr=${lr}`, (Xs, y, Xt) => {
        const gbm = new GbmModel({ trees, lr, subsample: 0.8, seed: 42, minLeaf: 60 });
        gbm.fit(Xs, y);
        return Xt.map((x) => gbm.predict(x));
      });
  for (const hidden of [8, 12])
    for (const epochs of [15, 25])
      for (const lr of [0.03, 0.01])
        evalCfg(`mlp h=${hidden} ep=${epochs} lr=${lr}`, (Xs, y, Xt) => {
          const mlp = new MlpModel({ hidden, epochs, lr, l2: 1e-4, seed: 42 });
          mlp.fit(Xs, y);
          return Xt.map((x) => mlp.predict(x));
        });
}

// -------------------------------------------------------------- diagnostics

/** Post-hoc report diagnostics (labeled as such — nothing here feeds any
 *  frozen number). */
function diagnostics(rows: Row[]) {
  const testRows = rows.filter((r) => TEST_SEASONS.has(r.season));
  const devRows = rows.filter((r) => DEV_SEASONS.has(r.season));

  console.log("### diagnostics");
  console.log(
    `home rate: dev ${fmtPct(devRows.reduce((a, r) => a + r.y, 0) / devRows.length, 2)}  test ${fmtPct(testRows.reduce((a, r) => a + r.y, 0) / testRows.length, 2)}`,
  );

  for (const [label, rws] of [
    ["dev", devRows],
    ["test", testRows],
  ] as const) {
    let best = { sigma: 0, brier: 1 };
    for (let sig = 10; sig <= 17.01; sig += 0.25) {
      const sel = rws.filter((r) => r.spread !== null);
      const b = sel.reduce((a, r) => a + (normCdf(r.spread! / sig) - r.y) ** 2, 0) / sel.length;
      if (b < best.brier) best = { sigma: sig, brier: b };
    }
    const sd = Math.sqrt(
      rws.reduce((a, r) => a + (r.margin - (r.spread ?? 0)) ** 2, 0) / rws.length,
    );
    console.log(
      `${label}: optimal spread σ=${best.sigma} (brier ${best.brier.toFixed(4)}), sd(margin−spread)=${sd.toFixed(2)}`,
    );
  }

  const pocket = (name: string, side: (r: Row) => "H" | "A" | null) => {
    const rets: number[] = [];
    for (const r of testRows) {
      if (r.mlH === null || r.mlA === null) continue;
      const s = side(r);
      if (!s) continue;
      if (s === "H") rets.push(r.y === 1 ? payout(r.mlH) : -1);
      else rets.push(r.y === 0 ? payout(r.mlA) : -1);
    }
    const roi = rets.reduce((a, b) => a + b, 0) / rets.length;
    const [lo, hi] = bootstrapCI(rets);
    console.log(
      `pocket ${name.padEnd(14)} n=${pad(rets.length, 5)} roi=${fmtPct(roi)} CI90=[${fmtPct(lo)},${fmtPct(hi)}]`,
    );
  };
  pocket("always-home", () => "H");
  pocket("always-fav", (r) => (r.mlH! <= r.mlA! ? "H" : "A"));
  pocket("always-dog", (r) => (r.mlH! > r.mlA! ? "H" : "A"));

  for (const m of ["elo-ctx", "ens-cal", "gbm-wf"]) {
    let agree = 0;
    let flips = 0;
    let flipWins = 0;
    let n = 0;
    for (const r of testRows) {
      const p = r.probs[m];
      if (p === undefined || r.spread === null || r.spread === 0) continue;
      n++;
      const mPick = p > 0.5 ? 1 : 0;
      const sPick = r.spread > 0 ? 1 : 0;
      if (mPick === sPick) agree++;
      else {
        flips++;
        if (mPick === r.y) flipWins++;
      }
    }
    console.log(
      `${m}: agrees with spread pick ${fmtPct(agree / n)}; on ${flips} disagreements wins ${fmtPct(flipWins / flips)}`,
    );
  }

  const std = fitStandardizer(devRows.map((r) => r.feats));
  const beta = logisticFit(
    devRows.map((r) => applyStandardizer(std, r.feats)),
    devRows.map((r) => r.y),
    FROZEN.logit.l2,
  );
  console.log("logit-wf standardized coefficients (dev fit):");
  FEATURE_NAMES.forEach((f, i) =>
    console.log(`  ${String(f).padEnd(10)} ${beta[i] >= 0 ? "+" : ""}${beta[i].toFixed(3)}`),
  );
  console.log(`  intercept  ${beta[beta.length - 1].toFixed(3)}`);
}

// --------------------------------------------------------------------- main

const MODELS = [
  "home-const",
  "elo-basic",
  "elo-mov",
  "elo-ctx",
  "glicko2",
  "pythag",
  "bradley-terry",
  "srs-normal",
  "offdef-pace",
  "logit-wf",
  "gbm-wf",
  "mlp-wf",
  "logit+mkt-wf",
  "ens-avg",
  "ens-cal",
  "blend-mkt",
  "market-ml",
  "market-spread",
];

function main() {
  const mode = process.argv[2] ?? "";
  const games = loadCorpus();
  console.log(`corpus: ${games.length} games ${games[0].date} → ${games[games.length - 1].date}`);

  if (mode === "--tune-engines") {
    tuneEngines(games);
    return;
  }

  const rows = runPass(games);
  if (mode === "--tune-fitted") {
    tuneFitted(rows);
    return;
  }

  addFittedModels(rows);
  addMarketAndDerived(rows);

  const devHome = rows.filter((r) => DEV_SEASONS.has(r.season));
  const homeRate = devHome.reduce((a, r) => a + r.y, 0) / devHome.length;
  for (const r of rows) r.probs["home-const"] = homeRate;
  console.log(`home-const rate (dev): ${fmtPct(homeRate, 2)}`);

  for (const r of rows) {
    const ps = ["elo-ctx", "srs-normal", "gbm-wf"].map((m) => r.probs[m]);
    if (ps.every((p) => p !== undefined))
      r.probs["ens-avg"] = sigmoid(ps.reduce((a, p) => a + logit(p!), 0) / ps.length);
  }
  for (const m of ["elo-mov", "elo-ctx", "srs-normal", "gbm-wf", "logit-wf", "ens-avg"]) {
    FROZEN.temperature[m] = fitTemperature(scoredRows(rows, m, DEV_SEASONS));
  }
  console.log("dev temperatures:", FROZEN.temperature);
  for (const r of rows) {
    const p = r.probs["ens-avg"];
    if (p !== undefined) r.probs["ens-cal"] = sigmoid(FROZEN.temperature["ens-avg"] * logit(p));
    const pc = r.probs["ens-cal"];
    const mkt = r.probs["market-ml"];
    if (pc !== undefined && mkt !== undefined)
      r.probs["blend-mkt"] = sigmoid((1 - FROZEN.blendW) * logit(pc) + FROZEN.blendW * logit(mkt));
  }

  table(rows, MODELS, DEV_SEASONS, "DEV seasons 2000–2015");
  table(rows, MODELS, TEST_SEASONS, "TEST seasons 2016–2025 (frozen)");

  console.log("\n### per-season Brier (key models)");
  const key = ["elo-ctx", "srs-normal", "gbm-wf", "ens-cal", "market-spread"];
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  console.log("season " + key.map((k) => pad(k, 14)).join(""));
  for (const s of seasons) {
    const set = new Set([s]);
    const vals = key.map((m) => {
      const sr = scoredRows(rows, m, set);
      return sr.length ? metrics(sr).brier.toFixed(4) : "—";
    });
    console.log(`${s}   ` + vals.map((v) => pad(v, 14)).join(""));
  }

  for (const m of ["ens-avg", "ens-cal", "market-ml"]) {
    console.log(`\n### calibration — ${m} (test)`);
    for (const b of calibrationTable(scoredRows(rows, m, TEST_SEASONS)))
      console.log(
        `${b.bucket}  n=${pad(b.n, 5)}  claimed=${fmtPct(b.claimed)}  actual=${fmtPct(b.actual)}`,
      );
  }

  console.log("\n### blend w sweep (ens-cal × market-ml, dev 2011+)");
  for (let w = 0; w <= 1.001; w += 0.1) {
    const sr: Scored[] = [];
    for (const r of rows) {
      if (!DEV_SEASONS.has(r.season)) continue;
      const pm = r.probs["ens-cal"];
      const mk = r.probs["market-ml"];
      if (pm === undefined || mk === undefined) continue;
      sr.push({ y: r.y, p: sigmoid((1 - w) * logit(pm) + w * logit(mk)) });
    }
    console.log(`w=${w.toFixed(1)} brier=${metrics(sr).brier.toFixed(4)}`);
  }

  if (mode === "--diag") {
    diagnostics(rows);
    return;
  }

  console.log("\n### flat-bet edge tests vs the moneyline (test seasons)");
  for (const m of ["ens-cal", "elo-ctx", "gbm-wf", "logit+mkt-wf"]) {
    for (const evMin of [0, 0.03, 0.06]) {
      const e = edgeTest(rows, m, TEST_SEASONS, evMin);
      if (!e) continue;
      console.log(
        `${m.padEnd(14)} ev>${evMin.toFixed(2)}  n=${pad(e.n, 5)}  roi=${fmtPct(e.roi)}  CI90=[${fmtPct(e.lo)},${fmtPct(e.hi)}]  halves=${fmtPct(e.r1)}/${fmtPct(e.r2)}`,
      );
    }
  }
}

main();
