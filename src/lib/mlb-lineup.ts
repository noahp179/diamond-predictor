// mlb-lineup.ts — lineup-derived offense reconstruction (a helper, not a model)
//
// Builds a team's batting line from the nine hitters actually in tonight's
// batting order instead of the team aggregate — the input sim-recent-v2 swaps
// in for offense (see src/lib/mlb-recent-form.ts). This is the "actual lineups"
// item MODEL-ANALYSIS.md calls the single biggest piece of remaining headroom.
//
// The line: the game's boxscore batting order (nine person ids), each hitter's
// per-PA rates over the requested window (ending the day before, no lookahead),
// each regressed to league to tame small samples, then averaged into a
// lineup-level BattingRates the simulator consumes exactly like a team line.
//
// Window: pass `windowDays` for a trailing window (sim-recent-v2's "recent
// form" framing — the nine starters' *recent* bats); omit for season-to-date.
//
// Lineup availability: a boxscore batting order exists once a lineup is posted
// (~1–4h before first pitch) and always for settled games. When it is not yet
// posted — e.g. the early-morning cron — this returns null per side and the
// caller falls back to the (trailing) team batting line for that game. The
// backtest always has the real posted lineup.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { type BattingRates } from "./mlb-sim";

const HIT_PRIOR_PA = 60; // regress a hitter's per-PA rates toward league
const HIT_MIN_PA = 20; // below this, drop the hitter and lean on the rest

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
 * Average a lineup's hitters into one BattingRates. Equal weight per slot
 * (lineup spots see roughly equal PA over a game); hitters below the PA floor
 * are dropped and the rest carry the line. Returns null if fewer than five
 * usable hitters resolve, so the caller falls back to the team line.
 */
function averageLineup(rates: Array<BattingRates | null>): BattingRates | null {
  const usable = rates.filter((r): r is BattingRates => r != null);
  if (usable.length < 5) return null;
  const n = usable.length;
  const mean = (f: (r: BattingRates) => number) => usable.reduce((a, r) => a + f(r), 0) / n;
  return {
    pa: usable.reduce((a, r) => a + r.pa, 0),
    bb: mean((r) => r.bb),
    so: mean((r) => r.so),
    b1: mean((r) => r.b1),
    b2: mean((r) => r.b2),
    b3: mean((r) => r.b3),
    hr: mean((r) => r.hr),
  };
}

/**
 * Lineup-derived batting line per side for one game, or null where no lineup is
 * posted / too few hitters resolve. Point-in-time: rates end the day before.
 *
 * @param windowDays  trailing window length; omit for season-to-date.
 */
export async function fetchLineupBatting(
  gamePk: number,
  season: number,
  date: string,
  lg: BattingRates,
  windowDays?: number,
): Promise<{ home: BattingRates | null; away: BattingRates | null }> {
  const endDate = addDaysISO(date, -1);
  const startDate = windowDays ? addDaysISO(date, -windowDays) : `${season}-03-01`;
  const orders = await fetchBattingOrders(gamePk);
  const ids = Array.from(new Set([...orders.home, ...orders.away]));
  if (ids.length === 0) return { home: null, away: null };
  const rateById = new Map<number, BattingRates | null>();
  await batchedAll(
    ids.map((id) => async () => {
      rateById.set(id, await fetchHitterRates(id, season, startDate, endDate, lg));
    }),
    10,
  );
  return {
    home: averageLineup(orders.home.map((id) => rateById.get(id) ?? null)),
    away: averageLineup(orders.away.map((id) => rateById.get(id) ?? null)),
  };
}
