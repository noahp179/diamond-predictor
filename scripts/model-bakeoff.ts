#!/usr/bin/env -S npx tsx
/**
 * model-bakeoff.ts — "try everything." A broad tournament of prediction
 * strategies for NBA and NFL, ranked purely by winning percentage.
 *
 *   npx tsx scripts/model-bakeoff.ts [nba|nfl|both]
 *
 * Two kinds of strategy are scored:
 *   • FULL      — commits a pick on every game. Accuracy = picks that won.
 *   • SELECTIVE — only picks games that meet a conviction rule (agreement,
 *                 confidence, etc.). Reported with COVERAGE (share of games it
 *                 acts on) alongside accuracy — this is the real "maximize my
 *                 chances" lever: pick fewer games, hit a higher rate.
 *
 * Everything runs walk-forward over the cached odds datasets (no lookahead;
 * fitted layers refit per season on prior seasons only). Rating engines are the
 * research-tuned ones in scripts/lib-zoo.ts. Reference points: the market
 * (devigged moneyline favorite) and the closing spread.
 */

import { readFileSync } from "node:fs";

import {
  BradleyTerry,
  EloEngine,
  Glicko2Engine,
  GbmModel,
  OffDefRidge,
  PastGame,
  PythagTracker,
  RidgeMargin,
  applyStandardizer,
  devig,
  fitStandardizer,
  logisticFit,
  logisticPredict,
  logit,
  normCdf,
  sigmoid,
} from "./lib-zoo";

type Sport = "nba" | "nfl";

type Raw = {
  date: string;
  season: number;
  home: string;
  away: string;
  hs: number;
  as: number;
  spread: number | null;
  mlH: number | null;
  mlA: number | null;
  restH: number;
  restA: number;
  neutral?: number;
  div?: number;
  playoff?: number;
};

// ---- per-sport tuned configs (from NBA-NFL-ANALYSIS.md FROZEN blocks) ----
const CFG = {
  nba: {
    eloMov: { k: 8, hfa: 80, mov: true, carry: 0.75, mean: 1505, init: 1300 },
    eloBasic: { k: 20, hfa: 80, mov: false, carry: 0.6, mean: 1505, init: 1300 },
    eloFast: { k: 28, hfa: 80, mov: true, carry: 0.4, mean: 1505, init: 1300 },
    eloSlow: { k: 4, hfa: 80, mov: true, carry: 0.9, mean: 1505, init: 1300 },
    glicko: { tau: 0.5, rd0: 100, sigma0: 0.06, hfa: 80, inflate: 80 },
    pythag: { exponent: 16, priorGames: 10, leagueAvgPts: 104, homeLogit: 0.46 },
    ridge: { lambda: 4, halflifeDays: 90, windowDays: 1200, refitDays: 14 },
    bt: { l2: 1, halflifeDays: 90, windowDays: 1200 },
    srsSigma: 10.25,
    spreadSigma: 11,
    restBumpB2b: 25, // rating pts for a back-to-back disadvantage
    blendW: 0.9,
  },
  nfl: {
    eloMov: { k: 20, hfa: 55, mov: true, carry: 0.5, mean: 1505, init: 1300 },
    eloBasic: { k: 40, hfa: 55, mov: false, carry: 0.6, mean: 1505, init: 1300 },
    eloFast: { k: 34, hfa: 55, mov: true, carry: 0.35, mean: 1505, init: 1300 },
    eloSlow: { k: 10, hfa: 55, mov: true, carry: 0.7, mean: 1505, init: 1300 },
    glicko: { tau: 0.5, rd0: 100, sigma0: 0.06, hfa: 65, inflate: 90 },
    pythag: { exponent: 3.4, priorGames: 8, leagueAvgPts: 22, homeLogit: 0.35 },
    ridge: { lambda: 2, halflifeDays: 150, windowDays: 1500, refitDays: 7 },
    bt: { l2: 1, halflifeDays: 200, windowDays: 1500 },
    srsSigma: 14.25,
    spreadSigma: 12,
    restBumpB2b: 35, // short-week disadvantage
    blendW: 0.8,
  },
} as const;

function load(sport: Sport): Raw[] {
  const file = sport === "nba" ? "nba-games.jsonl" : "nfl-games.jsonl";
  return readFileSync(`.backtest-cache/${file}`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Raw)
    .filter((r) => Number.isFinite(r.hs) && Number.isFinite(r.as) && r.hs !== r.as)
    .sort((a, b) => a.date.localeCompare(b.date) || a.home.localeCompare(b.home));
}

// -------------------------------------------------- season form tracking

class Form {
  private res = new Map<string, number[]>(); // team|season -> 1/0 results in order
  private key(t: string, s: number) {
    return `${t}|${s}`;
  }
  winPct(t: string, s: number) {
    const l = this.res.get(this.key(t, s)) ?? [];
    return (l.reduce((a, b) => a + b, 0) + 4 * 0.5) / (l.length + 4);
  }
  last(t: string, s: number, n: number) {
    const l = this.res.get(this.key(t, s)) ?? [];
    const w = l.slice(-n);
    return (w.reduce((a, b) => a + b, 0) + 2 * 0.5) / (w.length + 2);
  }
  streak(t: string, s: number) {
    const l = this.res.get(this.key(t, s)) ?? [];
    if (!l.length) return 0;
    let k = 0;
    const last = l[l.length - 1];
    for (let i = l.length - 1; i >= 0 && l[i] === last; i--) k++;
    return last === 1 ? k : -k;
  }
  push(t: string, s: number, r: number) {
    const key = this.key(t, s);
    const l = this.res.get(key) ?? [];
    l.push(r);
    this.res.set(key, l);
  }
}

// ----------------------------------------------------- the walk-forward pass

type G = {
  season: number;
  date: string;
  result: number; // 1 home win
  probs: Record<string, number>; // model P(home) by name
  market: number | null;
  spread: number | null; // Φ(spread/σ) P(home)
  // features
  restEdge: number; // restH - restA
  b2bH: number;
  b2bA: number;
  formEdge: number; // home last10 - away last10
  wpEdge: number; // season win% edge
  streakEdge: number;
  feat: number[]; // standardizable feature vector for the stacker
};

function replay(sport: Sport, rows: Raw[]): G[] {
  const c = CFG[sport];
  const elo = new EloEngine(c.eloMov);
  const eloB = new EloEngine(c.eloBasic);
  const eloF = new EloEngine(c.eloFast);
  const eloS = new EloEngine(c.eloSlow);
  const glicko = new Glicko2Engine(c.glicko);
  const pythag = new PythagTracker(c.pythag);
  const srs = new RidgeMargin(c.ridge);
  const offdef = new OffDefRidge(c.ridge);
  const bt = new BradleyTerry({
    l2: c.bt.l2,
    halflifeDays: c.bt.halflifeDays,
    windowDays: c.ridge.windowDays,
  });
  const form = new Form();

  const past: (PastGame & { result: number })[] = [];
  let lastFit = -Infinity;
  const out: G[] = [];

  for (const g of rows) {
    const t = Date.parse(g.date) / 86400000;
    const neutral = g.neutral ?? 0;
    if (t - lastFit >= c.ridge.refitDays && past.length > 200) {
      srs.fit(past, t);
      offdef.fit(past, t);
      bt.fit(past, t);
      lastFit = t;
    }

    const pElo = elo.prob(g.home, g.away, g.season, neutral);
    const pEloB = eloB.prob(g.home, g.away, g.season, neutral);
    const pEloF = eloF.prob(g.home, g.away, g.season, neutral);
    const pEloS = eloS.prob(g.home, g.away, g.season, neutral);
    const pGlicko = glicko.prob(g.home, g.away, g.season, neutral);
    const pPythag = pythag.prob(g.home, g.away, g.season, neutral);
    const srsM = srs.fitted ? srs.margin(g.home, g.away, neutral) : 0;
    const odM = offdef.fitted ? offdef.margin(g.home, g.away, neutral) : 0;
    let paceRatio = 1;
    if (offdef.fitted) {
      const { eh, ea } = offdef.points(g.home, g.away, neutral);
      paceRatio = Math.sqrt(Math.max(0.6, (eh + ea) / Math.max(1, offdef.avgTotal())));
    }
    const pBt = bt.fitted ? bt.prob(g.home, g.away, neutral) : 0.5;

    // rest / schedule
    const b2bH = g.restH <= (sport === "nba" ? 0 : 5) ? 1 : 0;
    const b2bA = g.restA <= (sport === "nba" ? 0 : 5) ? 1 : 0;
    const restBump = c.restBumpB2b * (b2bA - b2bH);
    const eloDiffRest =
      elo.rating(g.home) - elo.rating(g.away) + (neutral ? 0 : c.eloMov.hfa) + restBump;
    const pEloRest = 1 / (1 + Math.pow(10, -eloDiffRest / 400));

    // multi-timescale elo (fast⊕slow)
    const pMulti = sigmoid((logit(pEloF) + logit(pEloS)) / 2);

    const market = g.mlH != null && g.mlA != null && g.mlH !== g.mlA ? devig(g.mlH, g.mlA) : null;
    const spread = g.spread != null ? normCdf(g.spread / c.spreadSigma) : null;

    const homeWp = form.winPct(g.home, g.season);
    const awayWp = form.winPct(g.away, g.season);
    const homeL10 = form.last(g.home, g.season, 10);
    const awayL10 = form.last(g.away, g.season, 10);
    const homeStreak = form.streak(g.home, g.season);
    const awayStreak = form.streak(g.away, g.season);

    out.push({
      season: g.season,
      date: g.date,
      result: g.hs > g.as ? 1 : 0,
      probs: {
        elo: pElo,
        "elo-basic": pEloB,
        "elo-rest": pEloRest,
        "elo-multiscale": pMulti,
        glicko2: pGlicko,
        pythag: pPythag,
        srs: normCdf(srsM / c.srsSigma),
        "offdef-pace": normCdf(odM / (c.srsSigma * paceRatio)),
        "bradley-terry": pBt,
      },
      market,
      spread,
      restEdge: g.restH - g.restA,
      b2bH,
      b2bA,
      formEdge: homeL10 - awayL10,
      wpEdge: homeWp - awayWp,
      streakEdge: homeStreak - awayStreak,
      feat: [
        logit(pElo),
        logit(pGlicko),
        srsM,
        odM,
        logit(pBt),
        logit(pPythag),
        homeWp - awayWp,
        homeL10 - awayL10,
        homeStreak - awayStreak,
        g.restH - g.restA,
        neutral,
      ],
    });

    // updates
    const result = g.hs > g.as ? 1 : 0;
    const margin = g.hs - g.as;
    elo.update(g.home, g.away, g.season, result, margin, neutral);
    eloB.update(g.home, g.away, g.season, result, margin, neutral);
    eloF.update(g.home, g.away, g.season, result, margin, neutral);
    eloS.update(g.home, g.away, g.season, result, margin, neutral);
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

// -------------------------------------------------- fitted stacker (walk-fwd)

function addStacker(games: G[]) {
  const seasons = [...new Set(games.map((g) => g.season))].sort();
  for (const s of seasons) {
    const train = games.filter((g) => g.season < s);
    const test = games.filter((g) => g.season === s);
    if (train.length < 800) continue;
    const std = fitStandardizer(train.map((g) => g.feat));
    const Xtr = train.map((g) => applyStandardizer(std, g.feat));
    const beta = logisticFit(
      Xtr,
      train.map((g) => g.result),
      5,
    );
    const gbm = new GbmModel({ trees: 100, lr: 0.05, subsample: 0.8, seed: 42, minLeaf: 60 });
    gbm.fit(
      Xtr,
      train.map((g) => g.result),
    );
    for (const g of test) {
      const x = applyStandardizer(std, g.feat);
      g.probs["stack-logistic"] = logisticPredict(beta, x);
      g.probs["stack-gbm"] = gbm.predict(x);
    }
  }
}

// -------------------------------------------------- ensembles

function addEnsembles(games: G[], sport: Sport) {
  const ratingKeys = [
    "elo",
    "elo-rest",
    "srs",
    "offdef-pace",
    "glicko2",
    "bradley-terry",
    "pythag",
  ];
  // trailing accuracy per model for the confidence-weighted ensemble
  const hist: Record<string, { c: number; n: number }> = {};
  for (const k of ratingKeys) hist[k] = { c: 0, n: 0 };

  for (const g of games) {
    // simple logit-mean of the rating models
    const ls = ratingKeys.map((k) => logit(g.probs[k]));
    g.probs["ens-mean"] = sigmoid(ls.reduce((a, b) => a + b, 0) / ls.length);

    // majority vote of rating models + market (+spread)
    const voters = [...ratingKeys.map((k) => g.probs[k])];
    if (g.market != null) voters.push(g.market);
    if (g.spread != null) voters.push(g.spread);
    const homeVotes = voters.filter((p) => p >= 0.5).length;
    g.probs["ens-vote"] = homeVotes / voters.length >= 0.5 ? 0.5 + 1e-6 : 0.5 - 1e-6;

    // confidence-weighted: weight each rating model by its trailing accuracy
    let wsum = 0;
    let lsum = 0;
    for (const k of ratingKeys) {
      const acc = hist[k].n > 50 ? hist[k].c / hist[k].n : 0.5;
      const w = Math.max(0.01, acc - 0.5); // reward above-coin-flip skill
      wsum += w;
      lsum += w * logit(g.probs[k]);
    }
    g.probs["ens-confweighted"] = wsum > 0 ? sigmoid(lsum / wsum) : 0.5;

    // model⊕market blend + consensus
    if (g.market != null) {
      g.probs["blend-market"] = sigmoid(
        (1 - CFG[sport].blendW) * logit(g.probs["elo"]) + CFG[sport].blendW * logit(g.market),
      );
      g.probs["consensus-3"] = sigmoid(
        (logit(g.probs["elo"]) + logit(g.probs["srs"]) + logit(g.market)) / 3,
      );
    }

    // update trailing accuracy AFTER predicting
    for (const k of ratingKeys) {
      hist[k].n++;
      if ((g.probs[k] >= 0.5 ? 1 : 0) === g.result) hist[k].c++;
    }
  }
}

// -------------------------------------------------------------- strategies

type Strat = {
  name: string;
  kind: "full" | "selective";
  group: string;
  // returns P(home) for FULL; for SELECTIVE returns P(home) or null to skip.
  fn: (g: G) => number | null;
};

const conf = (p: number) => Math.max(p, 1 - p);
const side = (p: number) => (p >= 0.5 ? 1 : 0);

function strategies(sport: Sport): Strat[] {
  const S: Strat[] = [];
  const full = (name: string, group: string, fn: (g: G) => number | null) =>
    S.push({ name, kind: "full", group, fn });
  const sel = (name: string, group: string, fn: (g: G) => number | null) =>
    S.push({ name, kind: "selective", group, fn });

  // --- reference ---
  full("market (devig ML)", "reference", (g) => g.market);
  full("closing spread", "reference", (g) => g.spread);

  // --- rating models ---
  for (const k of [
    "elo",
    "elo-basic",
    "elo-rest",
    "elo-multiscale",
    "glicko2",
    "pythag",
    "srs",
    "offdef-pace",
    "bradley-terry",
  ])
    full(k, "rating model", (g) => g.probs[k]);

  // --- ensembles / stackers ---
  for (const k of [
    "ens-mean",
    "ens-vote",
    "ens-confweighted",
    "blend-market",
    "consensus-3",
    "stack-logistic",
    "stack-gbm",
  ])
    full(k, "ensemble", (g) => g.probs[k] ?? null);

  // --- simple heuristics people use ---
  full("always home", "heuristic", () => 0.9);
  full("always favorite (market)", "heuristic", (g) => g.market);
  full("better season record", "heuristic", (g) => (g.wpEdge >= 0 ? 0.6 : 0.4));
  full("hotter last-10", "heuristic", (g) => (g.formEdge >= 0 ? 0.6 : 0.4));
  full("more rest", "heuristic", (g) => (g.restEdge > 0 ? 0.6 : g.restEdge < 0 ? 0.4 : 0.5 + 1e-6));
  full("longer win streak", "heuristic", (g) =>
    g.streakEdge > 0 ? 0.6 : g.streakEdge < 0 ? 0.4 : 0.5 + 1e-6,
  );
  full("home unless road b2b-rested edge", "heuristic", (g) => (g.b2bH && !g.b2bA ? 0.4 : 0.9));

  // --- SELECTIVE conviction strategies (maximize hit rate on a subset) ---
  // model + market agree on the side
  sel("model & market agree", "selective · agreement", (g) =>
    g.market != null && side(g.probs["elo"]) === side(g.market) ? g.probs["elo"] : null,
  );
  // model, spread, market all agree (triple confirmation)
  sel("elo + spread + market agree", "selective · agreement", (g) => {
    if (g.market == null || g.spread == null) return null;
    const s = side(g.probs["elo"]);
    return s === side(g.market) && s === side(g.spread) ? g.probs["elo"] : null;
  });
  // every rating model agrees (unanimous ensemble)
  sel("all rating models agree", "selective · agreement", (g) => {
    const keys = ["elo", "srs", "glicko2", "bradley-terry", "pythag", "offdef-pace"];
    const s0 = side(g.probs[keys[0]]);
    return keys.every((k) => side(g.probs[k]) === s0) ? g.probs["ens-mean"] : null;
  });
  // high model confidence
  for (const th of [0.65, 0.7, 0.75])
    sel(`model conf ≥ ${th}`, "selective · confidence", (g) =>
      conf(g.probs["elo"]) >= th ? g.probs["elo"] : null,
    );
  // heavy market favorites
  for (const th of [0.7, 0.75, 0.8])
    sel(`market favorite ≥ ${th}`, "selective · confidence", (g) =>
      g.market != null && conf(g.market) >= th ? g.market : null,
    );
  // best of both: agree AND market-confident
  for (const th of [0.65, 0.7, 0.75])
    sel(`agree & market conf ≥ ${th}`, "selective · combo", (g) => {
      if (g.market == null) return null;
      if (side(g.probs["elo"]) !== side(g.market)) return null;
      return conf(g.market) >= th ? g.market : null;
    });
  // blended confidence gate (Best Odds page logic)
  for (const th of [0.65, 0.7, 0.75])
    sel(`blend conf ≥ ${th}`, "selective · combo", (g) =>
      g.probs["blend-market"] != null && conf(g.probs["blend-market"]) >= th
        ? g.probs["blend-market"]
        : null,
    );
  // out-of-the-box: agree AND no home-team scheduling disadvantage
  sel("agree & pick not on a rest deficit", "selective · novel", (g) => {
    if (g.market == null) return null;
    const s = side(g.probs["elo"]);
    if (s !== side(g.market)) return null;
    // skip if the side we'd pick is the one on a back-to-back / short week
    const pickIsHome = s === 1;
    if (pickIsHome && g.b2bH && !g.b2bA) return null;
    if (!pickIsHome && g.b2bA && !g.b2bH) return null;
    return g.probs["blend-market"] ?? g.market;
  });
  // novel: market-confident AND model even MORE confident same side ("model confirms sharp")
  sel("market fav ≥ .65 & model more confident", "selective · novel", (g) => {
    if (g.market == null) return null;
    if (conf(g.market) < 0.65) return null;
    if (side(g.probs["elo"]) !== side(g.market)) return null;
    return conf(g.probs["elo"]) >= conf(g.market) ? g.market : null;
  });

  return S;
}

// -------------------------------------------------------------- scoring

function scoreStrat(games: G[], st: Strat) {
  let n = 0;
  let correct = 0;
  for (const g of games) {
    const p = st.fn(g);
    if (p == null) continue;
    n++;
    if (side(p) === g.result) correct++;
  }
  return { n, acc: n ? correct / n : 0, coverage: n / games.length };
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
  const rows = load(sport);
  const games = replay(sport, rows);
  addStacker(games);
  addEnsembles(games, sport);
  // only score on games that have a market line so every strategy is comparable
  const priced = games.filter((g) => g.market != null);
  const seasons = [...new Set(priced.map((g) => g.season))];

  const strats = strategies(sport);
  const marketAcc = scoreStrat(priced, {
    name: "m",
    kind: "full",
    group: "",
    fn: (g) => g.market,
  }).acc;

  console.log(
    `\n############ ${sport.toUpperCase()} — ${priced.length.toLocaleString()} games (${Math.min(...seasons)}–${Math.max(...seasons)}) ############`,
  );
  console.log(`Reference: market favorite wins ${fmt(marketAcc)}% of the time.\n`);

  const scored = strats.map((st) => ({ st, ...scoreStrat(priced, st) }));

  // FULL strategies — ranked by accuracy
  console.log("=== FULL strategies (pick every game) — ranked by win % ===");
  console.log(`${pad("strategy", 34)}${padl("win%", 7)}${padl("Δmkt", 7)}   group`);
  scored
    .filter((s) => s.st.kind === "full" && s.n > 0)
    .sort((a, b) => b.acc - a.acc)
    .forEach((s) =>
      console.log(
        `${pad(s.st.name, 34)}${padl(fmt(s.acc) + "%", 7)}${padl((s.acc >= marketAcc ? "+" : "") + fmt(s.acc - marketAcc, 1), 7)}   ${s.st.group}`,
      ),
    );

  // SELECTIVE strategies — ranked by accuracy, with coverage
  console.log("\n=== SELECTIVE strategies (pick only high-conviction games) — ranked by win % ===");
  console.log(
    `${pad("strategy", 40)}${padl("win%", 7)}${padl("games", 8)}${padl("cover", 7)}   group`,
  );
  scored
    .filter((s) => s.st.kind === "selective" && s.n > 0)
    .sort((a, b) => b.acc - a.acc)
    .forEach((s) =>
      console.log(
        `${pad(s.st.name, 40)}${padl(fmt(s.acc) + "%", 7)}${padl(String(s.n), 8)}${padl(fmt(s.coverage, 0) + "%", 7)}   ${s.st.group}`,
      ),
    );
}

const which = (process.argv[2] ?? "both") as Sport | "both";
console.log("Model bake-off — winning percentage only. Walk-forward, no lookahead.");
if (which === "both" || which === "nba") report("nba");
if (which === "both" || which === "nfl") report("nfl");
console.log(
  "\nNote: FULL strategies commit a pick on every game; SELECTIVE ones only act on games meeting their rule (coverage = share of games picked). Higher selectivity trades volume for hit rate. Market favorite is the reference ceiling.",
);
