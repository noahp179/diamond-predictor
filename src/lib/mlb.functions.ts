import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const STATS_API = "https://statsapi.mlb.com/api/v1";

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
  } | null;
}

interface StandingsRow {
  teamId: number;
  winPct: number;
  wins: number;
  losses: number;
}

async function fetchStandings(season: number): Promise<Map<number, StandingsRow>> {
  const url = `${STATS_API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`;
  const res = await fetch(url);
  if (!res.ok) return new Map();
  const json: any = await res.json();
  const map = new Map<number, StandingsRow>();
  for (const rec of json.records ?? []) {
    for (const tr of rec.teamRecords ?? []) {
      map.set(tr.team.id, {
        teamId: tr.team.id,
        winPct: parseFloat(tr.winningPercentage ?? "0.5") || 0.5,
        wins: tr.wins ?? 0,
        losses: tr.losses ?? 0,
      });
    }
  }
  return map;
}

async function fetchPitcherEra(personId: number, season: number): Promise<{ era: number | null; w: number | null; l: number | null }> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await fetch(url);
    if (!res.ok) return { era: null, w: null, l: null };
    const json: any = await res.json();
    const split = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return { era: null, w: null, l: null };
    const era = split.era ? parseFloat(split.era) : null;
    return { era: Number.isFinite(era as number) ? era : null, w: split.wins ?? null, l: split.losses ?? null };
  } catch {
    return { era: null, w: null, l: null };
  }
}

function predict(
  homeWinPct: number,
  awayWinPct: number,
  homeEra: number | null,
  awayEra: number | null,
): { home: number; away: number; rationale: string[] } {
  const rationale: string[] = [];
  // log-odds from win pct
  const clamp = (x: number) => Math.min(0.85, Math.max(0.15, x));
  const hp = clamp(homeWinPct);
  const ap = clamp(awayWinPct);
  const logit = (p: number) => Math.log(p / (1 - p));
  let lo = logit(hp) - logit(ap);
  rationale.push(`Season form: ${(hp * 100).toFixed(0)}% vs ${(ap * 100).toFixed(0)}%`);

  // home field
  lo += 0.18;
  rationale.push("Home-field edge: +0.18 log-odds");

  // pitcher ERA differential (lower = better). League avg ~4.20
  if (homeEra != null && awayEra != null) {
    const diff = awayEra - homeEra; // positive => home pitcher better
    const adj = diff * 0.18;
    lo += adj;
    rationale.push(`Starter ERA gap ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} log-odds`);
  } else if (homeEra != null) {
    const adj = (4.2 - homeEra) * 0.1;
    lo += adj;
    rationale.push(`Home starter ERA ${homeEra.toFixed(2)} vs league 4.20`);
  } else if (awayEra != null) {
    const adj = -(4.2 - awayEra) * 0.1;
    lo += adj;
    rationale.push(`Away starter ERA ${awayEra.toFixed(2)} vs league 4.20`);
  }

  const p = 1 / (1 + Math.exp(-lo));
  return { home: p, away: 1 - p, rationale };
}

export const getDailyGames = createServerFn({ method: "GET" })
  .inputValidator(z.object({ date: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const today = data?.date ?? new Date().toISOString().slice(0, 10);
    const season = parseInt(today.slice(0, 4), 10);
    const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue&startDate=${today}&endDate=${today}`;
    const [scheduleRes, standings] = await Promise.all([fetch(scheduleUrl), fetchStandings(season)]);
    if (!scheduleRes.ok) {
      throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
    }
    const scheduleJson: any = await scheduleRes.json();
    const games = scheduleJson?.dates?.[0]?.games ?? [];

    const pitcherIds = new Set<number>();
    for (const g of games) {
      const hp = g.teams?.home?.probablePitcher?.id;
      const ap = g.teams?.away?.probablePitcher?.id;
      if (hp) pitcherIds.add(hp);
      if (ap) pitcherIds.add(ap);
    }
    const pitcherStats = new Map<number, { era: number | null; w: number | null; l: number | null }>();
    await Promise.all(
      Array.from(pitcherIds).map(async (id) => {
        pitcherStats.set(id, await fetchPitcherEra(id, season));
      }),
    );

    const out: PredictedGame[] = games.map((g: any) => {
      const homeTeam = g.teams.home.team;
      const awayTeam = g.teams.away.team;
      const homeStand = standings.get(homeTeam.id);
      const awayStand = standings.get(awayTeam.id);
      const homeWinPct = homeStand?.winPct ?? 0.5;
      const awayWinPct = awayStand?.winPct ?? 0.5;
      const homePitcher = g.teams.home.probablePitcher;
      const awayPitcher = g.teams.away.probablePitcher;
      const homePs = homePitcher ? pitcherStats.get(homePitcher.id) : null;
      const awayPs = awayPitcher ? pitcherStats.get(awayPitcher.id) : null;
      const pred = predict(homeWinPct, awayWinPct, homePs?.era ?? null, awayPs?.era ?? null);

      const sideOf = (teamRaw: any, stand: typeof homeStand, pitcher: any, ps: typeof homePs): TeamSide => ({
        id: teamRaw.id,
        name: teamRaw.name,
        abbreviation: teamRaw.abbreviation ?? teamRaw.teamCode?.toUpperCase() ?? "",
        record: stand ? `${stand.wins}-${stand.losses}` : "—",
        winPct: stand?.winPct ?? 0.5,
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

      return {
        gameId: g.gamePk,
        date: g.gameDate,
        status: g.status?.detailedState ?? "Scheduled",
        venue: g.venue?.name ?? "—",
        home: sideOf(homeTeam, homeStand, homePitcher, homePs),
        away: sideOf(awayTeam, awayStand, awayPitcher, awayPs),
        homeWinProb: pred.home,
        awayWinProb: pred.away,
        rationale: pred.rationale,
      };
    });

    return { date: today, games: out };
  });