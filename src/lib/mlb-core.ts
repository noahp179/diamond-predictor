// Pure logic shared by ingestion + live fetch. No imports from .server modules.

import { parkFactor } from "./park-factors";

export const MODEL_VERSION = "baseline-v0.4";
export const STATS_API = "https://statsapi.mlb.com/api/v1";

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
}

interface StandingsRow {
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
  const res = await fetch(url);
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
    fetch(`${base}&group=hitting`),
    fetch(`${base}&group=pitching`),
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
    const res = await fetch(url);
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
): Promise<{ era: number | null; w: number | null; l: number | null }> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetch(url);
    if (!res.ok) return { era: null, w: null, l: null };
    const json: any = await res.json();
    const split = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return { era: null, w: null, l: null };
    const era = split.era ? parseFloat(split.era) : null;
    return {
      era: era != null && Number.isFinite(era) ? era : null,
      w: split.wins ?? null,
      l: split.losses ?? null,
    };
  } catch {
    return { era: null, w: null, l: null };
  }
}

export interface PredictInputs {
  home: StandingsRow | undefined;
  away: StandingsRow | undefined;
  homeEra: number | null;
  awayEra: number | null;
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
  venue,
  homeStats,
  awayStats,
  homeRestDays,
  awayRestDays,
}: PredictInputs): { home: number; away: number; rationale: string[] } {
  const rationale: string[] = [];
  const logit = (p: number) => Math.log(p / (1 - p));
  const clamp = (x: number, lo = 0.2, hi = 0.8) => Math.min(hi, Math.max(lo, x));

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
  rationale.push(
    `Team strength: ${(hStrength * 100).toFixed(0)}% vs ${(aStrength * 100).toFixed(0)}% (Pythag·W%·L10·split blend)`,
  );

  // Run-differential signal — explicitly add a small extra term so a
  // dominant run diff isn't washed out by the W% averaging.
  if (home && away) {
    const hRdg = (home.runsScored - home.runsAllowed) / Math.max(1, home.wins + home.losses);
    const aRdg = (away.runsScored - away.runsAllowed) / Math.max(1, away.wins + away.losses);
    const diff = hRdg - aRdg;
    const adj = diff * 0.12;
    lo += adj;
    rationale.push(`Run-diff/game ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`);
  }

  // Home-field edge (MLB historical ~54%).
  lo += 0.18;
  rationale.push("Home-field edge: +0.18 logit");

  // Starting pitcher ERA gap, regressed toward league mean (4.20).
  const eraTerm = (era: number | null) => (era == null ? null : 4.2 - era);
  const ht = eraTerm(homeEra);
  const at = eraTerm(awayEra);
  if (ht != null && at != null) {
    const adj = (ht - at) * 0.16;
    lo += adj;
    rationale.push(
      `Starter ERA ${homeEra!.toFixed(2)} vs ${awayEra!.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`,
    );
  } else if (ht != null) {
    const adj = ht * 0.08;
    lo += adj;
    rationale.push(`Home starter ERA ${homeEra!.toFixed(2)} vs lg 4.20`);
  } else if (at != null) {
    const adj = -at * 0.08;
    lo += adj;
    rationale.push(`Away starter ERA ${awayEra!.toFixed(2)} vs lg 4.20`);
  }

  // Park factor: amplify logits at hitter parks, compress at pitcher parks.
  const pf = parkFactor(venue);
  if (pf !== 100) {
    const amplify = 1 + (pf - 100) / 200;
    lo = lo * amplify;
    rationale.push(`Park factor ${pf} (${venue}) → ×${amplify.toFixed(3)} logit`);
  }

  // Full-staff team ERA gap (bullpen + rotation depth signal, distinct from
  // the named starter). League anchor 4.20.
  if (homeStats?.teamEra != null && awayStats?.teamEra != null) {
    const adj = ((4.2 - homeStats.teamEra) - (4.2 - awayStats.teamEra)) * 0.10;
    lo += adj;
    rationale.push(
      `Staff ERA ${homeStats.teamEra.toFixed(2)} vs ${awayStats.teamEra.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`,
    );
  }

  // Team OPS gap — offensive quality. League OPS anchor .720, scale ×2.5
  // so a .060 OPS edge ≈ 0.15 logit.
  if (homeStats?.ops != null && awayStats?.ops != null) {
    const adj = (homeStats.ops - awayStats.ops) * 2.5;
    lo += adj;
    rationale.push(
      `Team OPS ${homeStats.ops.toFixed(3)} vs ${awayStats.ops.toFixed(3)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`,
    );
  }

  // Rest-days edge: capped at ±2 days, 0.04 logit/day.
  if (homeRestDays != null && awayRestDays != null) {
    const diff = Math.max(-2, Math.min(2, homeRestDays - awayRestDays));
    if (diff !== 0) {
      const adj = diff * 0.04;
      lo += adj;
      rationale.push(`Rest days ${homeRestDays} vs ${awayRestDays} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`);
    }
  }

  // Calibration shrink — historical hand-tuned models overshoot. Mild ×0.92
  // shrink toward 0 logit improves Brier / log-loss without harming accuracy.
  lo = lo * 0.92;

  // Final probability with hard clamp.
  let p = 1 / (1 + Math.exp(-lo));
  p = Math.min(0.85, Math.max(0.15, p));
  return { home: p, away: 1 - p, rationale };
}

export async function buildPredictionsForDate(date: string): Promise<PredictedGame[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue,linescore&startDate=${date}&endDate=${date}`;
  const [scheduleRes, standings, teamStats, restMap] = await Promise.all([
    fetch(scheduleUrl),
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
          }
        : null,
    });

    const home = g.teams.home.score ?? null;
    const away = g.teams.away.score ?? null;
    const statusStr: string = g.status?.detailedState ?? "Scheduled";
    const isFinal = /final|game over|completed/i.test(statusStr);
    let winner: "home" | "away" | null = null;
    if (isFinal && typeof home === "number" && typeof away === "number" && home !== away) {
      winner = home > away ? "home" : "away";
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
    } satisfies PredictedGame;
  });
}