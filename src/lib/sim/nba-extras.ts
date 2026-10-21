/**
 * nba-extras.ts — what a team's recent box scores and schedule say that the
 * season totals don't: each player's recent minutes, starts, rebound split and
 * rates, whether he is just back from an absence, and the team's rest and
 * travel. Pure, so the props backtest (from its stored box scores) and the
 * live builder (from ESPN game summaries) compute it the same way.
 */
import { NBA_GEO, nbaMiles } from "./nba-geo";
import type { NbaPlayerExtra, NbaSideExtra } from "./types";

export interface NbaBoxPlayer {
  id: string;
  min: number;
  starter: boolean;
  /** Listed but out: injury, illness, suspension, not with the team. */
  out: boolean;
  oreb: number;
  dreb: number;
  fga: number;
  tpa: number;
  fta: number;
  ast: number;
  tov: number;
  stl: number;
  blk: number;
}

/** A field-goal attempt: shooter, zone, made, assisted. */
export type NbaShot = [string, "rim" | "paint" | "mid" | "corner3" | "ab3", 0 | 1, 0 | 1];

export interface NbaBoxGame {
  /** US calendar day of the game, YYYY-MM-DD. */
  day: string;
  /** Abbreviation of the team whose floor it was played on. */
  venue: string;
  /** This team's players, as the box score listed them. */
  players: NbaBoxPlayer[];
  /** Play-by-play shots: this team's, and its opponent's. */
  shots?: NbaShot[];
  against?: NbaShot[];
}

/** Games of play-by-play read for shot zones. */
export const NBA_ZONE_GAMES = 10;

/** Recent games read for minutes, starts and rates. */
export const NBA_RECENT_GAMES = 10;
/** Recency half-life for minutes, in games. */
export const NBA_RECENT_HALF = 2;

const dayNum = (d: string) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86400000);

/** Per-player extras from one team's games before today (oldest first). */
export function nbaPlayerExtras(
  games: NbaBoxGame[],
  ids: string[],
  k = NBA_RECENT_GAMES,
  half = NBA_RECENT_HALF,
  zk = NBA_ZONE_GAMES,
): Record<string, NbaPlayerExtra> {
  const recent = games.slice(-k);
  const out: Record<string, NbaPlayerExtra> = {};
  // Shot zones, per shooter.
  const z = new Map<
    string,
    { two: number; rim: number; m2: number; a2: number; m3: number; a3: number }
  >();
  for (const g of games.slice(-zk))
    for (const [id, zone, made, ast] of g.shots ?? []) {
      const v = z.get(id) ?? { two: 0, rim: 0, m2: 0, a2: 0, m3: 0, a3: 0 };
      const three = zone === "corner3" || zone === "ab3";
      if (!three) {
        v.two += 1;
        if (zone === "rim") v.rim += 1;
        v.m2 += made;
        v.a2 += made && ast ? 1 : 0;
      } else {
        v.m3 += made;
        v.a3 += made && ast ? 1 : 0;
      }
      z.set(id, v);
    }
  for (const id of ids) {
    let wSum = 0;
    let mSum = 0;
    let rgp = 0;
    const starts: boolean[] = [];
    const played: number[] = [];
    const t = { oreb: 0, dreb: 0, fga: 0, tpa: 0, fta: 0, ast: 0, tov: 0, stl: 0, blk: 0, min: 0 };
    for (let i = recent.length - 1; i >= 0; i--) {
      const p = recent[i].players.find((q) => q.id === id);
      if (!p || p.out) continue;
      const age = recent.length - 1 - i;
      const w = Math.pow(0.5, age / half);
      wSum += w;
      mSum += w * p.min;
      rgp += 1;
      if (starts.length < 5) starts.push(p.starter);
      if (p.min > 0) {
        played.push(p.min);
        for (const key of Object.keys(t) as (keyof typeof t)[])
          t[key] += key === "min" ? p.min : p[key];
      }
    }
    // Which game back after an absence: games played since, and the run of
    // games missed before them, over everything we have.
    let since = 0;
    let missed = 0;
    let i = games.length - 1;
    for (; i >= 0; i--) {
      const p = games[i].players.find((q) => q.id === id);
      if (!p || p.out) break;
      if (p.min > 0) since += 1;
    }
    for (; i >= 0; i--) {
      const p = games[i].players.find((q) => q.id === id);
      if (!p) break;
      if (!p.out) break;
      missed += 1;
    }
    const x: NbaPlayerExtra = {};
    if (rgp > 0) {
      x.rmin = mSum / wSum;
      x.rgp = rgp;
      x.rstarts = starts.filter(Boolean).length;
    }
    if (missed >= 3) x.back = since + 1;
    if (played.length >= 4) {
      const mean = played.reduce((a, b) => a + b, 0) / played.length;
      const sd = Math.sqrt(played.reduce((a, b) => a + (b - mean) ** 2, 0) / (played.length - 1));
      x.minCv = sd / Math.max(1, mean);
    }
    const reb = t.oreb + t.dreb;
    if (reb > 0) {
      x.orebShare = t.oreb / reb;
      x.rebN = reb;
    }
    if (t.min > 0) {
      x.rateMin = t.min;
      x.rates = {
        fg2a: (t.fga - t.tpa) / t.min,
        fg3a: t.tpa / t.min,
        fta: t.fta / t.min,
        ast: t.ast / t.min,
        tov: t.tov / t.min,
        reb: reb / t.min,
        stl: t.stl / t.min,
        blk: t.blk / t.min,
      };
    }
    const zs = z.get(id);
    if (zs) {
      if (zs.two) {
        x.rim = zs.rim / zs.two;
        x.rimN = zs.two;
      }
      if (zs.m2) {
        x.ast2 = zs.a2 / zs.m2;
        x.ast2N = zs.m2;
      }
      if (zs.m3) {
        x.ast3 = zs.a3 / zs.m3;
        x.ast3N = zs.m3;
      }
    }
    out[id] = x;
  }
  return out;
}

const odds = (p: number) => p / Math.max(1e-9, 1 - p);

/**
 * A defense by zone over its recent games, against the league's figures:
 * odds multipliers on rim shots and other twos going in, and on a two being
 * taken at the rim, each regressed toward 1.
 */
export function nbaDefZones(
  games: NbaBoxGame[],
  zk = NBA_ZONE_GAMES,
  lg = { rimFg: 0.676, jumpFg: 0.434, rim: 0.46 },
): { rim: number; jump: number; rimFreq: number } | undefined {
  let ra = 0;
  let rm = 0;
  let ja = 0;
  let jm = 0;
  for (const g of games.slice(-zk))
    for (const [, zone, made] of g.against ?? []) {
      if (zone === "rim") {
        ra += 1;
        rm += made;
      } else if (zone === "paint" || zone === "mid") {
        ja += 1;
        jm += made;
      }
    }
  if (ra + ja < 50) return undefined;
  const regp = (m: number, a: number, p: number, k: number) => (m + k * p) / (a + k);
  return {
    rim: odds(regp(rm, ra, lg.rimFg, 250)) / odds(lg.rimFg),
    jump: odds(regp(jm, ja, lg.jumpFg, 300)) / odds(lg.jumpFg),
    rimFreq: odds(regp(ra, ra + ja, lg.rim, 500)) / odds(lg.rim),
  };
}

/** A team's rest and travel into today's game. */
export function nbaSideExtra(games: NbaBoxGame[], day: string, venue: string): NbaSideExtra {
  const last = games[games.length - 1];
  if (!last) return {};
  const today = dayNum(day);
  const rest = today - dayNum(last.day);
  const inSix = games.filter((g) => today - dayNum(g.day) <= 5).length + 1;
  const a = NBA_GEO[last.venue];
  const b = NBA_GEO[venue];
  return {
    rest,
    g4in6: inSix >= 4,
    miles: Math.round(nbaMiles(last.venue, venue)),
    tzEast: a && b ? b.tz - a.tz : 0,
  };
}
