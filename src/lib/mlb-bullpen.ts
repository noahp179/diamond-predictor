// mlb-bullpen.ts — tiered relievers-only bullpen reconstruction (a helper, not a model)
//
// Builds a team's bullpen as THREE leverage tiers (closer / setup / middle)
// deployed by game state in the sim, rather than one blended pen line. This is
// the input sim-recent-v2 swaps in for the full-staff proxy (see mlb-recent-form.ts).
//
// Rounds 4–5 showed a single blended pen line — even leverage-weighted — did not
// beat the full-staff proxy: a single line is the wrong SHAPE for a signal that
// only matters in specific late-game states. This version fixes the shape and
// folds in the reliever ideas worth having, all from each reliever's game log
// (one fetch):
//
//   #1/#2 Leverage tiers + explicit closer — relievers are ranked by close-out
//         usage (saves + holds + ½·gamesFinished) and split into closer / setup /
//         middle; the sim sends the closer out in the 9th of a save/tie, setup in
//         the 7th–8th of one-score games, middle otherwise.
//   #3    Fatigue / availability — each arm's weight is cut by how many of the
//         last three days he pitched, so a gassed closer cedes his tier to the
//         next arm (the closer tier blends the top two, availability-weighted).
//   #4    Reliever-appropriate prior — tiers regress toward a *reliever-league*
//         baseline pooled from every rostered reliever that day (relievers miss
//         more bats than the overall league), not the all-pitching league line.
//   #6    Peripheral (DIPS) stabilization — K/BB/HR regress lightly, the non-HR
//         hit rate (BABIP) regresses hard. (A Statcast xwOBA version is the next
//         step; this is the statsapi-native form.)
//   #7    Recency weighting — appearances inside the window are exp-decayed so
//         the last two weeks count more than the top of the window.
//
// Deliberately NOT the `staff − rotation game logs` subtraction Round 2 rejected:
// it works from reliever identities (active roster as-of the morning, each arm's
// own game log, kept when the majority of his window appearances were in relief).
// Strictly point-in-time — roster as-of the day before, window and fatigue
// lookback both end the day before.
//
// Window: pass `windowDays` for a trailing window (sim-recent-v2's framing);
// omit for season-to-date.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { type BattingRates, type BullpenTiers, type PitchingLine } from "./mlb-sim";

const TAU_DAYS = 18; // recency half-life-ish decay for in-window appearances (#7)
const FATIGUE_DAYS = 3; // recent-workload lookback (#3)
const FATIGUE_MULT = [1.0, 0.85, 0.45, 0.2]; // weight by appearances in that lookback (index = count, capped)
const CLOSER_N = 2; // top-N leverage arms form the closer tier (availability-blended)
const SETUP_N = 3; // next-N arms form the setup tier
// DIPS priors (in BF): trust K/BB/HR, regress BABIP hits hard (#6).
const PRIOR_K = 80;
const PRIOR_BB = 80;
const PRIOR_HR = 200;
const PRIOR_HIT = 450;
const REL_MIN_BF = 30; // total effective reliever BF below this → no bullpen (fall back to staff)

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(aISO: string, bISO: string): number {
  return Math.round(
    (new Date(bISO + "T00:00:00Z").getTime() - new Date(aISO + "T00:00:00Z").getTime()) / 86400000,
  );
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

export interface Appearance {
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

/** Per-reliever summary over the trailing window: recency-weighted rates + tier signals. */
interface Reliever {
  effBf: number; // availability-adjusted actual BF (regression sample size)
  weight: number; // effBf · availability (tier-blend weight)
  leverage: number; // saves + holds + ½·gamesFinished (tier ranking)
  rK: number; // recency-weighted per-BF rates over the window
  rBB: number;
  rHR: number;
  rHit: number; // non-HR hit rate
}

function summarizeReliever(
  log: Appearance[],
  startDate: string,
  endDate: string,
  gameDate: string,
): Reliever | null {
  const fatigueSet = new Set(
    Array.from({ length: FATIGUE_DAYS }, (_, k) => addDaysISO(gameDate, -(k + 1))),
  );
  let bf = 0, gs = 0, gp = 0, sv = 0, hld = 0, gf = 0;
  let wBf = 0, wK = 0, wBB = 0, wHR = 0, wHit = 0; // recency-weighted accumulators
  let recentApps = 0;
  for (const a of log) {
    if (!a.date) continue;
    if (fatigueSet.has(a.date) && a.bf > 0) recentApps++;
    if (a.date < startDate || a.date > endDate) continue;
    bf += a.bf;
    gs += a.gs;
    if (a.bf > 0) gp++;
    sv += a.sv;
    hld += a.hld;
    gf += a.gf;
    const w = Math.exp(-Math.max(0, daysBetween(a.date, gameDate)) / TAU_DAYS);
    wBf += w * a.bf;
    wK += w * a.so;
    wBB += w * a.bb;
    wHR += w * a.hr;
    wHit += w * a.hNonHr;
  }
  if (bf <= 0 || gp <= 0 || wBf <= 0) return null;
  if (gs / gp >= 0.5) return null; // majority-start arm → not a reliever
  const availability = FATIGUE_MULT[Math.min(recentApps, FATIGUE_MULT.length - 1)];
  return {
    effBf: bf * availability,
    weight: bf * availability,
    leverage: sv + hld + 0.5 * gf,
    rK: wK / wBf,
    rBB: wBB / wBf,
    rHR: wHR / wBf,
    rHit: wHit / wBf,
  };
}

/** BF-weighted pool of relievers → a reliever-league baseline line (no DIPS). (#4) */
function relieverLeague(all: Reliever[], lg: BattingRates): { so: number; bb: number; hr: number; hit: number } {
  let bf = 0, k = 0, b = 0, h = 0, hit = 0;
  for (const r of all) {
    bf += r.effBf;
    k += r.effBf * r.rK;
    b += r.effBf * r.rBB;
    h += r.effBf * r.rHR;
    hit += r.effBf * r.rHit;
  }
  if (bf <= 0) return { so: lg.so, bb: lg.bb, hr: lg.hr, hit: lg.b1 + lg.b2 + lg.b3 };
  return { so: k / bf, bb: b / bf, hr: h / bf, hit: hit / bf };
}

/** Blend a set of relievers into one DIPS-regressed, shaped line (relLg = reliever baseline). */
function blendTier(
  arms: Reliever[],
  relLg: { so: number; bb: number; hr: number; hit: number },
  lg: BattingRates,
): PitchingLine {
  const lgHits = lg.b1 + lg.b2 + lg.b3;
  let W = 0, effBf = 0, k = 0, b = 0, hr = 0, hit = 0;
  for (const r of arms) {
    W += r.weight;
    effBf += r.effBf;
    k += r.weight * r.rK;
    b += r.weight * r.rBB;
    hr += r.weight * r.rHR;
    hit += r.weight * r.rHit;
  }
  const rK = W > 0 ? k / W : relLg.so;
  const rBB = W > 0 ? b / W : relLg.bb;
  const rHR = W > 0 ? hr / W : relLg.hr;
  const rHit = W > 0 ? hit / W : relLg.hit;
  const shrink = (rate: number, base: number, prior: number) =>
    (rate * effBf + base * prior) / (effBf + prior);
  const so = shrink(rK, relLg.so, PRIOR_K);
  const bb = shrink(rBB, relLg.bb, PRIOR_BB);
  const hrOut = shrink(rHR, relLg.hr, PRIOR_HR);
  const hRate = shrink(rHit, relLg.hit, PRIOR_HIT);
  return {
    so,
    bb,
    hr: hrOut,
    b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
    b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
    b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
  };
}

/**
 * Tiered bullpen (closer / setup / middle) for every team id, reconstructed
 * point-in-time as of the day before `date`. Relievers are ranked by close-out
 * usage; the closer tier is the top-two arms (availability-weighted so a gassed
 * closer cedes to his backup), setup the next three, middle the rest — each
 * DIPS-regressed toward a reliever-league baseline. Teams whose effective
 * reliever sample is too thin get `null` → caller falls back to the full-staff
 * line.
 *
 * @param windowDays  trailing window length; omit for season-to-date.
 * @param gameLogCache optional cross-call cache of full-season game logs keyed
 *   by pitcher id. Game logs are date-filtered downstream (window + fatigue set),
 *   so serving a cached full-season log is point-in-time safe. Used by the
 *   backtest collector, which sweeps many dates in one process; the daily cron
 *   omits it (one date per run — identical behavior to before).
 */
export async function fetchAllBullpens(
  teamIds: number[],
  season: number,
  date: string,
  lg: BattingRates,
  windowDays?: number,
  gameLogCache?: Map<number, Appearance[]>,
): Promise<Map<number, BullpenTiers | null>> {
  const endDate = addDaysISO(date, -1);
  const startDate = windowDays ? addDaysISO(date, -windowDays) : `${season}-03-01`;
  const out = new Map<number, BullpenTiers | null>();

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
      const cached = gameLogCache?.get(id);
      if (cached) {
        logById.set(id, cached);
        return;
      }
      const log = await fetchPitcherGameLog(id, season);
      logById.set(id, log);
      gameLogCache?.set(id, log);
    }),
    10,
  );

  // 3. Summarize each reliever; pool a reliever-league baseline across all teams. (#4)
  const relByTeam = new Map<number, Reliever[]>();
  const allRel: Reliever[] = [];
  for (const tid of teamIds) {
    const arms: Reliever[] = [];
    for (const id of rosterByTeam.get(tid) ?? []) {
      const r = summarizeReliever(logById.get(id) ?? [], startDate, endDate, date);
      if (r) {
        arms.push(r);
        allRel.push(r);
      }
    }
    relByTeam.set(tid, arms);
  }
  const relLg = relieverLeague(allRel, lg);

  // 4. Rank by leverage → closer / setup / middle tiers.
  for (const tid of teamIds) {
    const arms = (relByTeam.get(tid) ?? []).slice().sort((a, b) => b.leverage - a.leverage);
    const effBf = arms.reduce((s, r) => s + r.effBf, 0);
    if (arms.length === 0 || effBf < REL_MIN_BF) {
      out.set(tid, null);
      continue;
    }
    const closerArms = arms.slice(0, CLOSER_N);
    const setupArms = arms.slice(CLOSER_N, CLOSER_N + SETUP_N);
    const middleArms = arms.slice(CLOSER_N + SETUP_N);
    // Thin pens: a missing tier falls back to the whole-pen blend so it is never empty.
    out.set(tid, {
      closer: blendTier(closerArms.length ? closerArms : arms, relLg, lg),
      setup: blendTier(setupArms.length ? setupArms : arms, relLg, lg),
      middle: blendTier(middleArms.length ? middleArms : arms, relLg, lg),
    });
  }
  return out;
}
