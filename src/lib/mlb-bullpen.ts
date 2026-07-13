// mlb-bullpen.ts — relievers-only bullpen reconstruction (a helper, not a model)
//
// Builds a per-BF pitching line for a team's *bullpen only*, point-in-time.
// This is the input the sim-recent-v2 model swaps in for the full-staff line
// sim-elo-v2 / sim-recent-v1 use as a bullpen proxy (see src/lib/mlb-recent-form.ts).
//
// It is deliberately NOT the `staff − rotation game logs` subtraction Round 2
// rejected as too noisy (MODEL-ANALYSIS.md). Instead it works from reliever
// identities: the team's active roster as-of the morning of the game, each
// pitcher's own line over the requested window, kept only when the majority of
// his appearances in that window were in relief (GS/GP < 0.5), then summed and
// regressed toward league. `stats=byDateRange` is the same proven point-in-time
// mechanism sim-recent-v1 and the backtests already use.
//
// Window: pass `windowDays` for a trailing window (sim-recent-v2's "recent
// form" framing); omit it for season-to-date. Either way the window ends the
// day before the game, so nothing leaks the day's result.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { type BattingRates, type PitchingLine } from "./mlb-sim";

const REL_PRIOR_BF = 120; // regress a team's pen aggregate toward league
const REL_MIN_BF = 30; // below this the sample is too thin → no reliever line

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

/** One pitcher's pitching split over [startDate, endDate] (summed across teams if traded). */
async function fetchPitcherSplit(
  personId: number,
  season: number,
  startDate: string,
  endDate: string,
): Promise<any | null> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=pitching&season=${season}&startDate=${startDate}&endDate=${endDate}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    if (splits.length === 0) return null;
    if (splits.length === 1) return splits[0].stat;
    const sum: any = {};
    const numeric = [
      "battersFaced",
      "gamesPitched",
      "gamesStarted",
      "strikeOuts",
      "baseOnBalls",
      "hitByPitch",
      "hits",
      "homeRuns",
    ];
    for (const k of numeric) sum[k] = splits.reduce((a, s) => a + (s.stat?.[k] ?? 0), 0);
    return sum;
  } catch {
    return null;
  }
}

/**
 * Relievers-only per-BF line for every team id, reconstructed point-in-time as
 * of the day before `date`. For each team: active roster as-of that morning,
 * every pitcher's own line over the window, keep majority-relief arms, sum,
 * regress toward league, shape non-HR hits into 1B/2B/3B via the league split.
 * Teams with too few reliever BF get `null` → the caller falls back to the
 * full-staff line.
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

  // 2. Every pitcher's line (dedupe ids shared across the requested teams).
  const allIds = new Set<number>();
  for (const ids of rosterByTeam.values()) for (const id of ids) allIds.add(id);
  const splitById = new Map<number, any | null>();
  await batchedAll(
    Array.from(allIds).map((id) => async () => {
      splitById.set(id, await fetchPitcherSplit(id, season, startDate, endDate));
    }),
    10,
  );

  const lgHits = lg.b1 + lg.b2 + lg.b3;

  // 3. Sum the relief-role arms per team → regressed, shaped line.
  for (const tid of teamIds) {
    const ids = rosterByTeam.get(tid) ?? [];
    let bf = 0;
    let so = 0;
    let bb = 0;
    let hr = 0;
    let hNonHr = 0;
    for (const id of ids) {
      const st = splitById.get(id);
      if (!st) continue;
      const g = st.gamesPitched ?? 0;
      const gs = st.gamesStarted ?? 0;
      const pbf = st.battersFaced ?? 0;
      if (pbf <= 0 || g <= 0) continue;
      if (gs / g >= 0.5) continue; // majority-start arm → not a reliever
      bf += pbf;
      so += st.strikeOuts ?? 0;
      bb += (st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0);
      hr += st.homeRuns ?? 0;
      hNonHr += Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
    }
    if (bf < REL_MIN_BF) {
      out.set(tid, null);
      continue;
    }
    const reg = (count: number, lgRate: number) =>
      (count + lgRate * REL_PRIOR_BF) / (bf + REL_PRIOR_BF);
    const hRate = reg(hNonHr, lgHits);
    out.set(tid, {
      so: reg(so, lg.so),
      bb: reg(bb, lg.bb),
      hr: reg(hr, lg.hr),
      b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
      b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
      b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
    });
  }
  return out;
}
