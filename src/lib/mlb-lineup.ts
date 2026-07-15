// mlb-lineup.ts — proper lineup/platoon offense reconstruction (Round 7)
//
// Builds a team's batting line from the nine hitters actually in tonight's
// posted batting order instead of the team aggregate — the offense input the
// sim-lineup model swaps in for sim-recent-v1's trailing team line. "Actual
// lineups" is the piece MODEL-ANALYSIS.md has called the single biggest lever
// of remaining headroom since Round 2.
//
// This is the SECOND cut. Round 4 built the naïve version — average the nine
// hitters' regressed per-PA rates with equal weight — and it clearly LOST to the
// plain team line. The post-mortem named two causes, and this file fixes both,
// plus adds the platoon signal a team aggregate structurally cannot see:
//
//   1. Equal-weight averaging shrank the offense's spread. FIX: weight each
//      hitter by the plate appearances his lineup SLOT sees (leadoff bats ~0.8
//      more times than the 9-hole), restoring the top-of-order emphasis the
//      team aggregate already has.
//   2. The lineup-average line ran through a miscalibrated run environment — the
//      engine's OFFENSE_CAL / HOME_BOOST constants were tuned against the
//      TEAM-AGGREGATE line, so a differently-leveled lineup line produces the
//      wrong R/G. FIX: recalibrate every lineup line so the league-mean lineup
//      reproduces the league-mean team line PER EVENT (a single global per-event
//      scalar over the day's slate), which pins the run environment back to what
//      the engine expects while preserving each team's relative deviation.
//   3. NEW signal: platoon. A lineup stacked with lefties facing a LHP starter
//      is materially worse tonight than its season line implies, and the team
//      aggregate can't represent it. FIX: tilt each hitter by a league platoon
//      multiplier keyed on his batting hand vs the starter's throwing hand,
//      damped by the starter's share of the game's PAs (the pen is mixed-handed).
//
// On platoon data: statsapi's statSplits ignores date ranges (it always returns
// full-season splits), so using a hitter's OWN vL/vR splits mid-season would
// leak the future — a lookahead violation. Individual platoon skill also needs
// ~1000+ PA to stabilize, so the sabermetric consensus regresses it hard toward
// the league split anyway. We therefore use the league platoon multiplier by
// handedness directly: it is point-in-time clean (handedness is static), cheap
// (one bulk /people call), un-noisy, and it still captures the thing the team
// aggregate misses — tonight's lineup CONSTRUCTION against tonight's starter.
//
// Lineup availability: a boxscore batting order exists once a lineup is posted
// (~1-4h before first pitch) and always for settled games. When it is not yet
// posted — e.g. the early-morning cron — a side returns null and the caller
// falls back to the (trailing) team batting line for that game. The backtest
// always has the real posted lineup. All rates end the day before `date`.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { type BattingRates } from "./mlb-sim";

export const LINEUP_WINDOW_DAYS = 21; // trailing hitter form; matches the team window so the ONLY change vs sim-recent-v1 is lineup-vs-aggregate
const HIT_PRIOR_PA = 60; // regress a hitter's per-PA rates toward league
const HIT_MIN_PA = 20; // below this, drop the hitter and lean on the rest of the order
const MIN_HITTERS = 5; // fewer usable hitters than this → null, caller falls back to the team line
const STARTER_PA_SHARE = 0.62; // ~fraction of a game's PAs the starter throws; damps the platoon tilt (the pen is mixed-handed)
const LEAGUE_LHP_SHARE = 0.28; // ~fraction of league PAs thrown by LHP; normalizes platoon to the hitter's own average exposure

type Hand = "L" | "R";
type BatSide = "L" | "R" | "S";

// Expected plate appearances by batting-order slot (index 0 = leadoff), per
// team-game. Leadoff sees ~0.8 more PA than the 9-hole; weighting by these
// restores the emphasis the naïve equal-weight average discarded. Used only as
// relative weights (normalized per lineup), so the absolute scale is irrelevant.
const SLOT_PA = [4.65, 4.55, 4.44, 4.34, 4.23, 4.13, 4.02, 3.92, 3.81];

// League platoon multipliers on per-PA offensive production, keyed
// [batterHand][pitcherHand]. Same-hand = platoon disadvantage, opposite-hand =
// advantage; left-handed batters carry the larger split. Magnitudes are
// league-typical (a few % of wOBA). Switch hitters are neutral by construction.
const PLATOON: Record<BatSide, Record<Hand, number>> = {
  R: { L: 1.06, R: 0.98 },
  L: { L: 0.9, R: 1.05 },
  S: { L: 1.0, R: 1.0 },
};

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The platoon multiplier for one hitter vs a starter's throwing hand, expressed
 * as a deviation from the hitter's OWN average exposure (≈72% RHP / 28% LHP), so
 * facing the common hand nudges the line ~nothing and only an unusual matchup
 * (or an unusually handed lineup) moves it. Then damped by the starter's PA
 * share, because the bullpen he hands off to is mixed-handed.
 */
function platoonFactor(bat: BatSide, pit: Hand): number {
  const raw = PLATOON[bat][pit];
  const avg = LEAGUE_LHP_SHARE * PLATOON[bat].L + (1 - LEAGUE_LHP_SHARE) * PLATOON[bat].R;
  const f = avg > 0 ? raw / avg : 1;
  return 1 + STARTER_PA_SHARE * (f - 1);
}

/** One hitter's per-PA batting rates over [startDate, endDate], regressed to league. */
async function fetchHitterRates(
  personId: number,
  season: number,
  startDate: string,
  endDate: string,
  lg: BattingRates,
): Promise<BattingRates | null> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=hitting&season=${season}&startDate=${startDate}&endDate=${endDate}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    if (splits.length === 0) return null;
    // Traded mid-window → one split per team; sum the counting stats.
    const st: any = {};
    const numeric = [
      "plateAppearances",
      "hits",
      "doubles",
      "triples",
      "homeRuns",
      "baseOnBalls",
      "hitByPitch",
      "strikeOuts",
    ];
    for (const k of numeric) st[k] = splits.reduce((a, s) => a + (s.stat?.[k] ?? 0), 0);
    const pa = st.plateAppearances ?? 0;
    if (pa < HIT_MIN_PA) return null;
    const reg = (count: number, lgRate: number) => (count + lgRate * HIT_PRIOR_PA) / (pa + HIT_PRIOR_PA);
    const h = st.hits ?? 0;
    const d2 = st.doubles ?? 0;
    const d3 = st.triples ?? 0;
    const hr = st.homeRuns ?? 0;
    return {
      pa,
      bb: reg((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0), lg.bb),
      so: reg(st.strikeOuts ?? 0, lg.so),
      b1: reg(Math.max(0, h - d2 - d3 - hr), lg.b1),
      b2: reg(d2, lg.b2),
      b3: reg(d3, lg.b3),
      hr: reg(hr, lg.hr),
    };
  } catch {
    return null;
  }
}

/** Boxscore batting order (nine person ids) per side, or [] if not posted yet. */
async function fetchBattingOrders(gamePk: number): Promise<{ home: number[]; away: number[] }> {
  try {
    const res = await fetchWithTimeout(`${STATS_API}/game/${gamePk}/boxscore`, 20_000);
    if (!res.ok) return { home: [], away: [] };
    const json: any = await res.json();
    const order = (side: "home" | "away"): number[] => {
      const arr = json?.teams?.[side]?.battingOrder ?? [];
      return Array.isArray(arr) ? arr.slice(0, 9) : [];
    };
    return { home: order("home"), away: order("away") };
  } catch {
    return { home: [], away: [] };
  }
}

/**
 * Batting hand for hitters and throwing hand for pitchers, in bulk. Handedness
 * is static, so this carries no lookahead. One /people call per ~40 ids.
 */
async function fetchHandedness(
  ids: number[],
): Promise<{ bats: Map<number, BatSide>; throws: Map<number, Hand> }> {
  const bats = new Map<number, BatSide>();
  const throwsBy = new Map<number, Hand>();
  const uniq = Array.from(new Set(ids.filter((x) => Number.isFinite(x))));
  const chunks: number[][] = [];
  for (let i = 0; i < uniq.length; i += 40) chunks.push(uniq.slice(i, i + 40));
  await batchedAll(
    chunks.map((chunk) => async () => {
      try {
        const res = await fetchWithTimeout(`${STATS_API}/people?personIds=${chunk.join(",")}`, 20_000);
        if (!res.ok) return;
        const people: any[] = (await res.json())?.people ?? [];
        for (const p of people) {
          const b = p?.batSide?.code;
          const t = p?.pitchHand?.code;
          if (b === "L" || b === "R" || b === "S") bats.set(p.id, b);
          if (t === "L" || t === "R") throwsBy.set(p.id, t);
        }
      } catch {
        // leave unresolved ids out; callers default to RHB / RHP
      }
    }),
    6,
  );
  return { bats, throws: throwsBy };
}

/**
 * Collapse a posted order into one PA-weighted, platoon-tilted BattingRates.
 * Slots are weighted by SLOT_PA; each hitter is tilted by his platoon factor vs
 * the starter's hand (positive events × f, strikeouts × 1/f — the platoon
 * advantage means more production and fewer K). Returns null if fewer than
 * MIN_HITTERS resolve, so the caller falls back to the team line.
 */
function buildLineupLine(
  order: number[],
  rateById: Map<number, BattingRates | null>,
  batsById: Map<number, BatSide>,
  starterHand: Hand | null,
): BattingRates | null {
  const acc = { bb: 0, so: 0, b1: 0, b2: 0, b3: 0, hr: 0 };
  let wsum = 0;
  let usable = 0;
  let paTot = 0;
  for (let i = 0; i < Math.min(9, order.length); i++) {
    const r = rateById.get(order[i]);
    if (!r) continue;
    const w = SLOT_PA[i] ?? SLOT_PA[SLOT_PA.length - 1];
    const bat = batsById.get(order[i]) ?? "R";
    const f = starterHand ? platoonFactor(bat, starterHand) : 1;
    acc.bb += w * r.bb * f;
    acc.b1 += w * r.b1 * f;
    acc.b2 += w * r.b2 * f;
    acc.b3 += w * r.b3 * f;
    acc.hr += w * r.hr * f;
    acc.so += (w * r.so) / f;
    wsum += w;
    usable++;
    paTot += r.pa;
  }
  if (usable < MIN_HITTERS || wsum <= 0) return null;
  return {
    pa: paTot,
    bb: acc.bb / wsum,
    so: acc.so / wsum,
    b1: acc.b1 / wsum,
    b2: acc.b2 / wsum,
    b3: acc.b3 / wsum,
    hr: acc.hr / wsum,
  };
}

/**
 * Global per-event level correction: rescale every lineup line so the mean
 * lineup line equals the mean team-aggregate line PER EVENT across the slate.
 * This is the fix for Round 4's run-environment miscalibration — it re-pins the
 * league-average offense to the level the engine's constants were tuned for,
 * while preserving each team's relative deviation (tonight's nine + platoon).
 * Point-in-time: team aggregates end yesterday, lineups are tonight's — both
 * known at prediction time. Corrections are clamped to a sane band so a thin
 * slate can't produce a blow-up factor.
 */
function levelCorrections(
  pairs: Array<{ lineup: BattingRates; team: BattingRates }>,
): Record<keyof Omit<BattingRates, "pa">, number> {
  const evs: Array<keyof Omit<BattingRates, "pa">> = ["bb", "so", "b1", "b2", "b3", "hr"];
  const c = {} as Record<keyof Omit<BattingRates, "pa">, number>;
  for (const ev of evs) {
    let ls = 0;
    let ts = 0;
    for (const p of pairs) {
      ls += p.lineup[ev];
      ts += p.team[ev];
    }
    const raw = ls > 0 ? ts / ls : 1;
    c[ev] = Math.min(1.15, Math.max(0.85, raw));
  }
  return c;
}

export interface LineupGameRef {
  gamePk: number;
  homeId: number;
  awayId: number;
  homeStarterId: number | null;
  awayStarterId: number | null;
}

/**
 * Lineup-derived offense per game for a whole slate, point-in-time and
 * level-recalibrated. Returns gamePk → { home, away } BattingRates; a side is
 * null when no lineup is posted or too few hitters resolve (caller falls back to
 * the team line). `teamAgg` is the same trailing team-batting map sim-recent-v1
 * uses — it is the recalibration target here (and the caller's per-side fallback).
 */
export async function fetchLineupOffenseForDate(
  refs: LineupGameRef[],
  season: number,
  date: string,
  lg: BattingRates,
  teamAgg: Map<number, BattingRates | null>,
  windowDays = LINEUP_WINDOW_DAYS,
): Promise<Map<number, { home: BattingRates | null; away: BattingRates | null }>> {
  const endDate = addDaysISO(date, -1);
  const startDate = addDaysISO(date, -windowDays);

  // 1) posted batting orders per game
  const orders = new Map<number, { home: number[]; away: number[] }>();
  await batchedAll(
    refs.map((g) => async () => {
      orders.set(g.gamePk, await fetchBattingOrders(g.gamePk));
    }),
    8,
  );

  // 2) handedness for every hitter + starter (one bulk pass), and 3) each
  //    hitter's trailing rates
  const hitterIds = new Set<number>();
  for (const o of orders.values()) for (const id of [...o.home, ...o.away]) hitterIds.add(id);
  const starterIds = refs.flatMap((g) => [g.homeStarterId, g.awayStarterId]).filter((x): x is number => x != null);

  const { bats, throws } = await fetchHandedness([...hitterIds, ...starterIds]);
  const rateById = new Map<number, BattingRates | null>();
  await batchedAll(
    Array.from(hitterIds).map((id) => async () => {
      rateById.set(id, await fetchHitterRates(id, season, startDate, endDate, lg));
    }),
    10,
  );

  // 4) build each side's PA-weighted, platoon-tilted line
  const raw = new Map<number, { home: BattingRates | null; away: BattingRates | null }>();
  const pairs: Array<{ lineup: BattingRates; team: BattingRates }> = [];
  for (const g of refs) {
    const o = orders.get(g.gamePk) ?? { home: [], away: [] };
    // home bats vs the AWAY starter's hand; away bats vs the HOME starter's hand
    const awayHand = g.awayStarterId != null ? throws.get(g.awayStarterId) ?? null : null;
    const homeHand = g.homeStarterId != null ? throws.get(g.homeStarterId) ?? null : null;
    const home = buildLineupLine(o.home, rateById, bats, awayHand);
    const away = buildLineupLine(o.away, rateById, bats, homeHand);
    raw.set(g.gamePk, { home, away });
    const hTeam = teamAgg.get(g.homeId);
    const aTeam = teamAgg.get(g.awayId);
    if (home && hTeam) pairs.push({ lineup: home, team: hTeam });
    if (away && aTeam) pairs.push({ lineup: away, team: aTeam });
  }

  // 5) recalibrate to the team-aggregate environment (needs ≥6 pairs to be stable)
  if (pairs.length < 6) return raw;
  const c = levelCorrections(pairs);
  const apply = (b: BattingRates | null): BattingRates | null =>
    b
      ? {
          pa: b.pa,
          bb: b.bb * c.bb,
          so: b.so * c.so,
          b1: b.b1 * c.b1,
          b2: b.b2 * c.b2,
          b3: b.b3 * c.b3,
          hr: b.hr * c.hr,
        }
      : null;
  const out = new Map<number, { home: BattingRates | null; away: BattingRates | null }>();
  for (const [pk, v] of raw) out.set(pk, { home: apply(v.home), away: apply(v.away) });
  return out;
}
