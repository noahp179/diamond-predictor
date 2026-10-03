/**
 * cfb-ratings.server.ts — how good each college team is, after its schedule.
 *
 * College season statistics cannot be taken at face value the way NFL ones
 * can: twelve games against opponents that range from the national champion
 * to an FCS team, and no two schedules alike. A defense that allows 4.0 yards a
 * carry in the MAC and one that allows 4.0 in the SEC are not the same
 * defense. Played from statistics alone, simulated college games came out
 * about half as far apart as the market has them (FBS slate of October 3,
 * 2026: slope 0.47 against the posted spreads, correlation 0.87).
 *
 * So each team also gets a rating: its margin against an average FBS team on a
 * neutral field, from a ridge regression of every game's final margin on the
 * two teams and home field (a "simple rating system"), this season's games
 * weighted fully and last season's carried in as the prior. FCS games are read
 * too, so an FCS opponent is rated on its own season (Texas Southern is not
 * North Dakota State), tied to the FBS through the games between them.
 * Margins are capped at 35 so a team is not rewarded for running up a score.
 *
 * Only finished games before the date are used, and no market lines.
 */

import { ESPN_PATH, seasonFor, teamStats } from "./espn-stats.server";

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const HOUR = 60 * 60 * 1000;
/** Where an FCS team starts before its results say otherwise. */
const FCS_PRIOR = -22;
const CAP = 35;
/** Ridge strength, in games: how many games of evidence it takes to move a
 *  team halfway from its prior. */
const LAMBDA = 3;
/** Share of last season's rating a team carries into this one. */
const CARRY = 0.6;

type Final = { date: string; home: string; away: string; hs: number; as: number; neutral: boolean };

type Board = {
  events?: {
    date: string;
    status?: { type?: { completed?: boolean } };
    competitions?: {
      neutralSite?: boolean;
      competitors: { homeAway: "home" | "away"; score?: string; team: { id: string } }[];
    }[];
  }[];
};

const cache = new Map<string, { at: number; v: Promise<unknown> }>();
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as Promise<T>;
  const v = load();
  cache.set(key, { at: Date.now(), v });
  v.catch(() => cache.delete(key));
  return v;
}

async function getJson<T>(url: string): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 800 * i * i));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`ESPN ${res.status}: ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Every finished FBS (group 80) and FCS (81) regular-season game of a
 *  season, week by week. */
function finals(season: number, current: boolean): Promise<Final[]> {
  return cached(`cfbfinals:${season}`, current ? HOUR : 24 * HOUR, async () => {
    const weeks = Array.from({ length: 17 }, (_, i) => i + 1);
    const boards = await Promise.all(
      [80, 81].flatMap((group) =>
        weeks.map((w) =>
          getJson<Board>(
            `${SITE}/${ESPN_PATH.cfb}/scoreboard?groups=${group}&seasontype=2&week=${w}&dates=${season}&limit=500`,
          ).catch(() => ({}) as Board),
        ),
      ),
    );
    const out: Final[] = [];
    const seen = new Set<string>();
    for (const b of boards)
      for (const e of b.events ?? []) {
        const c = e.competitions?.[0];
        const h = c?.competitors.find((x) => x.homeAway === "home");
        const a = c?.competitors.find((x) => x.homeAway === "away");
        if (!c || !e.status?.type?.completed || !h || !a) continue;
        const key = `${e.date}:${h.team.id}:${a.team.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          date: e.date.slice(0, 10),
          home: h.team.id,
          away: a.team.id,
          hs: Number(h.score ?? 0),
          as: Number(a.score ?? 0),
          neutral: c.neutralSite === true,
        });
      }
    return out.sort((x, y) => x.date.localeCompare(y.date));
  });
}

/**
 * Ridge least squares: margin = r[home] − r[away] + h·(home field), each
 * rating pulled toward its prior with weight LAMBDA. Solved by Gauss–Jordan on
 * the normal equations (~140 teams).
 */
function fit(
  games: Final[],
  fbs: Set<string>,
  prior: Map<string, number>,
): { r: Map<string, number>; hfa: number } {
  const ids = [...new Set(games.flatMap((g) => [g.home, g.away]))];
  const ix = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length + 1; // last unknown: home field
  const A = Array.from({ length: n }, () => new Float64Array(n));
  const b = new Float64Array(n);
  for (const g of games) {
    const i = ix.get(g.home)!;
    const j = ix.get(g.away)!;
    if (i === j) continue;
    const y = Math.max(-CAP, Math.min(CAP, g.hs - g.as));
    const x: [number, number][] = [
      [i, 1],
      [j, -1],
    ];
    if (!g.neutral) x.push([n - 1, 1]);
    for (const [p, vp] of x) {
      b[p] += vp * y;
      for (const [q, vq] of x) A[p][q] += vp * vq;
    }
  }
  ids.forEach((id, i) => {
    A[i][i] += LAMBDA;
    b[i] += LAMBDA * (prior.get(id) ?? (fbs.has(id) ? 0 : FCS_PRIOR));
  });
  A[n - 1][n - 1] += 10;
  b[n - 1] += 10 * 2.5;
  // Gauss–Jordan elimination with partial pivoting.
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c || A[r][c] === 0) continue;
      const f = A[r][c] / d;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const r = new Map<string, number>();
  ids.forEach((id, i) => r.set(id, b[i] / A[i][i]));
  // Centre on the FBS average.
  const fbsR = [...r].filter(([id]) => fbs.has(id)).map(([, v]) => v);
  const mean = fbsR.reduce((a, v) => a + v, 0) / Math.max(1, fbsR.length);
  for (const [id, v] of r) r.set(id, v - mean);
  return { r, hfa: b[n - 1] / A[n - 1][n - 1] };
}

export type CfbRatings = {
  of: (id: string) => number;
  hfa: number;
  games: number;
  /** Points a team scores in a game between two FBS teams — the level the
   *  standings overstate, since they count the routs of FCS opponents. */
  ppg: number;
};

/** Ratings as of a date: last season's carried in, this season's games on top. */
export function cfbRatings(date: string): Promise<CfbRatings> {
  const season = seasonFor("cfb", date);
  return cached(`cfbratings:${season}:${date}`, HOUR, async () => {
    const [prevGames, curGames, tsCur, tsOld] = await Promise.all([
      finals(season - 1, false),
      finals(season, true),
      teamStats("cfb", season, true).catch(() => new Map()),
      teamStats("cfb", season - 1, false).catch(() => new Map()),
    ]);
    const fbs = new Set<string>([...tsCur.keys(), ...tsOld.keys()]);
    const last = fit(prevGames, fbs, new Map());
    const prior = new Map<string, number>();
    for (const [id, v] of last.r)
      prior.set(id, fbs.has(id) ? CARRY * v : FCS_PRIOR + CARRY * (v - FCS_PRIOR));
    const games = curGames.filter((g) => g.date < date);
    const now = games.length ? fit(games, fbs, prior) : { r: prior, hfa: last.hfa };
    const level = (gs: Final[]) => {
      const both = gs.filter((g) => fbs.has(g.home) && fbs.has(g.away));
      return both.length ? both.reduce((a, g) => a + g.hs + g.as, 0) / (2 * both.length) : 0;
    };
    const fbsGames = games.filter((g) => fbs.has(g.home) && fbs.has(g.away)).length;
    return {
      of: (id: string) => now.r.get(id) ?? (fbs.has(id) ? 0 : FCS_PRIOR),
      hfa: now.hfa,
      games: games.length,
      ppg: fbsGames >= 100 ? level(games) : level(prevGames) || level(games),
    };
  });
}
