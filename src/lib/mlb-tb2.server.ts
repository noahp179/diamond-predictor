/**
 * mlb-tb2.server.ts — how likely is this hitter to get two or more bases today?
 *
 * Total bases are what a hitter actually produces: a single is one, a double
 * two, a triple three, a home run four. "Two or more" is the line the books
 * offer most often, and it is the market this model does one job on.
 *
 * The Player Props tab already prices it as one of sixteen markets. This is a
 * dedicated model — the same thirty-four features plus three blocks that only
 * matter for this question, fitted in research/mlb-tb2 and frozen in
 * mlb-tb2-model.json:
 *
 *   park index   how a ballpark plays for *total bases* rather than for runs.
 *                Coors is 1.12, T-Mobile 0.94, and doubles move with the park
 *                far more than runs do.
 *   opponent     bases and extra-base hits allowed per batter faced — the
 *                whole staff and the defence behind it, in two numbers.
 *   two-week form  a 15-day window beside the model's existing 30-day one.
 *
 * On the held-out 2026 season that is AUC 0.5758 against the shipped model's
 * 0.5744, and the day's best pick goes from 51.0% to 52.9%.
 *
 * The features come from `batterRows` in mlb-props.server.ts rather than being
 * recomputed here, so the two boards can never quote a different number for the
 * same hitter. Everything this module adds on top is a lookup or a single
 * StatsAPI aggregate call.
 *
 * A note on what is deliberately missing: weather was the strongest block in
 * the bake-off and it is not here. StatsAPI publishes a game's weather only
 * once the game is under way — it is empty for every scheduled game — so a
 * board rendered before first pitch cannot compute it. See TWO-BASES.md.
 */
import model from "./mlb-tb2-model.json";
import { batterRows, type BatterRow } from "./mlb-props.server";

const API = "https://statsapi.mlb.com/api/v1";

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const shrunk = (num: number, den: number, prior: number, k: number) =>
  (num + k * prior) / (den + k);

// Shrinkage for the opponent block — mirrors research/mlb-tb2/features_tb2.py.
const K_DEF = 4000;
const LG_TB_PA = 0.35;
const LG_XBH_PA = 0.082;

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

/** Bases and extra-base hits each team has allowed, per batter faced. */
type DefLine = { tb: number; xbh: number; bf: number };

async function fetchDefence(season: number): Promise<Map<number, DefLine>> {
  return cached(`tb2:def:${season}`, 30 * 60_000, async () => {
    const m = new Map<number, DefLine>();
    const res = await fetch(
      `${API}/teams/stats?stats=season&group=pitching&season=${season}` + `&sportIds=1&gameType=R`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) throw new Error(`StatsAPI ${res.status}`);
    const d = await res.json();
    for (const s of d?.stats?.[0]?.splits ?? []) {
      const st = s?.stat ?? {};
      m.set(n(s?.team?.id), {
        tb: n(st.totalBases),
        xbh: n(st.doubles) + n(st.triples) + n(st.homeRuns),
        bf: n(st.battersFaced),
      });
    }
    return m;
  });
}

// ----------------------------------------------------------------- inference
const PARK_TB: Record<string, number> = model.parkTb;
const FEATURES = model.features;

/**
 * Assemble the 43-feature vector: the 34 the props model computes, then the
 * park index, the opponent's three, and the 15-day form block — in exactly the
 * order research/mlb-tb2/final_tb2.py froze them.
 */
export function tb2Vector(row: BatterRow, def: DefLine | undefined): number[] {
  const known = !!def && def.bf > 0;
  return [
    ...row.base,
    PARK_TB[row.venue] ?? 1,
    known ? shrunk(def!.tb, def!.bf, LG_TB_PA, K_DEF) : LG_TB_PA,
    known ? shrunk(def!.xbh, def!.bf, LG_XBH_PA, K_DEF) : LG_XBH_PA,
    known ? 1 : 0,
    ...row.form15,
  ];
}

function logit(x: number[]): number {
  let z = model.intercept;
  for (let i = 0; i < model.coef.length; i++) {
    z += model.coef[i] * ((x[i] - model.mean[i]) / model.std[i]);
  }
  return z;
}

export function tb2Probability(x: number[]): number {
  const raw = 1 / (1 + Math.exp(-logit(x)));
  const lg = Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-(model.plattA * lg + model.plattB)));
}

/** Parity with the trainer: five reference vectors and the probability
 *  scikit-learn produced for each. Returns the worst disagreement (~1e-12). */
export function tb2ParityError(): number {
  let worst = 0;
  for (const t of model.selftest) worst = Math.max(worst, Math.abs(tb2Probability(t.x) - t.p));
  return worst;
}

function tierFor(p: number) {
  for (const t of model.tiers) if (p >= t.minProb) return t;
  return null;
}

// --------------------------------------------------------- plain English
const GROUP_INDEX: { key: string; label: string; idx: number[] }[] = Object.entries(
  model.groups,
).map(([key, g]) => ({
  key,
  label: g.label,
  idx: g.features.map((f) => FEATURES.indexOf(f)).filter((i) => i >= 0),
}));

/**
 * Why this number, in a sentence.
 *
 * Each feature contributes `coef * (x - mean) / std` to the log-odds. Read one
 * at a time those are misleading — the rate features are heavily correlated,
 * so the model can put a negative weight on home-run rate while still liking
 * power hitters. Summed into the six groups the trainer tagged (his bat, his
 * recent form, how many at-bats he should get, the pitcher, the ballpark, the
 * lineup) they behave: every group correlates positively with the final
 * projection, so "his bat is helping and the pitcher is hurting" is a true
 * statement about the arithmetic, not a story told over it.
 */
export type Reason = { key: string; label: string; effect: number; detail: string };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ord = (v: number) => {
  const i = Math.round(v);
  const s = ["th", "st", "nd", "rd"][i % 10 > 3 || (i % 100) - (i % 10) === 10 ? 0 : i % 10];
  return `${i}${s}`;
};

/**
 * The concrete version of a feature, in words. Saying "where he bats in the
 * order" on every card is true and useless; saying "bats 2nd" is the same fact
 * with the number that makes it worth reading.
 */
function describe(feature: string, v: number, venue: string): string {
  switch (feature) {
    case "slot":
      return `bats ${ord(v)}`;
    case "pa_pg":
    case "w_pa_pg":
    case "w15_pa_pg":
      return `${v.toFixed(1)} trips to the plate a game`;
    case "own_tb2":
      return `2+ bases in ${pct(v)} of his games this year`;
    case "ownw_tb2":
      return `2+ bases in ${pct(v)} of his games this month`;
    case "own15_tb2":
      return `2+ bases in ${pct(v)} of his last two weeks`;
    case "tb_pa":
      return `${v.toFixed(2)} bases per plate appearance`;
    case "w_tb_pa":
      return `${v.toFixed(2)} bases per plate appearance this month`;
    case "w15_tb_pa":
      return `${v.toFixed(2)} bases per plate appearance in two weeks`;
    case "py_tb_pa":
      return `${v.toFixed(2)} bases per plate appearance last season`;
    case "iso":
      return `.${Math.round(v * 1000)} isolated power`;
    case "hr_pa":
    case "w_hr_pa":
    case "py_hr_pa":
      return v > 0.002 ? `a home run every ${Math.round(1 / v)} plate appearances` : "little power";
    case "h_pa":
    case "w_h_pa":
    case "w15_h_pa":
    case "py_h_pa":
      return `a hit in ${pct(v)} of plate appearances`;
    case "k_pa":
      return `strikes out in ${pct(v)} of plate appearances`;
    case "bb_pa":
      return `walks in ${pct(v)} of plate appearances`;
    case "sb_pa":
      return `steals in ${pct(v)} of plate appearances`;
    case "gp":
      return `${Math.round(v)} games played`;
    case "w_g":
      return `${Math.round(v)} games in the last month`;
    case "w15_g":
      return `${Math.round(v)} games in the last two weeks`;
    case "sp_k_bf":
      return `the starter strikes out ${pct(v)} of hitters`;
    case "sp_h_bf":
      return `the starter allows a hit to ${pct(v)} of hitters`;
    case "sp_hr_bf":
      return `the starter gives up a homer to ${pct(v)} of hitters`;
    case "sp_bb_bf":
      return `the starter walks ${pct(v)} of hitters`;
    case "sp_bf_start":
      return `the starter faces about ${Math.round(v)} batters a start`;
    case "def_tb_pa":
      return `this opponent allows ${v.toFixed(2)} bases per batter (league ${LG_TB_PA})`;
    case "def_xbh_pa":
      return `an extra-base hit to ${pct(v)} of batters faced`;
    case "opp_r_allowed_pg":
      return `${v.toFixed(1)} runs allowed a game`;
    case "park_tb":
    case "park": {
      const off = Math.round((v - 1) * 100);
      if (Math.abs(off) < 2) return `${venue} plays neutral`;
      return `${venue} plays ${Math.abs(off)}% ${off > 0 ? "big" : "small"}`;
    }
    case "is_home":
      return v > 0.5 ? "at home" : "on the road";
    case "team_r_pg":
      return `his lineup scores ${v.toFixed(1)} a game`;
    case "py_pa":
      return `${Math.round(v)} plate appearances last season`;
    case "py_known":
      return v > 0.5 ? "has a full season behind him" : "no prior season to lean on";
    case "sp_known":
      return v > 0.5 ? "" : "the starter has no track record yet";
    case "def_known":
      return "";
    default:
      return "";
  }
}

export function tb2Reasons(x: number[], venue: string): { up: Reason[]; down: Reason[] } {
  const contrib = model.coef.map((c, i) => c * ((x[i] - model.mean[i]) / model.std[i]));
  const groups = GROUP_INDEX.map((g) => {
    const effect = g.idx.reduce((a, i) => a + contrib[i], 0);
    // Name the single feature doing the most work inside the group, and quote
    // its actual value — the group says *what kind* of reason, the feature says
    // which one, and the number says how much.
    let best = -1;
    let bestAbs = 0;
    for (const i of g.idx) {
      if (Math.abs(contrib[i]) > bestAbs) {
        bestAbs = Math.abs(contrib[i]);
        best = i;
      }
    }
    const detail = best >= 0 ? describe(FEATURES[best], x[best], venue) : "";
    return { key: g.key, label: g.label, effect, detail };
  }).filter((g) => Math.abs(g.effect) > 0.01);

  groups.sort((a, b) => b.effect - a.effect);
  return {
    up: groups.filter((g) => g.effect > 0).slice(0, 3),
    down: groups
      .filter((g) => g.effect < 0)
      .reverse()
      .slice(0, 2),
  };
}

/** The one-line summary the card leads with. */
export function tb2Summary(p: number, r: { up: Reason[]; down: Reason[] }): string {
  const base = model.base;
  const vs =
    p >= base + 0.06
      ? "well above"
      : p >= base + 0.02
        ? "a bit above"
        : p <= base - 0.06
          ? "well below"
          : p <= base - 0.02
            ? "a bit below"
            : "about";
  const parts = [
    `${Math.round(p * 100)}% — ${vs} the ${Math.round(base * 100)}% a typical starter runs.`,
  ];
  const lead = r.up[0];
  const drag = r.down[0];
  if (lead?.detail) parts.push(`Helps: ${lead.detail}.`);
  else if (lead) parts.push(`Helps: ${lead.label}.`);
  if (drag?.detail) parts.push(`Hurts: ${drag.detail}.`);
  else if (drag) parts.push(`Hurts: ${drag.label}.`);
  return parts.join(" ");
}

// -------------------------------------------------------------------- public
export type TwoBasePick = {
  playerId: number;
  player: string;
  team: string;
  teamId: number;
  opponent: string;
  slot: number;
  isHome: boolean;
  gameId: number;
  matchup: string;
  venue: string;
  startsAt: string;
  lineupPosted: boolean;
  opposingStarter: string | null;
  /** Calibrated P(2 or more total bases). */
  prob: number;
  /** How far above a typical lineup starter. */
  edge: number;
  /** The fair American price for that probability. */
  fairOdds: number;
  tier: string | null;
  tierHitRate: number | null;
  summary: string;
  up: Reason[];
  down: Reason[];
};

export type TwoBaseSlate = {
  date: string;
  season: number;
  picks: TwoBasePick[];
  lineupsPosted: number;
  games: number;
  model: {
    base: number;
    auc: number;
    aucShipped: number;
    aucNaive: number;
    top1: number;
    top3: number;
    nTest: number;
    tiers: { label: string; minProb: number; hitRate: number; n: number }[];
    calibration: { lo: number; hi: number; n: number; pred: number; actual: number }[];
  };
};

const fair = (p: number) =>
  p <= 0 || p >= 1
    ? 0
    : p > 0.5
      ? Math.round((-100 * p) / (1 - p))
      : Math.round((100 * (1 - p)) / p);

export async function twoBaseSlate(date: string): Promise<TwoBaseSlate> {
  const meta = {
    base: model.base,
    auc: model.metrics.auc,
    aucShipped: model.metrics.aucShipped,
    aucNaive: model.metrics.aucNaive,
    top1: model.metrics.top1,
    top3: model.metrics.top3,
    nTest: model.metrics.nTest,
    tiers: model.tiers,
    calibration: model.calibration,
  };

  const { season, rows } = await batterRows(date);
  if (rows.length === 0) {
    return { date, season, picks: [], lineupsPosted: 0, games: 0, model: meta };
  }
  const def = await fetchDefence(season).catch(() => new Map<number, DefLine>());

  const picks: TwoBasePick[] = rows.map((row) => {
    const x = tb2Vector(row, def.get(row.opponentId));
    const prob = tb2Probability(x);
    const reasons = tb2Reasons(x, row.venue);
    const t = tierFor(prob);
    return {
      playerId: row.playerId,
      player: row.player,
      team: row.team,
      teamId: row.teamId,
      opponent: row.opponent,
      slot: row.slot,
      isHome: row.isHome,
      gameId: row.gamePk,
      matchup: row.matchup,
      venue: row.venue,
      startsAt: row.startsAt,
      lineupPosted: row.lineupPosted,
      opposingStarter: row.opposingStarter,
      prob,
      edge: prob - model.base,
      fairOdds: fair(prob),
      tier: t?.label ?? null,
      tierHitRate: t?.hitRate ?? null,
      summary: tb2Summary(prob, reasons),
      up: reasons.up,
      down: reasons.down,
    };
  });

  picks.sort((a, b) => b.prob - a.prob);
  const games = new Set(rows.map((r) => r.gamePk)).size;
  const posted = new Set(rows.filter((r) => r.lineupPosted).map((r) => `${r.gamePk}:${r.teamId}`))
    .size;
  return { date, season, picks, lineupsPosted: posted, games, model: meta };
}
