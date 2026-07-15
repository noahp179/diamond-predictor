// mlb-dixon-coles.ts — the Poisson "goal simulator" (Dixon-Coles), ported from
// soccer to baseball with the two parts baseball actually demands:
//   • a starting-pitcher quality multiplier on each side's scoring rate
//     (regressed runs-per-out from the starter's game logs, exponent γ), and
//   • negative-binomial scoring instead of pure Poisson — baseball runs are
//     overdispersed (variance ≈ 2× mean), which Poisson can't express.
//
// Team attack/defense strengths are refit walk-forward on every date using only
// results BEFORE that date (fetchSeasonResults is exclusive of `date`), so a
// prediction never sees its own game. The knobs are frozen from the Round 11a
// dev study (scripts/analyze-round11-poisson.ts): NB(r=8), starter γ=1.5, no
// time decay, and a confidence temperature a=0.30. This is the production port
// of the best analytic model of the program — 57.2% / 0.2480 Brier on the
// frozen test window — and it runs in milliseconds with no Monte Carlo.

import { fetchSeasonResults, type SeasonGameResult } from "./mlb-sim";
import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { MODEL_VERSION_DIXON } from "./mlb-models";

export { MODEL_VERSION_DIXON };

// ─── Frozen knobs (Round 11a dev selection) ──────────────────────────────────
const NB_R = 8; // negative-binomial dispersion (variance = λ(1 + λ/r))
const STARTER_GAMMA = 1.5; // exponent on the starter runs-per-out ratio
const TEMPERATURE = 0.3; // confidence shrink: p' = σ(a · logit(p))
/** Minimum season games required before the walk-forward fit is trusted. */
const MIN_FIT_GAMES = 150;
/** League runs per out (≈ per-team runs/game ÷ 27 outs). */
const LEAGUE_RPO = 4.6 / 27;
/** Regression prior (outs) applied to a starter's runs-per-out. */
const STARTER_PRIOR_OUTS = 90;
/** A starter needs at least this many recorded outs before we trust the ratio. */
const STARTER_MIN_OUTS = 30;

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

export interface DixonColesPrediction {
  gameId: number;
  date: string;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  /** Home win probability, temperature-calibrated (the headline number). */
  homeWinProb: number;
  /** Expected home/away runs from the fitted attack/defense + starter model. */
  homeLambda: number;
  awayLambda: number;
  rationale: string[];
}

// ─── Attack/defense Poisson-MLE fit (the mean structure both dists share) ─────

interface DCFit {
  mu: number;
  hfa: number;
  att: Map<number, number>;
  def: Map<number, number>;
}

/**
 * Gradient-ascent fit of a log-linear attack/defense scoring model:
 *   λ_home = exp(μ + hfa + att[home] − def[away])
 *   λ_away = exp(μ + att[away] − def[home])
 * No time decay (ξ = 0, the selected setting), so every game weighs equally.
 */
function fitDC(results: SeasonGameResult[]): DCFit {
  const teams = new Set<number>();
  for (const r of results) {
    teams.add(r.home);
    teams.add(r.away);
  }
  const att = new Map<number, number>();
  const def = new Map<number, number>();
  for (const t of teams) {
    att.set(t, 0);
    def.set(t, 0);
  }
  let mu = Math.log(4.5);
  let hfa = 0.02;
  const lr = 0.06;
  const N = results.length;
  for (let it = 0; it < 350; it++) {
    const gA = new Map<number, number>();
    const gD = new Map<number, number>();
    for (const t of teams) {
      gA.set(t, 0);
      gD.set(t, 0);
    }
    let gMu = 0;
    let gH = 0;
    for (const r of results) {
      const lh = Math.exp(mu + hfa + att.get(r.home)! - def.get(r.away)!);
      const la = Math.exp(mu + att.get(r.away)! - def.get(r.home)!);
      const eh = r.homeScore - lh;
      const ea = r.awayScore - la;
      gMu += eh + ea;
      gH += eh;
      gA.set(r.home, gA.get(r.home)! + eh);
      gD.set(r.away, gD.get(r.away)! - eh);
      gA.set(r.away, gA.get(r.away)! + ea);
      gD.set(r.home, gD.get(r.home)! - ea);
    }
    mu += (lr * gMu) / (2 * N);
    hfa += (lr * gH) / N;
    let mA = 0;
    let mD = 0;
    for (const t of teams) {
      att.set(t, att.get(t)! + (lr * gA.get(t)!) / N);
      def.set(t, def.get(t)! + (lr * gD.get(t)!) / N);
      mA += att.get(t)!;
      mD += def.get(t)!;
    }
    // Re-center so attack/defense are identifiable (mean zero each iteration).
    const cA = mA / teams.size;
    const cD = mD / teams.size;
    for (const t of teams) {
      att.set(t, att.get(t)! - cA);
      def.set(t, def.get(t)! - cD);
    }
  }
  return { mu, hfa, att, def };
}

// ─── Negative-binomial scoring distribution ──────────────────────────────────

const N_MAX = 30;
/** Negative binomial with mean λ and dispersion r (variance λ(1 + λ/r)). */
function nbPmf(lambda: number, r: number): number[] {
  const p = r / (r + lambda);
  const out = new Array<number>(N_MAX);
  out[0] = Math.pow(p, r);
  for (let k = 1; k < N_MAX; k++) out[k] = out[k - 1] * ((k - 1 + r) / k) * (1 - p);
  return out;
}

/**
 * Home win probability from two independent NB run distributions. Ties (extra
 * innings) are split slightly toward the home team (0.52), matching the study.
 */
function nbWinProb(lh: number, la: number): number {
  const ph = nbPmf(lh, NB_R);
  const pa = nbPmf(la, NB_R);
  let win = 0;
  let tie = 0;
  for (let h = 0; h < N_MAX; h++) {
    for (let a = 0; a < N_MAX; a++) {
      const q = ph[h] * pa[a];
      if (h > a) win += q;
      else if (h === a) tie += q;
    }
  }
  return win + tie * 0.52;
}

// ─── Starter runs-per-out, point-in-time from game logs ──────────────────────

interface StartLog {
  date: string;
  gs: number;
  outs: number;
  runs: number;
}

async function fetchStarterGameLog(personId: number, season: number): Promise<StartLog[]> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) return [];
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    return splits.map((s) => {
      const st = s.stat ?? {};
      const ip = String(st.inningsPitched ?? "0.0").split(".");
      return {
        date: s.date ?? "",
        gs: st.gamesStarted ?? 0,
        outs: (parseInt(ip[0], 10) || 0) * 3 + (ip[1] ? parseInt(ip[1], 10) : 0),
        runs: st.runs ?? 0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * A starter's regressed runs-per-out entering `date`, relative to league (1.0 =
 * league average, <1 = better than average, suppresses the opposing offense).
 * Uses only starts strictly before `date`. Returns 1 (no adjustment) when the
 * pitcher is unknown or has too little sample.
 */
function starterFactor(log: StartLog[] | undefined, date: string): number {
  if (!log || log.length === 0) return 1;
  let outs = 0;
  let runs = 0;
  for (const a of log) {
    if (a.date >= date || a.gs <= 0) continue;
    outs += a.outs;
    runs += a.runs;
  }
  if (outs < STARTER_MIN_OUTS) return 1;
  const rpo = (runs + LEAGUE_RPO * STARTER_PRIOR_OUTS) / (outs + STARTER_PRIOR_OUTS);
  return rpo / LEAGUE_RPO;
}

// ─── Public build entry point ────────────────────────────────────────────────

/**
 * Predictions for `date` from the Dixon-Coles negative-binomial model with the
 * starter multiplier. Returns [] when the season has too few games to fit
 * (early season) or the schedule is empty — the pipeline simply records no
 * Poisson rows that day, exactly like any other model that can't run.
 */
export async function buildDixonColesPredictionsForDate(
  date: string,
): Promise<DixonColesPrediction[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher,team&startDate=${date}&endDate=${date}`;
  const [scheduleRes, seasonResults] = await Promise.all([
    fetchWithTimeout(scheduleUrl),
    fetchSeasonResults(season, date), // strictly before `date` — walk-forward safe
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];
  if (seasonResults.length < MIN_FIT_GAMES) return [];

  const fit = fitDC(seasonResults);

  // Point-in-time starter game logs for every probable on the slate.
  const pitcherIds = new Set<number>();
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }
  const logById = new Map<number, StartLog[]>();
  await batchedAll(
    Array.from(pitcherIds).map((id) => async () => {
      logById.set(id, await fetchStarterGameLog(id, season));
    }),
    8,
  );

  const out: DixonColesPrediction[] = [];
  for (const g of games) {
    const home = g.teams?.home?.team;
    const away = g.teams?.away?.team;
    if (!home || !away) continue;
    if (!fit.att.has(home.id) || !fit.att.has(away.id)) continue; // unseen team, no fit

    const hp = g.teams?.home?.probablePitcher?.id ?? null;
    const ap = g.teams?.away?.probablePitcher?.id ?? null;
    // The home offense faces the AWAY starter, and vice-versa.
    const fHome = starterFactor(ap ? logById.get(ap) : undefined, date);
    const fAway = starterFactor(hp ? logById.get(hp) : undefined, date);

    const lh0 = Math.exp(fit.mu + fit.hfa + fit.att.get(home.id)! - fit.def.get(away.id)!);
    const la0 = Math.exp(fit.mu + fit.att.get(away.id)! - fit.def.get(home.id)!);
    const lh = lh0 * Math.pow(fHome, STARTER_GAMMA);
    const la = la0 * Math.pow(fAway, STARTER_GAMMA);

    const raw = nbWinProb(lh, la);
    const cal = sigmoid(TEMPERATURE * logit(clamp01(raw)));

    out.push({
      gameId: g.gamePk,
      date: g.gameDate,
      homeId: home.id,
      awayId: away.id,
      homeName: home.name,
      awayName: away.name,
      homeWinProb: cal,
      homeLambda: lh,
      awayLambda: la,
      rationale: [
        `Dixon-Coles fit on ${seasonResults.length} season games → expected runs ${lh.toFixed(2)} (home) vs ${la.toFixed(2)} (away)`,
        `Starter multipliers γ=${STARTER_GAMMA}: home offense ×${fHome.toFixed(2)}, away offense ×${fAway.toFixed(2)} (regressed runs/out vs league)`,
        `Negative-binomial (r=${NB_R}) win prob ${(raw * 100).toFixed(1)}% → calibrated ${(cal * 100).toFixed(1)}% (temperature a=${TEMPERATURE})`,
      ],
    });
  }
  return out;
}
