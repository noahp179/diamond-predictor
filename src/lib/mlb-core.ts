// Pure logic shared by ingestion + live fetch. No imports from .server modules.

import { parkFactor } from "./park-factors";

// Re-export so consumers only need one import from this module
export { parkFactor } from "./park-factors";

export const MODEL_VERSION = "baseline-v0.3";
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

export async function fetchPitcherEra(
  personId: number,
  season: number,
): Promise<{
  era: number | null;
  w: number | null;
  l: number | null;
  fip: number | null;
  whip: number | null;
}> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetch(url);
    if (!res.ok) return { era: null, w: null, l: null, fip: null, whip: null };
    const json: any = await res.json();
    const split = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return { era: null, w: null, l: null, fip: null, whip: null };
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

    return {
      era: era != null && Number.isFinite(era) ? era : null,
      w: split.wins ?? null,
      l: split.losses ?? null,
      fip: fip != null && Number.isFinite(fip) ? fip : null,
      whip: whip != null && Number.isFinite(whip) ? whip : null,
    };
  } catch {
    return { era: null, w: null, l: null, fip: null, whip: null };
  }
}

export interface PredictInputs {
  home: StandingsRow | undefined;
  away: StandingsRow | undefined;
  homeEra: number | null;
  awayEra: number | null;
  venue?: string | null;
}

/**
 * Probabilistic blend in log-odds space. Each feature contributes a
 * coefficient-weighted logit term derived from a blended team-strength
 * estimate plus matchup adjustments. Coefficients are hand-tuned from
 * public MLB priors and clamped to keep predictions in [0.10, 0.90].
 */
export function predict({ home, away, homeEra, awayEra, venue }: PredictInputs): {
  home: number;
  away: number;
  rationale: string[];
} {
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

  // Final probability with hard clamp to keep tails honest.
  let p = 1 / (1 + Math.exp(-lo));
  p = Math.min(0.9, Math.max(0.1, p));
  return { home: p, away: 1 - p, rationale };
}

export async function buildPredictionsForDate(date: string): Promise<PredictedGame[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue,linescore&startDate=${date}&endDate=${date}`;
  const [scheduleRes, standings] = await Promise.all([fetch(scheduleUrl), fetchStandings(season)]);
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