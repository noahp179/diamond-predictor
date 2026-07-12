// Pure logic shared by ingestion + live fetch. No imports from .server modules.

import { parkFactor } from "./park-factors";

// Re-export so consumers only need one import from this module
export { parkFactor } from "./park-factors";

export const MODEL_VERSION = "baseline-v0.4";
export const STATS_API = "https://statsapi.mlb.com/api/v1";

const DEFAULT_FETCH_TIMEOUT = 15_000;

export async function fetchWithTimeout(
  url: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

export interface TeamSide {
  id: number;
  name: string;
  abbreviation: string;
  record: string;
  winPct: number;
  pitcher: {
    id: number | null;
    name: string;
    era: number | null;
    wins: number | null;
    losses: number | null;
    fip?: number | null;
    whip?: number | null;
  } | null;
}

export interface PredictedGame {
  gameId: number;
  date: string;
  status: string;
  venue: string;
  home: TeamSide;
  away: TeamSide;
  homeWinProb: number;
  awayWinProb: number;
  rationale: string[];
  homeScore?: number | null;
  awayScore?: number | null;
  winner?: "home" | "away" | null;
  correct?: boolean | null;
  /**
   * Optional secondary model's win probabilities for the same game, shown
   * beside the primary number on the card. Currently carries sim-recent-v1.
   */
  altModel?: { label: string; homeWinProb: number; awayWinProb: number } | null;
}

export interface StandingsRow {
  winPct: number;
  wins: number;
  losses: number;
  runsScored: number;
  runsAllowed: number;
  pythagPct: number; // run-based expected win%
  lastTenPct: number; // L10 record
  homePct: number; // home-only win%
  awayPct: number; // away-only win%
}

export interface TeamStatsRow {
  ops: number | null; // team season OPS (offense)
  teamEra: number | null; // full-staff ERA (captures bullpen + rotation depth)
  teamWhip: number | null;
}

export async function fetchStandings(season: number): Promise<Map<number, StandingsRow>> {
  const url = `${STATS_API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return new Map();
  const json: any = await res.json();
  const map = new Map<number, StandingsRow>();
  for (const rec of json.records ?? []) {
    for (const tr of rec.teamRecords ?? []) {
      const rs = tr.runsScored ?? 0;
      const ra = tr.runsAllowed ?? 0;
      // Pythagorean expectation with exponent 1.83 (Bill James).
      const pythag = rs + ra > 0
        ? Math.pow(rs, 1.83) / (Math.pow(rs, 1.83) + Math.pow(ra, 1.83))
        : 0.5;
      const splits: any[] = tr.records?.splitRecords ?? [];
      const split = (type: string) => {
        const s = splits.find((x) => x.type === type);
        if (!s) return 0.5;
        const w = s.wins ?? 0;
        const l = s.losses ?? 0;
        return w + l > 0 ? w / (w + l) : 0.5;
      };
      map.set(tr.team.id, {
        winPct: parseFloat(tr.winningPercentage ?? "0.5") || 0.5,
        wins: tr.wins ?? 0,
        losses: tr.losses ?? 0,
        runsScored: rs,
        runsAllowed: ra,
        pythagPct: pythag,
        lastTenPct: split("lastTen"),
        homePct: split("home"),
        awayPct: split("away"),
      });
    }
  }
  return map;
}

/**
 * Pull season team hitting (OPS) and pitching (full-staff ERA/WHIP) in two
 * calls — proxies offensive quality and bullpen/staff depth beyond the
 * named starter.
 */
export async function fetchTeamStats(season: number): Promise<Map<number, TeamStatsRow>> {
  const base = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=season`;
  const [hitRes, pitRes] = await Promise.all([
    fetchWithTimeout(`${base}&group=hitting`),
    fetchWithTimeout(`${base}&group=pitching`),
  ]);
  const map = new Map<number, TeamStatsRow>();
  const init = (id: number) => {
    let r = map.get(id);
    if (!r) {
      r = { ops: null, teamEra: null, teamWhip: null };
      map.set(id, r);
    }
    return r;
  };
  try {
    if (hitRes.ok) {
      const j: any = await hitRes.json();
      for (const split of j?.stats?.[0]?.splits ?? []) {
        const id = split?.team?.id;
        if (!id) continue;
        const ops = split?.stat?.ops != null ? parseFloat(split.stat.ops) : null;
        init(id).ops = ops != null && Number.isFinite(ops) ? ops : null;
      }
    }
  } catch { /* ignore */ }
  try {
    if (pitRes.ok) {
      const j: any = await pitRes.json();
      for (const split of j?.stats?.[0]?.splits ?? []) {
        const id = split?.team?.id;
        if (!id) continue;
        const era = split?.stat?.era != null ? parseFloat(split.stat.era) : null;
        const whip = split?.stat?.whip != null ? parseFloat(split.stat.whip) : null;
        const row = init(id);
        row.teamEra = era != null && Number.isFinite(era) ? era : null;
        row.teamWhip = whip != null && Number.isFinite(whip) ? whip : null;
      }
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * Look back 5 days from the target date and count days since each team
 * last played. Returns a Map<teamId, restDays>.
 */
export async function fetchRestDays(date: string): Promise<Map<number, number>> {
  const target = new Date(date + "T00:00:00Z");
  const start = new Date(target);
  start.setUTCDate(start.getUTCDate() - 5);
  const startISO = start.toISOString().slice(0, 10);
  const endISO = new Date(target.getTime() - 86400000).toISOString().slice(0, 10);
  const url = `${STATS_API}/schedule?sportId=1&startDate=${startISO}&endDate=${endISO}`;
  const map = new Map<number, number>();
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return map;
    const j: any = await res.json();
    const lastPlayed = new Map<number, string>();
    for (const d of j?.dates ?? []) {
      for (const g of d?.games ?? []) {
        const status: string = g?.status?.detailedState ?? "";
        if (!/final|game over|completed/i.test(status)) continue;
        const gd: string = (d.date as string) ?? (g.gameDate?.slice(0, 10) ?? "");
        const hid = g?.teams?.home?.team?.id;
        const aid = g?.teams?.away?.team?.id;
        if (hid) {
          const prev = lastPlayed.get(hid);
          if (!prev || gd > prev) lastPlayed.set(hid, gd);
        }
        if (aid) {
          const prev = lastPlayed.get(aid);
          if (!prev || gd > prev) lastPlayed.set(aid, gd);
        }
      }
    }
    for (const [id, gd] of lastPlayed) {
      const last = new Date(gd + "T00:00:00Z");
      const days = Math.round((target.getTime() - last.getTime()) / 86400000) - 1;
      map.set(id, Math.max(0, days));
    }
  } catch { /* ignore */ }
  return map;
}

export async function fetchPitcherEra(
  personId: number,
  season: number,
): Promise<{
  era: number | null;
  w: number | null;
  l: number | null;
  fip: number | null;
  whip: number | null;
  ip: number | null;
}> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { era: null, w: null, l: null, fip: null, whip: null, ip: null };
    const json: any = await res.json();
    const split = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return { era: null, w: null, l: null, fip: null, whip: null, ip: null };
    const era = split.era ? parseFloat(split.era) : null;
    const whip = split.whip ? parseFloat(split.whip) : null;

    let fip: number | null = null;
    const ipStr = split.inningsPitched;
    if (ipStr) {
      const parts = ipStr.split(".");
      const innings = parseInt(parts[0], 10) || 0;
      const outs = parts[1] ? parseInt(parts[1], 10) : 0;
      const ip = innings + outs / 3;
      if (ip >= 5.0) { // Require at least 5 innings pitched to compute a stable FIP
        const hr = split.homeRuns ?? 0;
        const bb = split.baseOnBalls ?? 0;
        const hbp = split.hitByPitch ?? 0;
        const k = split.strikeOuts ?? 0;
        // FIP = (13*HR + 3*(BB+HBP) - 2*K)/IP + 4.20 (aligned with average ERA)
        fip = (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 4.20;
      }
    }

    const ip = split.inningsPitched ? parseFloat(split.inningsPitched) : null;
    return {
      era: era != null && Number.isFinite(era) ? era : null,
      w: split.wins ?? null,
      l: split.losses ?? null,
      fip: fip != null && Number.isFinite(fip) ? fip : null,
      whip: whip != null && Number.isFinite(whip) ? whip : null,
      ip: ip != null && Number.isFinite(ip) ? ip : null,
    };
  } catch {
    return { era: null, w: null, l: null, fip: null, whip: null, ip: null };
  }
}

export interface PredictInputs {
  home: StandingsRow | undefined;
  away: StandingsRow | undefined;
  homeEra: number | null;
  awayEra: number | null;
  homeEraIp?: number | null;
  awayEraIp?: number | null;
  venue?: string | null;
  homeStats?: TeamStatsRow;
  awayStats?: TeamStatsRow;
  homeRestDays?: number | null;
  awayRestDays?: number | null;
}

/**
 * Probabilistic blend in log-odds space. v0.4 features:
 *   1. Composite team strength (Pythag · W% · L10 · home/away split)
 *   2. Run-differential/game gap
 *   3. Home-field edge (+0.18 logit)
 *   4. Starter ERA gap (regressed to league mean)
 *   5. Full-staff team ERA gap  (bullpen + rotation depth proxy)
 *   6. Team OPS gap (offensive quality, .720 league anchor)
 *   7. Rest-days advantage (+/- 0.04 logit per day, capped at ±2)
 *   8. Park factor as a logit multiplier
 *   9. Mild calibration shrink (×0.92) toward 0.5 to combat overconfidence
 *  10. Hard clamp to [0.15, 0.85]
 */
export function predict({
  home,
  away,
  homeEra,
  awayEra,
  homeEraIp,
  awayEraIp,
  venue,
  homeStats,
  awayStats,
  homeRestDays,
  awayRestDays,
}: PredictInputs): { home: number; away: number; rationale: string[] } {
  const rationale: string[] = [];
  const logit = (p: number) => Math.log(p / (1 - p));
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const clamp = (x: number, lo = 0.2, hi = 0.8) => Math.min(hi, Math.max(lo, x));

  // Track running home win prob so rationale shows pp swings, not logits.
  let prevP = 0.5;
  const step = (label: string, newLogit: number) => {
    const newP = sigmoid(newLogit);
    const delta = (newP - prevP) * 100;
    const sign = delta >= 0 ? "+" : "";
    rationale.push(`${label} → ${sign}${delta.toFixed(1)}pp (home ${(newP * 100).toFixed(0)}%)`);
    prevP = newP;
  };

  // Composite team strength: 40% Pythagorean, 30% season W%, 20% L10 form,
  // 10% home/away split. Falls back to 0.5 when standings are missing.
  const strength = (s: StandingsRow | undefined, isHome: boolean): number => {
    if (!s) return 0.5;
    const split = isHome ? s.homePct : s.awayPct;
    return 0.4 * s.pythagPct + 0.3 * s.winPct + 0.2 * s.lastTenPct + 0.1 * split;
  };
  const hStrength = clamp(strength(home, true));
  const aStrength = clamp(strength(away, false));
  let lo = logit(hStrength) - logit(aStrength);
  step(
    `Team strength ${(hStrength * 100).toFixed(0)}% vs ${(aStrength * 100).toFixed(0)}% (Pythag·W%·L10·split)`,
    lo,
  );

  // Run-differential signal — explicitly add a small extra term so a
  // dominant run diff isn't washed out by the W% averaging.
  if (home && away) {
    const hRdg = (home.runsScored - home.runsAllowed) / Math.max(1, home.wins + home.losses);
    const aRdg = (away.runsScored - away.runsAllowed) / Math.max(1, away.wins + away.losses);
    const diff = hRdg - aRdg;
    lo += diff * 0.12;
    step(`Run-diff/game ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}`, lo);
  }

  // Home-field edge (MLB historical ~54%).
  lo += 0.18;
  step("Home-field edge", lo);

  // Starting pitcher ERA gap. Two refinements over a raw ERA diff:
  //   • Bayesian shrink toward league mean (4.20) with a 30-IP prior, so
  //     April small samples (e.g. 1 GS, 9.00 ERA) don't dominate the model.
  //   • Coefficient 0.20: a one-run regressed ERA gap ≈ 5pp win-prob swing,
  //     matching public starter-value research (FiveThirtyEight / BPro).
  const regressEra = (era: number | null, ip: number | null | undefined): number | null => {
    if (era == null) return null;
    const prior = 30; // IP prior weight
    const n = ip != null && ip > 0 ? ip : 0;
    return (era * n + 4.2 * prior) / (n + prior);
  };
  const hEraReg = regressEra(homeEra, homeEraIp);
  const aEraReg = regressEra(awayEra, awayEraIp);
  const ht = hEraReg == null ? null : 4.2 - hEraReg;
  const at = aEraReg == null ? null : 4.2 - aEraReg;
  if (ht != null && at != null) {
    lo += (ht - at) * 0.20;
    step(`Starter ERA ${hEraReg!.toFixed(2)} vs ${aEraReg!.toFixed(2)} (regressed)`, lo);
  } else if (ht != null) {
    lo += ht * 0.10;
    step(`Home starter ERA ${hEraReg!.toFixed(2)} vs lg 4.20`, lo);
  } else if (at != null) {
    lo += -at * 0.10;
    step(`Away starter ERA ${aEraReg!.toFixed(2)} vs lg 4.20`, lo);
  }

  // Park factor: amplify logits at hitter parks, compress at pitcher parks.
  const pf = parkFactor(venue);
  if (pf !== 100) {
    const amplify = 1 + (pf - 100) / 200;
    lo = lo * amplify;
    step(`Park factor ${pf} (${venue})`, lo);
  }

  // Full-staff team ERA gap (bullpen + rotation depth signal, distinct from
  // the named starter). League anchor 4.20.
  if (homeStats?.teamEra != null && awayStats?.teamEra != null) {
    lo += ((4.2 - homeStats.teamEra) - (4.2 - awayStats.teamEra)) * 0.10;
    step(`Staff ERA ${homeStats.teamEra.toFixed(2)} vs ${awayStats.teamEra.toFixed(2)}`, lo);
  }

  // Team OPS gap — offensive quality. League OPS anchor .720, scale ×2.5
  // so a .060 OPS edge ≈ 0.15 logit.
  if (homeStats?.ops != null && awayStats?.ops != null) {
    lo += (homeStats.ops - awayStats.ops) * 2.5;
    step(`Team OPS ${homeStats.ops.toFixed(3)} vs ${awayStats.ops.toFixed(3)}`, lo);
  }

  // Rest-days edge: capped at ±2 days, 0.04 logit/day.
  if (homeRestDays != null && awayRestDays != null) {
    const diff = Math.max(-2, Math.min(2, homeRestDays - awayRestDays));
    if (diff !== 0) {
      lo += diff * 0.04;
      step(`Rest days ${homeRestDays} vs ${awayRestDays}`, lo);
    }
  }

  // Calibration shrink — historical hand-tuned models overshoot. Mild ×0.92
  // shrink toward 0 logit improves Brier / log-loss without harming accuracy.
  lo = lo * 0.92;
  step("Calibration shrink ×0.92", lo);

  // Final probability with hard clamp.
  let p = 1 / (1 + Math.exp(-lo));
  p = Math.min(0.85, Math.max(0.15, p));
  if (Math.abs(p - prevP) > 0.001) {
    rationale.push(`Clamp [15%, 85%] → home ${(p * 100).toFixed(0)}%`);
  }
  return { home: p, away: 1 - p, rationale };
}

export async function buildPredictionsForDate(date: string): Promise<PredictedGame[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue,linescore&startDate=${date}&endDate=${date}`;
  const [scheduleRes, standings, teamStats, restMap] = await Promise.all([
    fetchWithTimeout(scheduleUrl),
    fetchStandings(season),
    fetchTeamStats(season),
    fetchRestDays(date),
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games = scheduleJson?.dates?.[0]?.games ?? [];

  const pitcherIds = new Set<number>();
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }
  const pitcherStats = new Map<number, Awaited<ReturnType<typeof fetchPitcherEra>>>();
  await Promise.all(
    Array.from(pitcherIds).map(async (id) => pitcherStats.set(id, await fetchPitcherEra(id, season))),
  );

  return games.map((g: any) => {
    const homeTeam = g.teams.home.team;
    const awayTeam = g.teams.away.team;
    const hs = standings.get(homeTeam.id);
    const as = standings.get(awayTeam.id);
    const hp = g.teams.home.probablePitcher;
    const ap = g.teams.away.probablePitcher;
    const hps = hp ? pitcherStats.get(hp.id) : null;
    const aps = ap ? pitcherStats.get(ap.id) : null;
    const pred = predict({
      home: hs,
      away: as,
      homeEra: hps?.era ?? null,
      awayEra: aps?.era ?? null,
      homeEraIp: hps?.ip ?? null,
      awayEraIp: aps?.ip ?? null,
      venue: g.venue?.name,
      homeStats: teamStats.get(homeTeam.id),
      awayStats: teamStats.get(awayTeam.id),
      homeRestDays: restMap.get(homeTeam.id) ?? null,
      awayRestDays: restMap.get(awayTeam.id) ?? null,
    });

    const side = (raw: any, st: typeof hs, pitcher: any, ps: typeof hps): TeamSide => ({
      id: raw.id,
      name: raw.name,
      abbreviation: raw.abbreviation ?? raw.teamCode?.toUpperCase() ?? "",
      record: st ? `${st.wins}-${st.losses}` : "—",
      winPct: st?.winPct ?? 0.5,
      pitcher: pitcher
        ? {
            id: pitcher.id ?? null,
            name: pitcher.fullName ?? "TBD",
            era: ps?.era ?? null,
            wins: ps?.w ?? null,
            losses: ps?.l ?? null,
            fip: ps?.fip ?? null,
            whip: ps?.whip ?? null,
          }
        : null,
    });

    const home = g.teams.home.score ?? null;
    const away = g.teams.away.score ?? null;
    const statusStr: string = g.status?.detailedState ?? "Scheduled";
    const isFinal = /final|game over|completed/i.test(statusStr);
    let winner: "home" | "away" | null = null;
    let correct: boolean | null = null;
    if (isFinal && typeof home === "number" && typeof away === "number" && home !== away) {
      winner = home > away ? "home" : "away";
      correct = (pred.home >= 0.5 ? "home" : "away") === winner;
    }

    return {
      gameId: g.gamePk,
      date: g.gameDate,
      status: g.status?.detailedState ?? "Scheduled",
      venue: g.venue?.name ?? "—",
      home: side(homeTeam, hs, hp, hps),
      away: side(awayTeam, as, ap, aps),
      homeWinProb: pred.home,
      awayWinProb: pred.away,
      rationale: pred.rationale,
      homeScore: home,
      awayScore: away,
      winner,
      correct,
    } satisfies PredictedGame;
  });
}

/**
 * Run async tasks in sequential batches to avoid bursting the MLB API.
 * Processes up to `batchSize` tasks concurrently, waits for each batch
 * before starting the next. Prevents the per-date burst of 30+ simultaneous
 * HTTP requests that can trigger anti-abuse throttling.
 */
export async function batchedAll<T>(
  tasks: Array<() => Promise<T>>,
  batchSize = 8,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize).map((t) => t());
    results.push(...(await Promise.all(batch)));
  }
  return results;
}