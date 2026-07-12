// mlb-context.ts — the game-context layer of sim-elo-v3: streaks, recent
// scoring form, rest, schedule density, travel, and bullpen stress, expressed
// as one small logit adjustment on top of the sim+Elo ensemble.
//
// Design rules, learned from this repo's own history (baseline-v0.4 stacked
// correlated signals and lost to "always pick home"):
//   1. Only signals the ensemble can't already see. Elo carries slow-moving
//      form; season rates carry talent. This layer gets the *orthogonal*
//      residue: schedule shape (who's tired, who flew a red-eye, whose pen
//      just threw 12 innings) and short-horizon form beyond the season level.
//   2. Every term is tiny (single-digit percentage points at the extremes),
//      individually flag-gated for ablation, and the summed delta is hard-
//      capped so context can never overturn the main signals.
//   3. Coefficients ship as literature-informed priors and are meant to be
//      re-fit by scripts/backtest-v3.ts --tune on the dev window; the config
//      object below is the single place a tuned set drops into.
//
// Everything is pure and derived from the season game list (dates, teams,
// venues, scores, innings) — zero extra API calls beyond what the model
// already fetches.

import { venueDistanceKm, venueTzShift } from "./stadium-geo";
import type { SeasonGame } from "./mlb-sos";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface ContextConfig {
  /** Signed win streak, logit per game (capped at ±streakCap games). */
  streakCoef: number;
  streakCap: number;
  /** Recent run-diff/game minus season run-diff/game, logit per run (capped ±formCap). */
  formCoef: number;
  formDays: number;
  formCap: number;
  /** Rest-days advantage, logit per day (each side capped at restCapDays). */
  restCoef: number;
  restCapDays: number;
  /** Schedule density: logit per game played in the last 7 days beyond 6. */
  densityCoef: number;
  /** Travel since previous game: logit per 1000 km (only the day after arrival). */
  travelCoef: number;
  /** Time zones crossed since previous game, logit per zone; eastward weighted extra. */
  tzCoef: number;
  tzEastwardMult: number;
  /** Bullpen stress from yesterday/day-before extras and blowout innings. */
  penStressCoef: number;
  /** Hard cap on the summed |home − away| context delta, in logits. */
  totalCap: number;
  enabled: {
    streak: boolean;
    form: boolean;
    rest: boolean;
    density: boolean;
    travel: boolean;
    tz: boolean;
    penStress: boolean;
  };
}

/**
 * Default coefficients — conservative priors, in logits, pending the dev-set
 * tune (a 0.04 logit ≈ 1pp on a coin-flip game):
 *   streak    0.006/g  — momentum literature finds almost nothing beyond team
 *                        strength; ±8-game cap ⇒ at most ±0.048.
 *   form      0.03/run — 14-day run diff vs season level; catches roster
 *                        turns/injuries faster than season aggregates. ±2.5 cap.
 *   rest      0.03/day — matches v0.4's prior and Cui et al.; ±... cap 4 days.
 *   density   0.012/g  — 7+ games in 7 days (doubleheaders) grinds a roster.
 *   travel    0.015/Mm — ~0.05 logit for a coast-to-coast red-eye.
 *   tz        0.015/zone, ×1.5 eastward — Song/Severini/Allada (PNAS 2017)
 *                        measured eastward jet lag at roughly a home-edge.
 *   penStress 0.02     — extras/blowout yesterday ⇒ short bullpen today.
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  streakCoef: 0.006,
  streakCap: 8,
  formCoef: 0.03,
  formDays: 14,
  formCap: 2.5,
  restCoef: 0.03,
  restCapDays: 4,
  densityCoef: 0.012,
  travelCoef: 0.015,
  tzCoef: 0.015,
  tzEastwardMult: 1.5,
  penStressCoef: 0.02,
  totalCap: 0.15,
  enabled: {
    streak: true,
    form: true,
    rest: true,
    density: true,
    travel: true,
    tz: true,
    penStress: true,
  },
};

/** All context features off — sim-elo-v3 degenerates to the SOS-only model. */
export const CONTEXT_DISABLED: ContextConfig = {
  ...DEFAULT_CONTEXT_CONFIG,
  enabled: {
    streak: false,
    form: false,
    rest: false,
    density: false,
    travel: false,
    tz: false,
    penStress: false,
  },
};

// ─── Per-team context features ────────────────────────────────────────────────

export interface TeamContext {
  teamId: number;
  gamesPlayed: number;
  /** Signed current streak: +3 = won last 3, −2 = lost last 2. */
  streak: number;
  /** Run diff per game over the last `formDays` days. Null with no games. */
  recentRunDiff: number | null;
  /** Season run diff per game. */
  seasonRunDiff: number | null;
  /** Full days off before `date` (0 = played yesterday), capped at 7. */
  restDays: number;
  /** Games played in the 7 days before `date` (doubleheaders count twice). */
  gamesLast7: number;
  /** Venue of the team's most recent game, for travel computation. */
  lastVenue: string | null;
  /** Date of the team's most recent game. */
  lastGameDate: string | null;
  /**
   * Bullpen stress score: 1.0 per extra-inning game yesterday, 0.5 per
   * 7+-runs-allowed game yesterday, half again for the day before.
   */
  penStress: number;
}

function daysBetweenISO(from: string, to: string): number {
  return Math.round(
    (new Date(to + "T12:00:00Z").getTime() - new Date(from + "T12:00:00Z").getTime()) / 86_400_000,
  );
}

/**
 * Derive one team's context from the season game list, using only games
 * strictly before `date` (the no-lookahead property — future games in the
 * list are ignored).
 */
export function computeTeamContext(
  teamId: number,
  seasonGames: SeasonGame[],
  date: string,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): TeamContext {
  const played = seasonGames
    .filter((g) => g.date < date && (g.home === teamId || g.away === teamId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let wins = 0;
  let runsFor = 0;
  let runsAgainst = 0;
  let recentFor = 0;
  let recentAgainst = 0;
  let recentGames = 0;
  let gamesLast7 = 0;
  let penStress = 0;

  for (const g of played) {
    const isHome = g.home === teamId;
    const rf = isHome ? g.homeScore : g.awayScore;
    const ra = isHome ? g.awayScore : g.homeScore;
    runsFor += rf;
    runsAgainst += ra;
    if (rf > ra) wins++;
    const age = daysBetweenISO(g.date, date);
    if (age <= cfg.formDays) {
      recentFor += rf;
      recentAgainst += ra;
      recentGames++;
    }
    if (age <= 7) gamesLast7++;
    if (age === 1 || age === 2) {
      const weight = age === 1 ? 1 : 0.5;
      if ((g.innings ?? 9) >= 10) penStress += 1.0 * weight;
      if (ra >= 7) penStress += 0.5 * weight;
    }
  }

  // Signed streak from the tail of the ordered list.
  let streak = 0;
  for (let i = played.length - 1; i >= 0; i--) {
    const g = played[i];
    const won =
      (g.home === teamId ? g.homeScore : g.awayScore) >
      (g.home === teamId ? g.awayScore : g.homeScore);
    if (streak === 0) streak = won ? 1 : -1;
    else if (streak > 0 && won) streak++;
    else if (streak < 0 && !won) streak--;
    else break;
  }

  const last = played[played.length - 1] ?? null;
  const n = played.length;
  return {
    teamId,
    gamesPlayed: n,
    streak,
    recentRunDiff: recentGames > 0 ? (recentFor - recentAgainst) / recentGames : null,
    seasonRunDiff: n > 0 ? (runsFor - runsAgainst) / n : null,
    restDays: last ? Math.min(7, Math.max(0, daysBetweenISO(last.date, date) - 1)) : 3,
    gamesLast7,
    lastVenue: last?.venue ?? null,
    lastGameDate: last?.date ?? null,
    penStress,
  };
}

// ─── The logit delta ──────────────────────────────────────────────────────────

export interface ContextTerm {
  name: string;
  value: number; // logit contribution, + favors home
  detail: string;
}

export interface ContextDelta {
  total: number; // capped sum, + favors home
  terms: ContextTerm[];
}

const clampAbs = (x: number, cap: number) => Math.max(-cap, Math.min(cap, x));

/**
 * Home-minus-away context adjustment in logit space for a game played at
 * `venue` on `date`. Each term is computed symmetrically for both sides and
 * enters as (homeEffect − awayEffect); the sum is capped at ±cfg.totalCap.
 */
export function contextLogitDelta(
  home: TeamContext,
  away: TeamContext,
  venue: string | null,
  date: string,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): ContextDelta {
  const terms: ContextTerm[] = [];

  if (cfg.enabled.streak) {
    const h = clampAbs(home.streak, cfg.streakCap);
    const a = clampAbs(away.streak, cfg.streakCap);
    const v = (h - a) * cfg.streakCoef;
    if (v !== 0) {
      terms.push({
        name: "streak",
        value: v,
        detail: `streak ${home.streak > 0 ? "W" : "L"}${Math.abs(home.streak)} vs ${away.streak > 0 ? "W" : "L"}${Math.abs(away.streak)}`,
      });
    }
  }

  if (cfg.enabled.form && home.recentRunDiff != null && away.recentRunDiff != null) {
    // Recent scoring form *beyond* the season level, so it never double-counts
    // the talent signal already inside the sim's season rates.
    const h = clampAbs(home.recentRunDiff - (home.seasonRunDiff ?? 0), cfg.formCap);
    const a = clampAbs(away.recentRunDiff - (away.seasonRunDiff ?? 0), cfg.formCap);
    const v = (h - a) * cfg.formCoef;
    if (v !== 0) {
      terms.push({
        name: "form",
        value: v,
        detail: `${cfg.formDays}d run-diff ${home.recentRunDiff.toFixed(1)} vs ${away.recentRunDiff.toFixed(1)} (vs season)`,
      });
    }
  }

  if (cfg.enabled.rest) {
    const h = Math.min(home.restDays, cfg.restCapDays);
    const a = Math.min(away.restDays, cfg.restCapDays);
    const v = (h - a) * cfg.restCoef;
    if (v !== 0) {
      terms.push({ name: "rest", value: v, detail: `rest ${home.restDays}d vs ${away.restDays}d` });
    }
  }

  if (cfg.enabled.density) {
    // Penalty only above the normal 6-in-7 rhythm, so a typical week is 0.
    const h = Math.max(0, home.gamesLast7 - 6);
    const a = Math.max(0, away.gamesLast7 - 6);
    const v = -(h - a) * cfg.densityCoef;
    if (v !== 0) {
      terms.push({
        name: "density",
        value: v,
        detail: `games last 7d: ${home.gamesLast7} vs ${away.gamesLast7}`,
      });
    }
  }

  // Travel and time zones only bite the day after arrival; after a full rest
  // day at the destination the effect is treated as absorbed.
  const travelFor = (t: TeamContext): { km: number; tz: number } => {
    if (!t.lastGameDate || !t.lastVenue) return { km: 0, tz: 0 };
    if (daysBetweenISO(t.lastGameDate, date) > 2) return { km: 0, tz: 0 };
    const km = venueDistanceKm(t.lastVenue, venue) ?? 0;
    const tz = venueTzShift(t.lastVenue, venue) ?? 0;
    return { km, tz };
  };
  const hT = travelFor(home);
  const aT = travelFor(away);

  if (cfg.enabled.travel) {
    const v = -((hT.km - aT.km) / 1000) * cfg.travelCoef;
    if (Math.abs(v) > 1e-9) {
      terms.push({
        name: "travel",
        value: v,
        detail: `travel ${hT.km.toFixed(0)}km vs ${aT.km.toFixed(0)}km`,
      });
    }
  }

  if (cfg.enabled.tz) {
    // Eastward shifts (losing hours) hurt more than westward.
    const cost = (tz: number) => Math.abs(tz) * cfg.tzCoef * (tz > 0 ? cfg.tzEastwardMult : 1);
    const v = -(cost(hT.tz) - cost(aT.tz));
    if (Math.abs(v) > 1e-9) {
      terms.push({ name: "tz", value: v, detail: `tz shift ${hT.tz} vs ${aT.tz}` });
    }
  }

  if (cfg.enabled.penStress) {
    const v = -(home.penStress - away.penStress) * cfg.penStressCoef;
    if (Math.abs(v) > 1e-9) {
      terms.push({
        name: "penStress",
        value: v,
        detail: `pen stress ${home.penStress.toFixed(1)} vs ${away.penStress.toFixed(1)}`,
      });
    }
  }

  const raw = terms.reduce((s, t) => s + t.value, 0);
  return { total: clampAbs(raw, cfg.totalCap), terms };
}
