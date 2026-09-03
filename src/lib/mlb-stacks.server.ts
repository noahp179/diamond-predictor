/**
 * mlb-stacks.server.ts — the night's biggest offences, and the hitters off
 * those lineups, priced *together*.
 *
 * Two models meet here. The team side is new: a runs regression that ranks the
 * slate and three logistics for the team totals (over 3.5 / 4.5 / 5.5), fitted
 * in research/mlb-stacks and frozen in mlb-stacks-model.json. The hitter side
 * is the 2+ total-bases market the Player Props tab already serves, reused
 * unchanged so a bat is never priced two different ways on two pages.
 *
 * What this module adds is the join. Betting a team total and a hitter off that
 * same lineup as if they were independent understates the pair by 25% — a
 * hitter's total bases *are* part of his team's runs. So legs are combined
 * through a Gaussian copula with two correlations measured on 2024-25 and
 * verified on the 2026 season neither model saw:
 *
 *   hitter x hitter, same lineup   rho = 0.074   (much weaker than folklore)
 *   hitter x his own team's total  rho = 0.361
 *
 * See TEAM-STACKS.md. Every feature is rebuilt live from the same StatsAPI
 * aggregates the trainer used, so the numbers the app computes are the numbers
 * that were backtested:
 *
 *   teams/stats?stats=season&group=hitting|pitching   season-to-date offence
 *   teams/stats?stats=byDateRange                     the trailing 30 days
 *   teams/stats?stats=statSplits&sitCodes=rp          the opponent's bullpen
 *   people?hydrate=stats(season,pitching)             the opposing starter
 *   schedule?hydrate=probablePitcher                  slate, venue, rest
 */
import model from "./mlb-stacks-model.json";
import { PARK_FACTORS } from "./park-factors";
import { propsSlate, type PropPick } from "./mlb-props.server";

const API = "https://statsapi.mlb.com/api/v1";
const C = model.constants;
const LG = C.LG;

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const shrunk = (num: number, den: number, prior: number, k: number) =>
  (num + k * prior) / (den + k);
const parkOf = (venue: string) => (PARK_FACTORS[venue] ?? 100) / 100;
const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ fetching
type Cached<T> = { at: number; v: T };
const cache = new Map<string, Cached<unknown>>();

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  return v;
}

async function getJson(url: string, ms = 20000): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`StatsAPI ${res.status}: ${url}`);
  return res.json();
}

/** Team hitting and pitching lines, over whatever window the caller names. */
type TeamLine = {
  g: number;
  runs: number;
  pa: number;
  ab: number;
  h: number;
  tb: number;
  hr: number;
  bb: number;
  k: number;
  runsAllowed: number;
  allowedG: number;
};
const emptyLine = (): TeamLine => ({
  g: 0,
  runs: 0,
  pa: 0,
  ab: 0,
  h: 0,
  tb: 0,
  hr: 0,
  bb: 0,
  k: 0,
  runsAllowed: 0,
  allowedG: 0,
});

async function fetchTeamLines(
  season: number,
  window: { start: string; end: string } | null,
  key: string,
): Promise<Map<number, TeamLine>> {
  return cached(`stacks:lines:${key}`, 30 * 60_000, async () => {
    const range = window
      ? `stats=byDateRange&startDate=${window.start}&endDate=${window.end}`
      : `stats=season`;
    const m = new Map<number, TeamLine>();
    const get = (id: number) => m.get(id) ?? (m.set(id, emptyLine()), m.get(id)!);
    const [h, p] = await Promise.all([
      getJson(`${API}/teams/stats?${range}&group=hitting&season=${season}&sportIds=1&gameType=R`),
      getJson(`${API}/teams/stats?${range}&group=pitching&season=${season}&sportIds=1&gameType=R`),
    ]);
    for (const s of h?.stats?.[0]?.splits ?? []) {
      const t = get(n(s?.team?.id));
      t.g = n(s?.stat?.gamesPlayed);
      t.runs = n(s?.stat?.runs);
      t.pa = n(s?.stat?.plateAppearances);
      t.ab = n(s?.stat?.atBats);
      t.h = n(s?.stat?.hits);
      t.tb = n(s?.stat?.totalBases);
      t.hr = n(s?.stat?.homeRuns);
      t.bb = n(s?.stat?.baseOnBalls);
      t.k = n(s?.stat?.strikeOuts);
    }
    for (const s of p?.stats?.[0]?.splits ?? []) {
      const t = get(n(s?.team?.id));
      t.runsAllowed = n(s?.stat?.runs);
      t.allowedG = n(s?.stat?.gamesPlayed);
    }
    return m;
  });
}

/** The opponent's bullpen — everything after the starter leaves. */
type Pen = { bf: number; outs: number; er: number; k: number };
async function fetchBullpens(season: number): Promise<Map<number, Pen>> {
  return cached(`stacks:pen:${season}`, 30 * 60_000, async () => {
    const m = new Map<number, Pen>();
    const d = await getJson(
      `${API}/teams/stats?stats=statSplits&sitCodes=rp&group=pitching` +
        `&season=${season}&sportIds=1&gameType=R`,
    );
    for (const st of d?.stats ?? []) {
      for (const s of st?.splits ?? []) {
        if (s?.split?.code && s.split.code !== "rp") continue;
        m.set(n(s?.team?.id), {
          bf: n(s?.stat?.battersFaced),
          outs: n(s?.stat?.outs),
          er: n(s?.stat?.earnedRuns),
          k: n(s?.stat?.strikeOuts),
        });
      }
    }
    return m;
  });
}

/** Season line for each probable starter. */
type SpLine = {
  bf: number;
  k: number;
  h: number;
  bb: number;
  hr: number;
  er: number;
  outs: number;
  gs: number;
};
async function fetchStarters(ids: number[], season: number): Promise<Map<number, SpLine>> {
  const uniq = [...new Set(ids.filter(Boolean))].sort((a, b) => a - b);
  if (uniq.length === 0) return new Map();
  return cached(`stacks:sp:${season}:${uniq.join(",")}`, 30 * 60_000, async () => {
    const m = new Map<number, SpLine>();
    for (let i = 0; i < uniq.length; i += 40) {
      const chunk = uniq.slice(i, i + 40);
      const d = await getJson(
        `${API}/people?personIds=${chunk.join(",")}` +
          `&hydrate=stats(group=pitching,type=season,season=${season},gameType=R)`,
        30000,
      );
      for (const p of d?.people ?? []) {
        const st = p?.stats?.[0]?.splits?.[0]?.stat;
        if (!st) continue;
        m.set(n(p.id), {
          bf: n(st.battersFaced),
          k: n(st.strikeOuts),
          h: n(st.hits),
          bb: n(st.baseOnBalls),
          hr: n(st.homeRuns),
          er: n(st.earnedRuns),
          outs: n(st.outs),
          gs: n(st.gamesStarted),
        });
      }
    }
    return m;
  });
}

/** Days of rest and games in the last week, from the previous eight days. */
async function fetchRecentSchedule(date: string): Promise<Map<number, number[]>> {
  return cached(`stacks:recent:${date}`, 60 * 60_000, async () => {
    const m = new Map<number, number[]>();
    const d = await getJson(
      `${API}/schedule?sportId=1&gameType=R` +
        `&startDate=${shiftDays(date, -8)}&endDate=${shiftDays(date, -1)}`,
    );
    for (const day of d?.dates ?? []) {
      for (const g of day?.games ?? []) {
        if (!["F", "O"].includes(g?.status?.codedGameState)) continue;
        const dn = dayNum(String(g.gameDate ?? "").slice(0, 10));
        for (const side of ["home", "away"] as const) {
          const id = n(g?.teams?.[side]?.team?.id);
          if (!id) continue;
          m.set(id, [...(m.get(id) ?? []), dn]);
        }
      }
    }
    return m;
  });
}

// ------------------------------------------------------------------ features
type FeatureInput = {
  me: TeamLine;
  meWin: TeamLine;
  mePrior: TeamLine | undefined;
  opp: TeamLine;
  oppWin: TeamLine;
  oppPrior: TeamLine | undefined;
  sp: SpLine | undefined;
  pen: Pen | undefined;
  park: number;
  isHome: boolean;
  restDays: number;
  g7: number;
};

/** The thirty features of TEAM_FEATURES, in order. Mirrors
 *  research/mlb-stacks/features_team.py — keep the two in step. */
export function teamFeatures(f: FeatureInput): number[] {
  const me = f.me;
  const spKnown = !!f.sp && f.sp.bf >= 1;
  const penKnown = !!f.pen && f.pen.outs >= 1;
  const pyKnown = !!f.mePrior && f.mePrior.g > 0;
  return [
    shrunk(me.runs, me.g, LG.r_pg, C.K_G),
    shrunk(me.tb, me.pa, LG.tb_pa, C.K_PA),
    shrunk(me.h, me.pa, LG.h_pa, C.K_PA),
    shrunk(me.hr, me.pa, LG.hr_pa, C.K_PA),
    shrunk(me.bb, me.pa, LG.bb_pa, C.K_PA),
    shrunk(me.k, me.pa, LG.k_pa, C.K_PA),
    shrunk(me.tb - me.h, me.ab, 0.15, C.K_PA),
    shrunk(f.meWin.runs, f.meWin.g, LG.r_pg, 8),
    shrunk(f.meWin.tb, f.meWin.pa, LG.tb_pa, 400),
    Math.min(f.meWin.g, 30),
    pyKnown ? f.mePrior!.runs / f.mePrior!.g : LG.r_pg,
    pyKnown && f.mePrior!.pa ? f.mePrior!.tb / f.mePrior!.pa : LG.tb_pa,
    pyKnown ? 1 : 0,
    shrunk(f.opp.runsAllowed, f.opp.allowedG || f.opp.g, LG.r_pg, C.K_G),
    shrunk(f.oppWin.runsAllowed, f.oppWin.allowedG || f.oppWin.g, LG.r_pg, 8),
    f.oppPrior && f.oppPrior.allowedG ? f.oppPrior.runsAllowed / f.oppPrior.allowedG : LG.r_pg,
    spKnown ? shrunk(f.sp!.k, f.sp!.bf, LG.p_k_bf, C.K_BF) : LG.p_k_bf,
    spKnown ? shrunk(f.sp!.h, f.sp!.bf, LG.p_h_bf, C.K_BF) : LG.p_h_bf,
    spKnown ? shrunk(f.sp!.hr, f.sp!.bf, LG.p_hr_bf, C.K_BF) : LG.p_hr_bf,
    spKnown ? shrunk(f.sp!.bb, f.sp!.bf, LG.p_bb_bf, C.K_BF) : LG.p_bb_bf,
    spKnown ? shrunk(f.sp!.er, f.sp!.outs, LG.p_er_out, C.K_OUT) : LG.p_er_out,
    spKnown && f.sp!.gs ? f.sp!.bf / f.sp!.gs : 21,
    spKnown ? 1 : 0,
    penKnown ? shrunk(f.pen!.er, f.pen!.outs, LG.p_er_out, C.K_OUT) : LG.p_er_out,
    penKnown ? shrunk(f.pen!.k, f.pen!.bf, LG.p_k_bf, C.K_BF) : LG.p_k_bf,
    penKnown ? 1 : 0,
    f.park,
    f.isHome ? 1 : 0,
    f.restDays,
    f.g7,
  ];
}

// ----------------------------------------------------------------- inference
type TeamMarket = (typeof model.markets)[keyof typeof model.markets];

function inferLogistic(m: TeamMarket, x: number[]): number {
  let z = m.intercept;
  for (let i = 0; i < m.coef.length; i++) z += m.coef[i] * ((x[i] - m.mean[i]) / m.std[i]);
  const raw = 1 / (1 + Math.exp(-z));
  const lg = Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-(m.plattA * lg + m.plattB)));
}

function inferRuns(x: number[]): number {
  const r = model.runs;
  let z = r.intercept;
  for (let i = 0; i < r.coef.length; i++) z += r.coef[i] * ((x[i] - r.mean[i]) / r.std[i]);
  return z;
}

function tierFor(tiers: { minProb: number; label: string; hitRate: number }[], p: number) {
  for (const t of tiers ?? []) if (p >= t.minProb) return t;
  return null;
}

// -------------------------------------------------------------- the copula

/**
 * P(Z < x) for a standard normal — Numerical Recipes' erfc, good to ~1e-7.
 * Paired with an Acklam inverse below, that is more than enough: the stack
 * price computed here agrees with the Python that fitted it to nine decimals
 * (checked by scripts/test-stacks.ts).
 */
function Phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const y =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  const erfc = x >= 0 ? y : 2 - y;
  return 1 - 0.5 * erfc;
}

/** Phi^-1, Acklam's rational approximation refined by one Halley step. */
function PhiInv(p: number): number {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  const a = [
    -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472,
    2.50662827745924,
  ];
  const b = [
    -54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857,
  ];
  const c = [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373,
    4.37466414146497, 2.93816398269878,
  ];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const plow = 0.02425;
  let x: number;
  if (q < plow) {
    const u = Math.sqrt(-2 * Math.log(q));
    x =
      (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  } else if (q > 1 - plow) {
    const u = Math.sqrt(-2 * Math.log(1 - q));
    x =
      -(((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
      ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  } else {
    const u = q - 0.5;
    const r = u * u;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * u) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const e = Phi(x) - q;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];
const QMC_N = model.correlation.qmcPoints;

/** The Halton sequence — deterministic, so the app and the trainer agree. */
const HALTON: number[][] = (() => {
  const out: number[][] = [];
  for (let i = 0; i < QMC_N; i++) {
    const row: number[] = [];
    for (let d = 0; d < PRIMES.length; d++) {
      const b = PRIMES[d];
      let f = 1;
      let x = 0;
      let k = i + 1;
      while (k > 0) {
        f /= b;
        x += f * (k % b);
        k = Math.floor(k / b);
      }
      row.push(x);
    }
    out.push(row);
  }
  return out;
})();

function cholesky(R: number[][]): number[][] {
  const k = R.length;
  const L = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let s = R[i][j];
      for (let m = 0; m < j; m++) s -= L[i][m] * L[j][m];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}

/**
 * P(every leg hits) for marginals `ps` under a Gaussian copula `R`, by Genz's
 * separation-of-variables transform over a Halton sequence.
 *
 * The marginals come back exactly `ps` whatever `R` says — the correlation only
 * moves the joint. That is what makes it safe to bolt onto two models that were
 * each fitted one leg at a time.
 */
export function stackProb(ps: number[], R: number[][]): number {
  const k = ps.length;
  if (k === 0) return 1;
  if (k === 1) return ps[0];
  const u = ps.map((p) => PhiInv(Math.min(Math.max(p, 1e-9), 1 - 1e-9)));
  const L = cholesky(R);
  let total = 0;
  for (let q = 0; q < QMC_N; q++) {
    const w = HALTON[q];
    const y = new Array(k).fill(0);
    let e = Phi(u[0] / L[0][0]);
    let f = e;
    for (let i = 1; i < k; i++) {
      y[i - 1] = PhiInv(Math.min(Math.max(w[i - 1] * e, 1e-12), 1 - 1e-12));
      let s = 0;
      for (let m = 0; m < i; m++) s += L[i][m] * y[m];
      e = Phi((u[i] - s) / L[i][i]);
      f *= e;
    }
    total += f;
  }
  return total / QMC_N;
}

/** Correlation matrix for a stack: the team-total leg first, then the hitters. */
export function stackMatrix(hitters: number, withTeam: boolean): number[][] {
  const { hitterHitter, teamHitter } = model.correlation;
  const k = hitters + (withTeam ? 1 : 0);
  const R = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 1 : hitterHitter)),
  );
  if (withTeam) {
    for (let i = 1; i < k; i++) R[0][i] = R[i][0] = teamHitter;
  }
  return R;
}

/**
 * Parity against the trainer: every market and the runs regression ship three
 * reference vectors with the number scikit-learn produced, and the copula ships
 * three reference stacks. Returns the worst absolute disagreement — the
 * logistic and regression parts land at ~1e-12, the copula at ~1e-6, because
 * its quadrature is evaluated with a different normal CDF here.
 */
export function stacksParityError(): number {
  let worst = 0;
  for (const m of Object.values(model.markets)) {
    for (const t of m.selftest) worst = Math.max(worst, Math.abs(inferLogistic(m, t.x) - t.p));
  }
  for (const t of model.runs.selftest) {
    worst = Math.max(worst, Math.abs(inferRuns(t.x) - t.p) / Math.max(Math.abs(t.p), 1));
  }
  for (const t of model.copulaSelftest) {
    const R = t.team ? stackMatrix(t.p.length - 1, true) : stackMatrix(t.p.length, false);
    worst = Math.max(worst, Math.abs(stackProb(t.p, R) - t.want));
  }
  return worst;
}

// -------------------------------------------------------------------- public
export type StackLeg = {
  kind: "team" | "batter";
  label: string;
  prob: number;
  playerId?: number;
  slot?: number;
};

export type StackCard = {
  key: string;
  legs: StackLeg[];
  /** Correctly correlated P(all legs hit). */
  prob: number;
  /** What treating the legs as independent would have said. */
  independent: number;
  /** prob / independent — how much a naive parlay price understates this. */
  lift: number;
  /** American price at which this card is exactly a push. */
  breakeven: number;
  tier: string | null;
  tierHitRate: number | null;
};

export type TeamTotal = {
  market: string;
  label: string;
  line: number;
  prob: number;
  base: number;
  tier: string | null;
  tierHitRate: number | null;
};

export type TeamStack = {
  gameId: number;
  date: string;
  startsAt: string;
  matchup: string;
  venue: string;
  park: number;
  teamId: number;
  team: string;
  opponent: string;
  isHome: boolean;
  opposingStarter: string | null;
  /** Projected runs — the ranking that answers "who scores tonight". */
  expRuns: number;
  /** 1 = the night's highest projected offence. */
  slateRank: number;
  totals: TeamTotal[];
  bats: PropPick[];
  cards: StackCard[];
};

export type StacksSlate = {
  date: string;
  season: number;
  teams: TeamStack[];
  /** Held-out numbers the page quotes, straight from the model file. */
  backtest: {
    slateMean: number;
    top1Runs: number;
    top3Runs: number;
    correlation: { hitterHitter: number; teamHitter: number };
    pairObserved: number;
    pairIndependence: number;
    pairModel: number;
    gateAll: number;
    gateTop3: number;
    cardTiers: { label: string; minProb: number; hitRate: number; n: number }[];
  };
};

const americanFor = (p: number) =>
  p <= 0 || p >= 1
    ? 0
    : p > 0.5
      ? Math.round((-100 * p) / (1 - p))
      : Math.round((100 * (1 - p)) / p);

/** How many bats from one lineup a card is allowed to use. Three is the most
 *  the props board offers per market per team, and the backtest says the
 *  hitter-to-hitter correlation is too weak to make longer stacks pay. */
const MAX_BATS = 3;

export async function stacksSlate(date: string): Promise<StacksSlate> {
  const season = Number(date.slice(0, 4));
  const backtest = {
    slateMean: model.runs.metrics.slateMean,
    top1Runs: model.runs.metrics.top1,
    top3Runs: model.runs.metrics.top3,
    correlation: {
      hitterHitter: model.correlation.hitterHitter,
      teamHitter: model.correlation.teamHitter,
    },
    pairObserved: model.correlation.verification.team_hitter.observed,
    pairIndependence: model.correlation.verification.team_hitter.independence,
    pairModel: model.correlation.verification.team_hitter.model,
    gateAll: model.gate.all,
    gateTop3: model.gate.top3,
    cardTiers: model.card.tiers,
  };

  const sched = await getJson(
    `${API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=probablePitcher,venue,team`,
  );
  const games = (sched?.dates ?? []).flatMap((d: any) => d?.games ?? []);
  if (games.length === 0) return { date, season, teams: [], backtest };

  const spIds = games.flatMap((g: any) => [
    n(g?.teams?.home?.probablePitcher?.id),
    n(g?.teams?.away?.probablePitcher?.id),
  ]);

  const winStart = shiftDays(date, -C.WINDOW_DAYS);
  const winEnd = shiftDays(date, -1);
  const [seasonLines, winLines, priorLines, pens, starters, recent, props] = await Promise.all([
    fetchTeamLines(season, null, `${season}:season`),
    fetchTeamLines(season, { start: winStart, end: winEnd }, `${season}:${winStart}:${winEnd}`),
    fetchTeamLines(season - 1, null, `${season - 1}:season`).catch(
      () => new Map<number, TeamLine>(),
    ),
    fetchBullpens(season).catch(() => new Map<number, Pen>()),
    fetchStarters(spIds, season).catch(() => new Map<number, SpLine>()),
    fetchRecentSchedule(date).catch(() => new Map<number, number[]>()),
    propsSlate(date).catch(() => null),
  ]);

  // 2+ total-base bats, straight from the Player Props model — one price per
  // hitter across the whole site.
  const batsByTeam = new Map<number, PropPick[]>();
  for (const g of props?.games ?? []) {
    for (const p of g.picks) {
      if (p.market !== "tb2" || p.kind !== "batter") continue;
      batsByTeam.set(p.teamId, [...(batsByTeam.get(p.teamId) ?? []), p]);
    }
  }
  for (const list of batsByTeam.values()) list.sort((a, b) => b.prob - a.prob);

  const today = dayNum(date);
  const rows: TeamStack[] = [];
  for (const g of games) {
    const venue = g?.venue?.name ?? "";
    const park = parkOf(venue);
    for (const side of ["home", "away"] as const) {
      const other = side === "home" ? "away" : "home";
      const meTeam = g?.teams?.[side]?.team;
      const oppTeam = g?.teams?.[other]?.team;
      const meId = n(meTeam?.id);
      const oppId = n(oppTeam?.id);
      const me = seasonLines.get(meId);
      const opp = seasonLines.get(oppId);
      if (!me || !opp || me.g < 1) continue;

      const days = recent.get(meId) ?? [];
      // No game in the last eight days means a long layoff, which the trainer
      // capped at six days of rest — start there rather than at one.
      const last = days.length ? Math.max(...days) : today - 6;
      const x = teamFeatures({
        me,
        meWin: winLines.get(meId) ?? emptyLine(),
        mePrior: priorLines.get(meId),
        opp,
        oppWin: winLines.get(oppId) ?? emptyLine(),
        oppPrior: priorLines.get(oppId),
        sp: starters.get(n(g?.teams?.[other]?.probablePitcher?.id)),
        pen: pens.get(oppId),
        park,
        isHome: side === "home",
        restDays: Math.min(today - last, 6),
        g7: days.filter((d) => d >= today - 7).length,
      });

      const totals: TeamTotal[] = Object.entries(model.markets).map(([key, m]) => {
        const prob = inferLogistic(m, x);
        const t = tierFor(m.tiers, prob);
        return {
          market: key,
          label: m.label,
          line: m.line,
          prob,
          base: m.base,
          tier: t?.label ?? null,
          tierHitRate: t?.hitRate ?? null,
        };
      });

      rows.push({
        gameId: n(g.gamePk),
        date,
        startsAt: String(g.gameDate ?? ""),
        matchup: `${g?.teams?.away?.team?.abbreviation ?? ""} @ ${g?.teams?.home?.team?.abbreviation ?? ""}`,
        venue,
        park,
        teamId: meId,
        team: meTeam?.abbreviation ?? meTeam?.teamName ?? "",
        opponent: oppTeam?.abbreviation ?? oppTeam?.teamName ?? "",
        isHome: side === "home",
        opposingStarter: g?.teams?.[other]?.probablePitcher?.fullName ?? null,
        expRuns: inferRuns(x),
        slateRank: 0,
        totals,
        bats: (batsByTeam.get(meId) ?? []).slice(0, MAX_BATS),
        cards: [],
      });
    }
  }

  rows.sort((a, b) => b.expRuns - a.expRuns);
  rows.forEach((r, i) => {
    r.slateRank = i + 1;
    r.cards = buildCards(r);
  });
  return { date, season, teams: rows, backtest };
}

/**
 * The cards for one lineup. The over-4.5 team total is the leg the correlation
 * was measured against, so it anchors every combination; hitter-only stacks are
 * offered too, and priced with the much weaker hitter-to-hitter correlation
 * rather than the folklore that a lineup rises as one.
 */
function buildCards(t: TeamStack): StackCard[] {
  const anchor = t.totals.find((x) => x.market === "r5");
  const bats = t.bats;
  const cards: StackCard[] = [];

  const push = (key: string, legs: StackLeg[], withTeam: boolean) => {
    const ps = legs.map((l) => l.prob);
    const R = stackMatrix(withTeam ? legs.length - 1 : legs.length, withTeam);
    const prob = stackProb(ps, R);
    const independent = ps.reduce((a, b) => a * b, 1);
    const tier = withTeam && legs.length === 2 ? tierFor(model.card.tiers, prob) : null;
    cards.push({
      key,
      legs,
      prob,
      independent,
      lift: independent > 0 ? prob / independent : 1,
      breakeven: americanFor(prob),
      tier: tier?.label ?? null,
      tierHitRate: tier?.hitRate ?? null,
    });
  };

  const batLeg = (p: PropPick): StackLeg => ({
    kind: "batter",
    label: `${p.player} 2+ TB`,
    prob: p.prob,
    playerId: p.playerId,
    slot: p.slot,
  });
  const teamLeg: StackLeg | null = anchor
    ? { kind: "team", label: `${t.team} over ${anchor.line} runs`, prob: anchor.prob }
    : null;

  if (teamLeg) {
    for (const b of bats) push(`t+${b.playerId}`, [teamLeg, batLeg(b)], true);
    if (bats.length >= 2)
      push(
        `t+${bats[0].playerId}+${bats[1].playerId}`,
        [teamLeg, batLeg(bats[0]), batLeg(bats[1])],
        true,
      );
  }
  if (bats.length >= 2)
    push(`${bats[0].playerId}+${bats[1].playerId}`, [batLeg(bats[0]), batLeg(bats[1])], false);

  return cards.sort((a, b) => b.prob - a.prob);
}
