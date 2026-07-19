#!/usr/bin/env -S npx tsx
/**
 * analyze-nba.ts — the NBA leg of the NBA/NFL expedition.
 *
 *   npx tsx scripts/analyze-nba.ts                # frozen run: all report tables
 *   npx tsx scripts/analyze-nba.ts --tune-engines # dev-only grids for rating engines
 *   npx tsx scripts/analyze-nba.ts --tune-fitted  # dev-only grids for fitted models
 *
 * Protocol (pre-committed before any test-set number was seen):
 *   - Corpus: .backtest-cache/nba-games.jsonl (2007-08 → 2025-26 partial,
 *     closing odds on ~100% of games), warm-up from nba-history.jsonl
 *     (1946 → the eve of the odds era) so ratings enter 2007-08 hot.
 *   - Walk-forward everywhere: every prediction uses only earlier games.
 *   - DEV = seasons 2008–2019 (12 seasons). All hyperparameters, blend
 *     weights, temperatures and model selections are chosen on dev only.
 *   - TEST = seasons 2020–2026 (frozen, scored once). COVID-era distortions
 *     land in test on purpose — that is what deployment would have faced.
 *   - Fitted models refit once per season on all completed prior seasons.
 *   - 2020 bubble games (2020-07-30 → 2020-10-11) are treated as neutral
 *     site (public knowledge at the time).
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

const DEV_SEASONS = new Set([
  2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019,
]);
const TEST_SEASONS = new Set([2020, 2021, 2022, 2023, 2024, 2025, 2026]);
const FITTED_FIRST_SEASON = 2010; // fitted models need ≥2 completed seasons

const BUBBLE_START = "2020-07-30";
const BUBBLE_END = "2020-10-11";
const NO_FANS_START = "2020-03-11";
const NO_FANS_END = "2021-05-16";

// Frozen hyperparameters — chosen by --tune-engines / --tune-fitted on DEV.
const FROZEN = {
  eloBasic: { k: 20, hfa: 80, mov: false, carry: 0.6, mean: 1505, init: 1300 },
  eloMov: { k: 8, hfa: 80, mov: true, carry: 0.75, mean: 1505, init: 1300 },
  eloRest: { b2b: 25, restPt: 8 }, // rating-point bumps on top of eloMov
  glicko: { tau: 0.5, rd0: 100, sigma0: 0.06, hfa: 80, inflate: 80 },
  pythag: { exponent: 16, priorGames: 10, leagueAvgPts: 104, homeLogit: 0.46 },
  srs: { lambda: 4, halflifeDays: 90, windowDays: 1200, refitDays: 14, sigma: 10.25 },
  offdef: { lambda: 4, halflifeDays: 90, windowDays: 1200, refitDays: 14, sigma: 10.25 },
  bt: { l2: 1, halflifeDays: 90, windowDays: 1200, refitDays: 14 },
  logit: { l2: 5 },
  gbm: { trees: 100, lr: 0.05, subsample: 0.8, seed: 42, minLeaf: 60 },
  mlp: { hidden: 12, epochs: 15, lr: 0.01, l2: 1e-4, seed: 42 },
  sigmaMkt: 11, // spread → prob (dev-fit)
  temperature: {} as Record<string, number>, // dev-fit at run time
  blendW: 0.9, // market weight in the model×market logit blend (dev-fit)
};

// ------------------------------------------------------------------- corpus

type Game = {
  date: string;
  season: number;
  playoff: 0 | 1;
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
  neutral: 0 | 1;
  scored: boolean; // odds-era game that enters evaluation
  p538: number | null;
};

function loadCorpus(): Game[] {
  const hist = readFileSync(".backtest-cache/nba-history.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  const odds = readFileSync(".backtest-cache/nba-games.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  const firstOddsDate = odds[0].date as string;
  const p538ByKey = new Map<string, number>();
  const games: Game[] = [];
  for (const h of hist) {
    if (h.date >= firstOddsDate) {
      if (h.p538 !== null) p538ByKey.set(`${h.date}|${h.home}|${h.away}`, h.p538);
      continue; // odds era covers it
    }
    games.push({
      ...h,
      spread: null,
      total: null,
      mlH: null,
      mlA: null,
      restH: 7,
      restA: 7,
      neutral: h.neutral,
      scored: false,
      p538: null,
    });
  }
  for (const g of odds) {
    const neutral: 0 | 1 = g.date >= BUBBLE_START && g.date <= BUBBLE_END ? 1 : 0;
    games.push({
      ...g,
      neutral,
      scored: true,
      p538: p538ByKey.get(`${g.date}|${g.home}|${g.away}`) ?? null,
    });
  }
  games.sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
  return games;
}

// -------------------------------------------------------------- form tracker

class FormTracker {
  private hist = new Map<string, { r: number; m: number; date: string }[]>();

  private list(team: string, season: number) {
    const key = `${team}|${season}`;
    let l = this.hist.get(key);
    if (!l) {
      l = [];
      this.hist.set(key, l);
    }
    return l;
  }

  /** win% last 10 (prior 3 pseudo-games at 0.5), mean margin last 15,
   *  season win% (prior 8 at 0.5), games in the last 4 days. */
  features(team: string, season: number, date: string) {
    const l = this.list(team, season);
    const last10 = l.slice(-10);
    const l10 = (last10.reduce((a, g) => a + g.r, 0) + 3 * 0.5) / (last10.length + 3);
    const last15 = l.slice(-15);
    const net15 = last15.length ? last15.reduce((a, g) => a + g.m, 0) / last15.length : 0;
    const wp = (l.reduce((a, g) => a + g.r, 0) + 8 * 0.5) / (l.length + 8);
    const t = Date.parse(date);
    let gd4 = 0;
    for (let i = l.length - 1; i >= 0; i--) {
      if (t - Date.parse(l[i].date) <= 4 * 86400000) gd4++;
      else break;
    }
    return { l10, net15, wp, gd4 };
  }

  update(team: string, season: number, date: string, result: number, margin: number) {
    this.list(team, season).push({ r: result, m: margin, date });
  }
}

// ---------------------------------------------------------------- main pass

const FEATURE_NAMES = [
  "eloD", // elo-mov rating diff (no hfa)
  "glickoD",
  "srsM", // ridge margin prediction (incl fitted hfa)
  "offdefM",
  "btL", // bradley-terry logit (incl hfa)
  "pythagD",
  "wpD",
  "l10D",
  "net15D",
  "restH",
  "restA",
  "b2bH",
  "b2bA",
  "gd4D",
  "playoff",
  "noFans",
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
  p538: number | null;
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

  const past: (PastGame & { result: number })[] = [];
  let lastFit = -Infinity;
  const rows: Row[] = [];

  // ridge families only need fits once their window can reach scored games
  const FIT_FROM = Date.parse("2004-06-01") / 86400000;

  for (const g of games) {
    const t = Date.parse(g.date) / 86400000;
    if (t >= FIT_FROM && t - lastFit >= cfg.srs.refitDays && past.length > 200) {
      srs.fit(past, t);
      offdef.fit(past, t);
      bt.fit(past, t);
      lastFit = t;
    }

    if (g.scored) {
      const pEloB = eloB.prob(g.home, g.away, g.season, g.neutral);
      const pEloM = eloM.prob(g.home, g.away, g.season, g.neutral);
      // elo-rest: eloMov with schedule bumps in rating points
      const fH = form.features(g.home, g.season, g.date);
      const fA = form.features(g.away, g.season, g.date);
      const b2bH = g.restH === 0 ? 1 : 0;
      const b2bA = g.restA === 0 ? 1 : 0;
      const restBump =
        cfg.eloRest.b2b * (b2bA - b2bH) +
        cfg.eloRest.restPt * (Math.min(g.restH, 3) - Math.min(g.restA, 3));
      const eloDiffRest =
        eloM.rating(g.home) - eloM.rating(g.away) + (g.neutral ? 0 : cfg.eloMov.hfa) + restBump;
      const pEloR = 1 / (1 + Math.pow(10, -eloDiffRest / 400));
      const pGlicko = glicko.prob(g.home, g.away, g.season, g.neutral);
      const pPythag = pythag.prob(g.home, g.away, g.season, g.neutral);
      const srsM = srs.fitted ? srs.margin(g.home, g.away, g.neutral) : 0;
      const odM = offdef.fitted ? offdef.margin(g.home, g.away, g.neutral) : 0;
      // pace-adjusted margin sd: faster expected pace → wider margins
      let paceRatio = 1;
      if (offdef.fitted) {
        const { eh, ea } = offdef.points(g.home, g.away, g.neutral);
        paceRatio = Math.sqrt(Math.max(0.6, (eh + ea) / offdef.avgTotal()));
      }
      const btL = bt.fitted ? bt.logitDiff(g.home, g.away, g.neutral) : 0;

      const noFans = g.date >= NO_FANS_START && g.date <= NO_FANS_END ? 1 : 0;
      const feats = [
        eloM.rating(g.home) - eloM.rating(g.away),
        glicko.rating(g.home) - glicko.rating(g.away),
        srsM,
        odM,
        btL,
        logit(pythag.expectation(g.home, g.season)) - logit(pythag.expectation(g.away, g.season)),
        fH.wp - fA.wp,
        fH.l10 - fA.l10,
        fH.net15 - fA.net15,
        g.restH,
        g.restA,
        b2bH,
        b2bA,
        fH.gd4 - fA.gd4,
        g.playoff,
        noFans,
        g.neutral,
      ];

      rows.push({
        date: g.date,
        season: g.season,
        playoff: g.playoff,
        y: g.hs > g.as ? 1 : 0,
        margin: g.hs - g.as,
        mlH: g.mlH,
        mlA: g.mlA,
        spread: g.spread,
        p538: g.p538,
        probs: {
          "elo-basic": pEloB,
          "elo-mov": pEloM,
          "elo-rest": pEloR,
          glicko2: pGlicko,
          pythag: pPythag,
          "srs-normal": normCdf(srsM / cfg.srs.sigma),
          "offdef-pace": normCdf(odM / (cfg.offdef.sigma * paceRatio)),
          "bradley-terry": sigmoid(btL),
        },
        feats,
      });
    }

    // updates (after prediction)
    const result = g.hs > g.as ? 1 : 0;
    const margin = g.hs - g.as;
    eloB.update(g.home, g.away, g.season, result, margin, g.neutral);
    eloM.update(g.home, g.away, g.season, result, margin, g.neutral);
    glicko.update(g.home, g.away, g.season, result, g.neutral);
    pythag.update(g.home, g.season, g.hs, g.as);
    pythag.update(g.away, g.season, g.as, g.hs);
    form.update(g.home, g.season, g.date, result, margin);
    form.update(g.away, g.season, g.date, 1 - result, -margin);
    past.push({
      t: Date.parse(g.date) / 86400000,
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
    if (train.length < 1000) continue;

    const X = train.map((r) => r.feats);
    const y = train.map((r) => r.y);
    const std = fitStandardizer(X);
    const Xs = X.map((x) => applyStandardizer(std, x));

    const beta = logisticFit(Xs, y, cfg.logit.l2);
    const gbm = new GbmModel(cfg.gbm);
    gbm.fit(Xs, y);
    const mlp = new MlpModel(cfg.mlp);
    mlp.fit(Xs, y);

    // + market-logit feature variant (only games with a moneyline)
    const trainM = train.filter((r) => r.mlH !== null && r.mlA !== null);
    const XM = trainM.map((r) => [...r.feats, logit(devig(r.mlH!, r.mlA!))]);
    const stdM = fitStandardizer(XM);
    const betaM = logisticFit(
      XM.map((x) => applyStandardizer(stdM, x)),
      trainM.map((r) => r.y),
      cfg.logit.l2,
    );

    for (const r of testRows) {
      const xs = applyStandardizer(std, r.feats);
      r.probs["logit-wf"] = logisticPredict(beta, xs);
      r.probs["gbm-wf"] = gbm.predict(xs);
      r.probs["mlp-wf"] = mlp.predict(xs);
      if (r.mlH !== null && r.mlA !== null) {
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
    if (r.p538 !== null) r.probs["538-elo"] = r.p538;
  }
}

function addEnsembles(rows: Row[], members: string[]) {
  for (const r of rows) {
    const ps = members.map((m) => r.probs[m]).filter((p) => p !== undefined);
    if (ps.length === members.length)
      r.probs["ens-avg"] = sigmoid(ps.reduce((a, p) => a + logit(p), 0) / ps.length);
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
    const met = metrics(sr);
    out.push({ model: m, ...met });
  }
  out.sort((a, b) => a.brier - b.brier);
  for (const o of out)
    console.log(
      `${o.model.padEnd(16)} ${pad(o.n, 6)} ${pad(fmtPct(o.acc), 7)} ${pad(o.brier.toFixed(4), 8)} ${pad(o.logLoss.toFixed(4), 8)}`,
    );
  return out;
}

// --------------------------------------------------------------- edge tests

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
  const r1 = h1.reduce((a, b) => a + b, 0) / h1.length;
  const r2 = h2.reduce((a, b) => a + b, 0) / h2.length;
  return { n: rets.length, roi, lo, hi, r1, r2 };
}

// -------------------------------------------------------------------- tune

function tuneEngines(games: Game[]) {
  console.log("== engine grids (dev Brier; walk-forward replays) ==");
  const devBrier = (probFn: (g: Game) => number | null) => {
    let s = 0;
    let n = 0;
    for (const g of games) {
      if (!g.scored || !DEV_SEASONS.has(g.season)) continue;
      const p = probFn(g);
      if (p === null) continue;
      s += (p - (g.hs > g.as ? 1 : 0)) ** 2;
      n++;
    }
    return s / n;
  };

  // Elo grids (basic + mov share the replay machinery)
  for (const mov of [false, true]) {
    let best = { k: 0, hfa: 0, carry: 0, brier: 1 };
    for (const k of mov ? [4, 6, 8, 12] : [12, 16, 20, 24])
      for (const hfa of [60, 80, 100])
        for (const carry of [0.4, 0.5, 0.6, 0.75]) {
          const elo = new EloEngine({ k, hfa, mov, carry, mean: 1505, init: 1300 });
          let s = 0;
          let n = 0;
          for (const g of games) {
            const p = elo.prob(g.home, g.away, g.season, g.neutral);
            if (g.scored && DEV_SEASONS.has(g.season)) {
              s += (p - (g.hs > g.as ? 1 : 0)) ** 2;
              n++;
            }
            elo.update(g.home, g.away, g.season, g.hs > g.as ? 1 : 0, g.hs - g.as, g.neutral);
          }
          const brier = s / n;
          if (brier < best.brier) best = { k, hfa, carry, brier };
        }
    console.log(`elo${mov ? "-mov" : "-basic"} best:`, best);
  }

  // elo-rest bumps: replay the frozen elo-mov once, then grid the schedule
  // bumps post-hoc (they do not feed back into the ratings)
  {
    const elo = new EloEngine(FROZEN.eloMov);
    const recs: { diff: number; b2b: number; restT: number; y: number }[] = [];
    for (const g of games) {
      if (g.scored && DEV_SEASONS.has(g.season)) {
        elo.prob(g.home, g.away, g.season, g.neutral); // season carry
        recs.push({
          diff: elo.rating(g.home) - elo.rating(g.away) + (g.neutral ? 0 : FROZEN.eloMov.hfa),
          b2b: (g.restA === 0 ? 1 : 0) - (g.restH === 0 ? 1 : 0),
          restT: Math.min(g.restH, 3) - Math.min(g.restA, 3),
          y: g.hs > g.as ? 1 : 0,
        });
      }
      elo.update(g.home, g.away, g.season, g.hs > g.as ? 1 : 0, g.hs - g.as, g.neutral);
    }
    let best = { b2b: 0, restPt: 0, brier: 1 };
    for (const b2b of [0, 25, 45, 70])
      for (const restPt of [0, 8, 16]) {
        let s = 0;
        for (const r of recs) {
          const p = 1 / (1 + Math.pow(10, -(r.diff + b2b * r.b2b + restPt * r.restT) / 400));
          s += (p - r.y) ** 2;
        }
        const brier = s / recs.length;
        if (brier < best.brier) best = { b2b, restPt, brier };
      }
    console.log("elo-rest bumps best:", best);
  }

  // Glicko grid
  {
    let best: Record<string, number> = { brier: 1 };
    for (const tau of [0.5, 0.8])
      for (const rd0 of [60, 80, 100, 150])
        for (const hfa of [60, 80, 100])
          for (const inflate of [50, 80, 120]) {
            const gl = new Glicko2Engine({ tau, rd0, sigma0: 0.06, hfa, inflate });
            let s = 0;
            let n = 0;
            for (const g of games) {
              const p = gl.prob(g.home, g.away, g.season, g.neutral);
              if (g.scored && DEV_SEASONS.has(g.season)) {
                s += (p - (g.hs > g.as ? 1 : 0)) ** 2;
                n++;
              }
              gl.update(g.home, g.away, g.season, g.hs > g.as ? 1 : 0, g.neutral);
            }
            const brier = s / n;
            if (brier < best.brier) best = { tau, rd0, hfa, inflate, brier };
          }
    console.log("glicko2 best:", best);
  }

  // Pythag grid
  {
    let best: Record<string, number> = { brier: 1 };
    for (const exponent of [12, 14, 16, 18, 20])
      for (const priorGames of [5, 10, 15])
        for (const homeLogit of [0.3, 0.38, 0.46, 0.54]) {
          const py = new PythagTracker({ exponent, priorGames, leagueAvgPts: 104, homeLogit });
          let s = 0;
          let n = 0;
          for (const g of games) {
            const p = py.prob(g.home, g.away, g.season, g.neutral);
            if (g.scored && DEV_SEASONS.has(g.season)) {
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

  // Ridge families: λ × halflife (σ fit post-hoc per config).
  // offdef differs from srs only through the pace-adjusted σ.
  for (const fam of ["srs", "offdef", "bt"] as const) {
    let best: Record<string, number> = { brier: 1 };
    for (const lambda of [0.5, 1, 2, 4, 8])
      for (const halflifeDays of [60, 90, 120, 180]) {
        const cfgRidge = { lambda, halflifeDays, windowDays: 1200, refitDays: 14 };
        const eng =
          fam === "srs"
            ? new RidgeMargin(cfgRidge)
            : fam === "offdef"
              ? new OffDefRidge(cfgRidge)
              : new BradleyTerry({ l2: lambda, halflifeDays, windowDays: 1200 });
        const past: (PastGame & { result: number })[] = [];
        let lastFit = -Infinity;
        const FIT_FROM = Date.parse("2004-06-01") / 86400000;
        const preds: { v: number; ratio: number; y: number }[] = [];
        for (const g of games) {
          const t = Date.parse(g.date) / 86400000;
          if (t >= FIT_FROM && t - lastFit >= 14 && past.length > 200) {
            (eng as { fit: (g: typeof past, t: number) => void }).fit(past, t);
            lastFit = t;
          }
          if (g.scored && DEV_SEASONS.has(g.season) && (eng as RidgeMargin).fitted) {
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
            result: g.hs > g.as ? 1 : 0,
          });
        }
        let brier: number;
        let sigmaBest = 0;
        if (fam === "bt") {
          brier = preds.reduce((a, p) => a + (p.v - p.y) ** 2, 0) / preds.length;
        } else {
          brier = 1;
          for (let sig = 9; sig <= 14.01; sig += 0.25) {
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
    for (let sig = 9; sig <= 14.01; sig += 0.25) {
      let s = 0;
      let n = 0;
      for (const g of games) {
        if (!g.scored || !DEV_SEASONS.has(g.season) || g.spread === null) continue;
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
      if (train.length < 1000) continue;
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
    return m.brier;
  };

  for (const l2 of [1, 5, 20])
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
 *  frozen number): spread-σ drift, naive pocket ROIs, pick flips vs the
 *  spread, home-rate drift, and dev-fit logistic coefficients. */
function diagnostics(rows: Row[]) {
  const testRows = rows.filter((r) => TEST_SEASONS.has(r.season));
  const devRows = rows.filter((r) => DEV_SEASONS.has(r.season));

  console.log("### diagnostics");
  console.log(
    `home rate: dev ${fmtPct(devRows.reduce((a, r) => a + r.y, 0) / devRows.length, 2)}  test ${fmtPct(testRows.reduce((a, r) => a + r.y, 0) / testRows.length, 2)}`,
  );

  // spread-σ: dev-fit vs test-optimal (drift diagnostic)
  for (const [label, rws] of [
    ["dev", devRows],
    ["test", testRows],
  ] as const) {
    let best = { sigma: 0, brier: 1 };
    for (let sig = 9; sig <= 15.01; sig += 0.25) {
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

  // naive pockets at real prices (test)
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

  // pick agreement vs the closing spread (test)
  for (const m of ["elo-rest", "ens-cal", "gbm-wf"]) {
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

  // dev-fit logistic coefficients (standardized) — what the stacker uses
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
  "elo-rest",
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
  "538-elo",
];

function main() {
  const mode = process.argv[2] ?? "";
  const games = loadCorpus();
  console.log(
    `corpus: ${games.length} games (${games.filter((g) => g.scored).length} scored, odds era)`,
  );

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

  // home-const: dev home rate, frozen
  const devHome = rows.filter((r) => DEV_SEASONS.has(r.season));
  const homeRate = devHome.reduce((a, r) => a + r.y, 0) / devHome.length;
  for (const r of rows) r.probs["home-const"] = homeRate;
  console.log(`home-const rate (dev): ${fmtPct(homeRate, 2)}`);

  // ensemble of dev-selected diverse members, then dev-fit temperatures,
  // then the calibrated ensemble and its market blend
  addEnsembles(rows, ["elo-rest", "srs-normal", "gbm-wf"]);
  for (const m of ["elo-mov", "elo-rest", "srs-normal", "gbm-wf", "logit-wf", "ens-avg"]) {
    const a = fitTemperature(scoredRows(rows, m, DEV_SEASONS));
    FROZEN.temperature[m] = a;
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

  // ---- report tables
  table(rows, MODELS, DEV_SEASONS, "DEV seasons 2008–2019");
  table(rows, MODELS, TEST_SEASONS, "TEST seasons 2020–2026 (frozen)");

  // per-season Brier for key models
  console.log("\n### per-season Brier (key models)");
  const key = ["elo-rest", "srs-normal", "gbm-wf", "ens-cal", "market-ml"];
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

  // calibration (test) for ens-cal and market
  for (const m of ["ens-avg", "ens-cal", "market-ml"]) {
    console.log(`\n### calibration — ${m} (test)`);
    for (const b of calibrationTable(scoredRows(rows, m, TEST_SEASONS)))
      console.log(
        `${b.bucket}  n=${pad(b.n, 5)}  claimed=${fmtPct(b.claimed)}  actual=${fmtPct(b.actual)}`,
      );
  }

  // 538 comparison on the overlap subset
  const overlap = rows.filter((r) => r.p538 !== null);
  if (overlap.length) {
    const seasonsIn = new Set(overlap.map((r) => r.season));
    console.log(
      `\n### 538 overlap subset (${overlap.length} games, seasons ${[...seasonsIn].sort().join(",")})`,
    );
    for (const m of ["538-elo", "elo-mov", "elo-rest", "ens-cal", "market-ml"]) {
      const sr = overlap
        .filter((r) => r.probs[m] !== undefined)
        .map((r) => ({ y: r.y, p: r.probs[m] }));
      if (!sr.length) continue;
      const met = metrics(sr);
      console.log(
        `${m.padEnd(12)} n=${pad(met.n, 6)} acc=${fmtPct(met.acc)} brier=${met.brier.toFixed(4)}`,
      );
    }
  }

  // blend weight sweep on dev (reported for transparency; frozen w in FROZEN)
  console.log("\n### blend w sweep (ens-cal × market-ml, dev)");
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

  // edge tests (test window)
  console.log("\n### flat-bet edge tests vs the moneyline (test seasons)");
  for (const m of ["ens-cal", "elo-rest", "gbm-wf", "logit+mkt-wf"]) {
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
