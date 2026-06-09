// mlb-features.ts
// Additional predictive feature fetchers for model v0.4.
// All endpoints are free, public, no API key required: statsapi.mlb.com
// Each function is pure/async and safe to call in parallel batches.

import { STATS_API } from "./mlb-core";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeamHittingStats {
  obp: number | null;
  slg: number | null;
  ops: number | null; // obp + slg
}

export interface TeamPitchingStats {
  era: number | null;
  whip: number | null;
  kbb: number | null; // strikeouts / walks
}

export interface RestInfo {
  daysSinceLastGame: number; // capped at 7
}

export interface L5Record {
  wins: number;
  losses: number;
  pct: number; // 0.0–1.0, defaults to 0.5 when unknown
}

export interface HeadToHeadRecord {
  homeWins: number;
  awayWins: number;
  totalGames: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Offset an ISO date string by `days` days (UTC-safe). */
export function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T12:00:00Z").getTime();
  const b = new Date(to + "T12:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000);
}

// ─── Feature Fetchers ─────────────────────────────────────────────────────────

/**
 * Team season batting stats: OBP, SLG, OPS.
 * Endpoint: /teams/{id}/stats?stats=season&group=hitting&season={year}
 */
export async function fetchTeamHitting(
  teamId: number,
  season: number,
): Promise<TeamHittingStats> {
  try {
    const url = `${STATS_API}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`;
    const res = await fetch(url);
    if (!res.ok) return { obp: null, slg: null, ops: null };
    const json: any = await res.json();
    const stat = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return { obp: null, slg: null, ops: null };
    const obp = stat.obp ? parseFloat(stat.obp) : null;
    const slg = stat.slg ? parseFloat(stat.slg) : null;
    return {
      obp,
      slg,
      ops: obp != null && slg != null ? Number((obp + slg).toFixed(4)) : null,
    };
  } catch {
    return { obp: null, slg: null, ops: null };
  }
}

/**
 * Team season pitching stats: ERA, WHIP, K/BB ratio.
 * Includes starters + bullpen (holistic staff quality signal).
 * Endpoint: /teams/{id}/stats?stats=season&group=pitching&season={year}
 */
export async function fetchTeamPitching(
  teamId: number,
  season: number,
): Promise<TeamPitchingStats> {
  try {
    const url = `${STATS_API}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetch(url);
    if (!res.ok) return { era: null, whip: null, kbb: null };
    const json: any = await res.json();
    const stat = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return { era: null, whip: null, kbb: null };
    const era = stat.era ? parseFloat(stat.era) : null;
    const whip = stat.whip ? parseFloat(stat.whip) : null;
    const k = stat.strikeOuts ?? null;
    const bb = stat.baseOnBalls ?? null;
    return {
      era,
      whip,
      kbb: k != null && bb != null && bb > 0 ? Number((k / bb).toFixed(3)) : null,
    };
  } catch {
    return { era: null, whip: null, kbb: null };
  }
}

/**
 * Days since the team's last game before `date`.
 * Looks back up to 8 days. Returns 1 if played yesterday (typical), 3 if not found.
 * Endpoint: /schedule?teamId={id}&startDate=...&endDate=yesterday
 */
export async function fetchRestDays(
  teamId: number,
  date: string,
): Promise<RestInfo> {
  try {
    const endDate = offsetDate(date, -1);
    const startDate = offsetDate(date, -9);
    const url = `${STATS_API}/schedule?teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&sportId=1`;
    const res = await fetch(url);
    if (!res.ok) return { daysSinceLastGame: 1 };
    const json: any = await res.json();

    // Collect all dates that had games, sorted ascending
    const gameDates: string[] = [];
    for (const entry of json?.dates ?? []) {
      if ((entry?.games?.length ?? 0) > 0) gameDates.push(entry.date as string);
    }
    if (gameDates.length === 0) return { daysSinceLastGame: 3 };

    const lastGameDate = gameDates[gameDates.length - 1];
    const diff = daysBetween(lastGameDate, date);
    return { daysSinceLastGame: Math.min(Math.max(diff, 1), 7) };
  } catch {
    return { daysSinceLastGame: 1 };
  }
}

/**
 * Win/loss record over last N completed games before `date`.
 * Looks back up to (n*2 + 5) days to fill the window across off-days.
 * Endpoint: /schedule?teamId={id}&startDate=...&endDate=...
 */
export async function fetchLastNGames(
  teamId: number,
  date: string,
  n: number = 5,
): Promise<L5Record> {
  try {
    const endDate = offsetDate(date, -1);
    const startDate = offsetDate(date, -(n * 2 + 7));
    const url = `${STATS_API}/schedule?teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&sportId=1`;
    const res = await fetch(url);
    if (!res.ok) return { wins: 0, losses: 0, pct: 0.5 };
    const json: any = await res.json();

    // Walk entries newest-first
    const entries: any[] = [...(json?.dates ?? [])].reverse();
    let wins = 0;
    let losses = 0;

    for (const entry of entries) {
      for (const game of [...(entry?.games ?? [])].reverse()) {
        const isFinal = /final|game over|completed/i.test(
          game?.status?.detailedState ?? "",
        );
        if (!isFinal) continue;
        const homeScore: number | null = game.teams?.home?.score ?? null;
        const awayScore: number | null = game.teams?.away?.score ?? null;
        if (homeScore == null || awayScore == null || homeScore === awayScore) continue;

        const teamIsHome = game.teams?.home?.team?.id === teamId;
        const homeWon = homeScore > awayScore;
        const teamWon = teamIsHome ? homeWon : !homeWon;
        if (teamWon) wins++; else losses++;

        if (wins + losses >= n) break;
      }
      if (wins + losses >= n) break;
    }

    const total = wins + losses;
    return { wins, losses, pct: total > 0 ? wins / total : 0.5 };
  } catch {
    return { wins: 0, losses: 0, pct: 0.5 };
  }
}

/**
 * Head-to-head record between the two teams this season, up to (but not including) `date`.
 * Endpoint: /schedule?teamId={homeId}&opponentId={awayId}&startDate=season-start&endDate=yesterday
 */
export async function fetchHeadToHead(
  homeTeamId: number,
  awayTeamId: number,
  season: number,
  date: string,
): Promise<HeadToHeadRecord> {
  try {
    const startDate = `${season}-03-01`;
    const endDate = offsetDate(date, -1);
    const url = `${STATS_API}/schedule?teamId=${homeTeamId}&opponentId=${awayTeamId}&startDate=${startDate}&endDate=${endDate}&sportId=1`;
    const res = await fetch(url);
    if (!res.ok) return { homeWins: 0, awayWins: 0, totalGames: 0 };
    const json: any = await res.json();

    let homeWins = 0;
    let awayWins = 0;
    let totalGames = 0;

    for (const entry of json?.dates ?? []) {
      for (const game of entry?.games ?? []) {
        const isFinal = /final|game over|completed/i.test(
          game?.status?.detailedState ?? "",
        );
        if (!isFinal) continue;
        const gameHomeId: number = game.teams?.home?.team?.id;
        const homeScore: number = game.teams?.home?.score ?? 0;
        const awayScore: number = game.teams?.away?.score ?? 0;
        if (homeScore === awayScore) continue;

        totalGames++;
        const gameHomeWon = homeScore > awayScore;
        // Map to our home/away perspective
        if (gameHomeId === homeTeamId) {
          if (gameHomeWon) homeWins++; else awayWins++;
        } else {
          // Our target home team was the visiting team in this game
          if (!gameHomeWon) homeWins++; else awayWins++;
        }
      }
    }

    return { homeWins, awayWins, totalGames };
  } catch {
    return { homeWins: 0, awayWins: 0, totalGames: 0 };
  }
}
