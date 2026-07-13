// mlb-bullpen.ts — smart relievers-only bullpen reconstruction (a helper, not a model)
//
// Builds a per-BF pitching line for a team's *bullpen only*, point-in-time.
// This is the input sim-recent-v2 swaps in for the full-staff line sim-elo-v2 /
// sim-recent-v1 use as a bullpen proxy (see src/lib/mlb-recent-form.ts).
//
// Round 4 showed a *naïve* relievers-only line (equal-weight season/window
// average of the pen) was flat-to-negative: it throws away the two things that
// make bullpens matter — who pitches the high-leverage outs, and who is even
// available tonight. This version puts both back, over the trailing window, and
// stabilizes small samples with a DIPS-style split. Each reliever's line is
// pulled from his game log (one fetch), which carries per-appearance dates plus
// saves/holds/gamesFinished, so all three upgrades come from a single call:
//
//   #1 Leverage weighting — a reliever's contribution is scaled by how often he
//      is used in save/hold/close-out spots (saves + holds + ½·gamesFinished),
//      so the closer and setup men — the arms that actually finish close games —
//      dominate the line the sim faces late, instead of being averaged in with
//      mop-up arms.
//   #3 Fatigue / availability — a reliever's weight is cut by how many of the
//      last three days he already pitched; three-in-a-row is nearly zeroed out.
//   #6 Peripheral stabilization (DIPS) — K, BB and HR rates (real pitcher skill)
//      are regressed only lightly toward league; the non-HR hit rate (BABIP,
//      mostly defense + luck on small samples) is regressed hard, so the pen's
//      edge comes from what it controls. (A Statcast xwOBA version — savant is
//      reachable — is the natural next step; this is the statsapi-native form.)
//
// It is deliberately NOT the `staff − rotation game logs` subtraction Round 2
// rejected: it works from reliever identities (active roster as-of the morning,
// each pitcher's own game log, kept when the majority of his window appearances
// were in relief). Strictly point-in-time — the roster is as-of the day before,
// the window and the fatigue lookback both end the day before, nothing leaks the
// day's result.
//
// Window: pass `windowDays` for a trailing window (sim-recent-v2's "recent
// form" framing); omit for season-to-date.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { type BattingRates, type PitchingLine } from "./mlb-sim";

// Component-specific regression priors (in BF). K/BB/HR stabilize fast → light;
// non-HR hits (BABIP) are noisy → heavy pull toward league. This is the #6
// "trust the peripherals" idea expressed as DIPS-weighted shrinkage.
const PRIOR_K = 90;
const PRIOR_BB = 90;
const PRIOR_HR = 220;
const PRIOR_HIT = 500;

const LEV_COEF = 0.1; // leverage skew: L = 1 + LEV_COEF·(saves + holds + ½·GF)
const FATIGUE_DAYS = 3; // look back this many days for recent workload
const FATIGUE_MULT = [1.0, 0.85, 0.45, 0.2]; // weight by appearances in that lookback (index = count, capped)
const REL_MIN_BF = 30; // below this effective sample, no reliever line → fall back to staff

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Pitcher ids on a team's active roster as-of `asOfDate` (point-in-time). */
async function fetchTeamPitcherIds(teamId: number, asOfDate: string): Promise<number[]> {
  try {
    const url = `${STATS_API}/teams/${teamId}/roster?rosterType=active&date=${asOfDate}`;
    const res = await fetchWithTimeout(url, 20_000);
    if (!res.ok) return [];
    const json: any = await res.json();
    const ids: number[] = [];
    for (const r of json?.roster ?? []) {
      if (r?.position?.code === "1" && r?.person?.id) ids.push(r.person.id);
    }
    return ids;
  } catch {
    return [];
  }
}

interface Appearance {
  date: string;
  bf: number;
  gs: number;
  so: number;
  bb: number;
  hr: number;
  hNonHr: number;
  sv: number;
  hld: number;
  gf: number;
}

/** One pitcher's season game log as a list of appearances (empty on failure). */
async function fetchPitcherGameLog(personId: number, season: number): Promise<Appearance[]> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    return splits.map((s): Appearance => {
      const st = s.stat ?? {};
      return {
        date: s.date ?? "",
        bf: st.battersFaced ?? 0,
        gs: st.gamesStarted ?? 0,
        so: st.strikeOuts ?? 0,
        bb: (st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0),
        hr: st.homeRuns ?? 0,
        hNonHr: Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0)),
        sv: st.saves ?? 0,
        hld: st.holds ?? 0,
        gf: st.gamesFinished ?? 0,
      };
    });
  } catch {
    return [];
  }
}

/** Per-reliever summary over the trailing window, plus leverage + fatigue weights. */
interface RelieverSummary {
  bf: number;
  weight: number; // usage · leverage · availability
  rK: number; // per-BF rates over the window
  rBB: number;
  rHR: number;
  rHit: number; // non-HR hit rate
}

function summarizeReliever(
  log: Appearance[],
  startDate: string,
  endDate: string,
  gameDate: string,
): RelieverSummary | null {
  const fatigueSet = new Set(
    Array.from({ length: FATIGUE_DAYS }, (_, k) => addDaysISO(gameDate, -(k + 1))),
  );
  let bf = 0, gs = 0, gp = 0, so = 0, bb = 0, hr = 0, hNonHr = 0, sv = 0, hld = 0, gf = 0;
  let recentApps = 0;
  for (const a of log) {
    if (!a.date) continue;
    if (fatigueSet.has(a.date) && a.bf > 0) recentApps++;
    if (a.date < startDate || a.date > endDate) continue;
    bf += a.bf;
    gs += a.gs;
    if (a.bf > 0) gp++;
    so += a.so;
    bb += a.bb;
    hr += a.hr;
    hNonHr += a.hNonHr;
    sv += a.sv;
    hld += a.hld;
    gf += a.gf;
  }
  if (bf <= 0 || gp <= 0) return null;
  if (gs / gp >= 0.5) return null; // majority-start arm → not a reliever
  const leverage = 1 + LEV_COEF * (sv + hld + 0.5 * gf);
  const availability = FATIGUE_MULT[Math.min(recentApps, FATIGUE_MULT.length - 1)];
  return {
    bf,
    weight: bf * leverage * availability,
    rK: so / bf,
    rBB: bb / bf,
    rHR: hr / bf,
    rHit: hNonHr / bf,
  };
}

/**
 * Smart relievers-only per-BF line for every team id, reconstructed
 * point-in-time as of the day before `date`. Leverage- and fatigue-weighted
 * blend of the team's relief-role arms, then DIPS-style shrinkage toward league.
 * Teams whose effective reliever sample is too thin get `null` → the caller
 * falls back to the full-staff line.
 *
 * @param windowDays  trailing window length; omit for season-to-date.
 */
export async function fetchAllRelieverLines(
  teamIds: number[],
  season: number,
  date: string,
  lg: BattingRates,
  windowDays?: number,
): Promise<Map<number, PitchingLine | null>> {
  const endDate = addDaysISO(date, -1);
  const startDate = windowDays ? addDaysISO(date, -windowDays) : `${season}-03-01`;
  const out = new Map<number, PitchingLine | null>();

  // 1. Rosters (one call per team).
  const rosterByTeam = new Map<number, number[]>();
  await batchedAll(
    teamIds.map((tid) => async () => {
      rosterByTeam.set(tid, await fetchTeamPitcherIds(tid, endDate));
    }),
    8,
  );

  // 2. Every pitcher's game log (dedupe ids shared across the requested teams).
  const allIds = new Set<number>();
  for (const ids of rosterByTeam.values()) for (const id of ids) allIds.add(id);
  const logById = new Map<number, Appearance[]>();
  await batchedAll(
    Array.from(allIds).map((id) => async () => {
      logById.set(id, await fetchPitcherGameLog(id, season));
    }),
    10,
  );

  const lgHits = lg.b1 + lg.b2 + lg.b3;

  // 3. Leverage/fatigue-weighted blend per team → DIPS-regressed, shaped line.
  for (const tid of teamIds) {
    const ids = rosterByTeam.get(tid) ?? [];
    let W = 0; // total blend weight
    let effBf = 0; // fatigue-adjusted effective BF (the regression sample size)
    let wK = 0, wBB = 0, wHR = 0, wHit = 0; // weight·rate accumulators
    for (const id of ids) {
      const s = summarizeReliever(logById.get(id) ?? [], startDate, endDate, date);
      if (!s) continue;
      W += s.weight;
      effBf += s.weight; // weight is BF-scaled, so its sum is an effective-BF proxy
      wK += s.weight * s.rK;
      wBB += s.weight * s.rBB;
      wHR += s.weight * s.rHR;
      wHit += s.weight * s.rHit;
    }
    if (W <= 0 || effBf < REL_MIN_BF) {
      out.set(tid, null);
      continue;
    }
    const penK = wK / W, penBB = wBB / W, penHR = wHR / W, penHit = wHit / W;
    // DIPS shrinkage: light on skill rates, heavy on the BABIP-driven hit rate.
    const shrink = (rate: number, lgRate: number, prior: number) =>
      (rate * effBf + lgRate * prior) / (effBf + prior);
    const so = shrink(penK, lg.so, PRIOR_K);
    const bb = shrink(penBB, lg.bb, PRIOR_BB);
    const hr = shrink(penHR, lg.hr, PRIOR_HR);
    const hRate = shrink(penHit, lgHits, PRIOR_HIT);
    out.set(tid, {
      so,
      bb,
      hr,
      b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
      b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
      b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
    });
  }
  return out;
}
