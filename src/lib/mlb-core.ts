// Pure logic shared by ingestion + live fetch. No imports from .server modules.

export const MODEL_VERSION = "baseline-v0.1";
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
}

export async function fetchStandings(season: number): Promise<Map<number, StandingsRow>> {
  const url = `${STATS_API}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`;
  const res = await fetch(url);
  if (!res.ok) return new Map();
  const json: any = await res.json();
  const map = new Map<number, StandingsRow>();
  for (const rec of json.records ?? []) {
    for (const tr of rec.teamRecords ?? []) {
      map.set(tr.team.id, {
        winPct: parseFloat(tr.winningPercentage ?? "0.5") || 0.5,
        wins: tr.wins ?? 0,
        losses: tr.losses ?? 0,
      });
    }
  }
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

export function predict(
  homeWinPct: number,
  awayWinPct: number,
  homeEra: number | null,
  awayEra: number | null,
): { home: number; away: number; rationale: string[] } {
  const rationale: string[] = [];
  const clamp = (x: number) => Math.min(0.85, Math.max(0.15, x));
  const hp = clamp(homeWinPct);
  const ap = clamp(awayWinPct);
  const logit = (p: number) => Math.log(p / (1 - p));
  let lo = logit(hp) - logit(ap);
  rationale.push(`Season form: ${(hp * 100).toFixed(0)}% vs ${(ap * 100).toFixed(0)}%`);

  lo += 0.18;
  rationale.push("Home-field edge: +0.18 log-odds");

  if (homeEra != null && awayEra != null) {
    const diff = awayEra - homeEra;
    const adj = diff * 0.18;
    lo += adj;
    rationale.push(
      `Starter ERA gap ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} log-odds`,
    );
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
    const homeWinPct = hs?.winPct ?? 0.5;
    const awayWinPct = as?.winPct ?? 0.5;
    const hp = g.teams.home.probablePitcher;
    const ap = g.teams.away.probablePitcher;
    const hps = hp ? pitcherStats.get(hp.id) : null;
    const aps = ap ? pitcherStats.get(ap.id) : null;
    const pred = predict(homeWinPct, awayWinPct, hps?.era ?? null, aps?.era ?? null);

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
    let winner: "home" | "away" | null = null;
    if (typeof home === "number" && typeof away === "number" && home !== away) {
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