// mlb-elo.ts — margin-of-victory Elo for MLB game outcomes.
//
// Why this exists: the MLB game-outcome bake-off (research/mlb-game,
// MLB-GAME-OUTCOME-BAKEOFF.md) ranked 35 algorithms on 9,737 walk-forward games
// (2021-2024, tested on 2024). A margin-of-victory Elo finished at the top;
// the Dixon-Coles / Poisson family this app already ships finished 27th. The
// gap is statistically significant — paired bootstrap over the 2,432 test
// games put Elo ahead by +0.0273 AUC, 95% CI [+0.0106, +0.0448] — and worth
// about +1.2 points of straight-up accuracy (56.3% vs 55.1%).
//
// Two findings from that study are baked into the constants below:
//
//   1. Baseball games carry far less information than football or basketball
//      ones, so K is small (4, vs 20 for the NFL engine in espn.server.ts).
//      Ratings should crawl, not jump.
//   2. The canonical Elo formula — 1 / (1 + 10^(-gap/400)), an effective scale
//      of ~174 rating points — is measurably OVERCONFIDENT for baseball. Fitting
//      the gap-to-probability map on 2021-2023 gave a scale of ~189 points
//      instead. We use the fitted scale, which is what makes the output
//      calibrated (Brier 0.2440 on the held-out season).
//
// Deliberately NOT included: a starting-pitcher adjustment. It reads as an
// obvious win, but the study could not confirm it — adding it moved AUC by
// +0.0039 with a confidence interval spanning zero, and a hyperparameter sweep
// validated on 2023 selected a pitcher weight of exactly 0. Team strength
// already absorbs most of what the rotation contributes. See PITCHER_WEIGHT.

import { STATS_API, fetchWithTimeout } from "./mlb-core";
import { type SeasonGameResult } from "./mlb-sim";

/** Rating move per game. Small on purpose — one baseball game says little. */
const ELO_K = 4;
/** Home-field edge, in rating points (~53% baseline win rate). */
const ELO_HFA = 24;
/** Fraction of a team's rating carried into the next season. */
const ELO_CARRY = 0.7;
/** Completed seasons replayed before the target season so ratings enter warm. */
const WARMUP_SEASONS = 2;
/**
 * Fitted logistic scale mapping an Elo gap to a win probability, from the
 * 2021-2023 training seasons. Larger than the canonical 173.7 because MLB
 * outcomes are noisier than the textbook formula assumes.
 */
const ELO_SCALE = 189.1;
/**
 * Weight on the starting-pitcher term, in rating points per run of difference
 * in the two starters' runs-allowed rates. Backtested at 0 — kept as a named
 * constant so the finding is explicit and the term is one edit away if a future
 * study (with better pitcher data than box-score run support) confirms it.
 */
const PITCHER_WEIGHT = 0;

/** Minimum games in the current season before we publish a prediction. */
const MIN_SEASON_GAMES = 30;

export interface EloPrediction {
  gameId: number;
  date: string;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  /** Home win probability from the fitted Elo scale. */
  homeWinProb: number;
  homeElo: number;
  awayElo: number;
  rationale: string[];
}

/** Replay a list of results into a rating table (mutates and returns it). */
function replay(elo: Map<number, number>, results: SeasonGameResult[]): Map<number, number> {
  const get = (id: number) => elo.get(id) ?? 1500;
  for (const r of results) {
    const rh = get(r.home);
    const ra = get(r.away);
    const homeWon = r.homeScore > r.awayScore ? 1 : 0;
    const expected = 1 / (1 + Math.pow(10, -(rh + ELO_HFA - ra) / 400));
    // Margin multiplier: a blowout moves ratings more than a one-run game, but
    // with sharply diminishing returns (log), so 12-2 isn't treated as 6x 3-1.
    const mov = Math.log(Math.abs(r.homeScore - r.awayScore) + 1);
    const delta = ELO_K * mov * (homeWon - expected);
    elo.set(r.home, rh + delta);
    elo.set(r.away, ra - delta);
  }
  return elo;
}

/** Regress every rating toward the league mean between seasons. */
function carryOver(elo: Map<number, number>): void {
  for (const [id, r] of elo) elo.set(id, 1500 + ELO_CARRY * (r - 1500));
}

/**
 * Final regular-season results in [start, end], fetched lean.
 *
 * mlb-sim's fetchSeasonResults pulls the full schedule payload (~2-3 MB per
 * season). Elo needs four fields per game, and `fields=` trims the same request
 * to ~190 KB — a 91% reduction. That matters because this runs inside the
 * request path: the display fallback in mlb.functions.ts computes Elo live
 * whenever the cron hasn't written rows yet, alongside three other models.
 */
async function fetchResultsLean(start: string, end: string): Promise<SeasonGameResult[]> {
  const url =
    `${STATS_API}/schedule?sportId=1&gameType=R&startDate=${start}&endDate=${end}` +
    `&fields=dates,games,gameDate,teams,home,away,team,id,score,status,detailedState`;
  const res = await fetchWithTimeout(url, 20_000);
  if (!res.ok) return [];
  const json: any = await res.json();
  const out: SeasonGameResult[] = [];
  for (const d of json?.dates ?? []) {
    for (const g of d?.games ?? []) {
      const status: string = g?.status?.detailedState ?? "";
      if (!/final|game over|completed/i.test(status)) continue;
      const h = g?.teams?.home;
      const a = g?.teams?.away;
      if (h?.score == null || a?.score == null) continue;
      out.push({
        date: (g?.gameDate ?? "").slice(0, 10),
        home: h.team.id,
        away: a.team.id,
        homeScore: h.score,
        awayScore: a.score,
      });
    }
  }
  return out;
}

type Rated = { elo: Map<number, number>; seasonGames: number };

// A completed season never changes, so the post-warm-up rating table for a
// given target season is immutable — cache it for a day. Without this, every
// cold request replayed two full prior seasons just to get back to the same
// numbers.
const warmupCache = new Map<number, { at: number; elo: Map<number, number> }>();
const WARMUP_TTL = 24 * 60 * 60 * 1000;
// Ratings for a given (season, date) are immutable too — same reasoning, but
// the current season grows daily, so a shorter TTL.
const ratingsCache = new Map<string, { at: number; value: Rated }>();
const RATINGS_TTL = 6 * 60 * 60 * 1000;

/** Ratings after replaying the warm-up seasons (cached; excludes `season`). */
async function warmupRatings(season: number): Promise<Map<number, number>> {
  const hit = warmupCache.get(season);
  if (hit && Date.now() - hit.at < WARMUP_TTL) return new Map(hit.elo);

  const priorSeasons = Array.from({ length: WARMUP_SEASONS }, (_, i) => season - WARMUP_SEASONS + i);
  const logs = await Promise.all(
    priorSeasons.map((s) => fetchResultsLean(`${s}-03-01`, `${s}-12-31`)),
  );
  const elo = new Map<number, number>();
  for (const log of logs) {
    if (log.length === 0) continue;
    replay(elo, log);
    carryOver(elo);
  }
  warmupCache.set(season, { at: Date.now(), elo });
  return new Map(elo);
}

/**
 * Ratings as of `date`: two prior seasons replayed in full for warm-up, then
 * the current season up to (but not including) `date`. Walk-forward safe — it
 * never reads a game on or after the target date.
 */
export async function computeMlbElo(season: number, date: string): Promise<Rated> {
  const key = `${season}|${date}`;
  const hit = ratingsCache.get(key);
  if (hit && Date.now() - hit.at < RATINGS_TTL) return hit.value;

  const yesterday = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86400000)
    .toISOString()
    .slice(0, 10);
  const [elo, current] = await Promise.all([
    warmupRatings(season),
    fetchResultsLean(`${season}-03-01`, yesterday),
  ]);
  replay(elo, current);

  const value: Rated = { elo, seasonGames: current.length };
  ratingsCache.set(key, { at: Date.now(), value });
  return value;
}

/** Home win probability from two ratings, using the fitted MLB scale. */
export function eloWinProbability(homeElo: number, awayElo: number, pitcherEdge = 0): number {
  const gap = homeElo + ELO_HFA - awayElo + PITCHER_WEIGHT * pitcherEdge;
  return 1 / (1 + Math.exp(-gap / ELO_SCALE));
}

/**
 * Predictions for every game on `date` from the margin-of-victory Elo.
 * Returns [] early in the season (before the fit means anything) or when the
 * schedule is empty — the pipeline simply records no Elo rows that day, exactly
 * like any other model that can't run.
 */
export async function buildEloPredictionsForDate(date: string): Promise<EloPrediction[]> {
  const season = parseInt(date.slice(0, 4), 10);
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&gameType=R&hydrate=probablePitcher,team&startDate=${date}&endDate=${date}`;
  const [scheduleRes, rated] = await Promise.all([
    fetchWithTimeout(scheduleUrl),
    computeMlbElo(season, date),
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];
  if (rated.seasonGames < MIN_SEASON_GAMES) return [];

  const out: EloPrediction[] = [];
  for (const g of games) {
    const home = g.teams?.home?.team;
    const away = g.teams?.away?.team;
    if (!home || !away) continue;
    const he = rated.elo.get(home.id);
    const ae = rated.elo.get(away.id);
    if (he === undefined || ae === undefined) continue; // unseen team, no rating

    const homeWinProb = eloWinProbability(he, ae);
    const favored = homeWinProb >= 0.5 ? home.name : away.name;
    const edge = Math.round(Math.abs(he - ae));
    out.push({
      gameId: g.gamePk,
      date: g.gameDate,
      homeId: home.id,
      awayId: away.id,
      homeName: home.name,
      awayName: away.name,
      homeWinProb,
      homeElo: he,
      awayElo: ae,
      rationale: [
        `Elo ${Math.round(he)} (${home.name}) vs ${Math.round(ae)} (${away.name}) — ${edge}-point gap.`,
        `Home edge worth ${ELO_HFA} points; ${favored} favored at ${Math.round(Math.max(homeWinProb, 1 - homeWinProb) * 100)}%.`,
        `Margin-of-victory Elo, K=${ELO_K}, ${WARMUP_SEASONS}-season warm-up, calibrated on 2021-23.`,
      ],
    });
  }
  return out;
}
