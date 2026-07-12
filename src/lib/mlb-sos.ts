// mlb-sos.ts — strength-of-schedule (opponent + park) deconvolution of the
// season aggregates that feed the Monte Carlo simulator.
//
// The problem this solves: sim-elo-v2 feeds the simulator *raw* season rates.
// A team's observed batting line is partly a story about who it happened to
// face (an April run of division aces deflates it) and where it happened to
// play (half a Coors team's PAs are at altitude, which the sim then counts
// again when it applies the park factor at game time). Symmetrically, a
// pitcher's line is partly the strength of the opposing batting schedule he
// drew. This module removes both biases with a first-order multiplicative
// deconvolution, per event type, so the simulator receives estimates of
// *talent vs a league-average opponent in a neutral park*.
//
// Model: the simulator composes matchup rates multiplicatively —
//   matchup_e ≈ bat_e × (pit_e / lg_e) × park_e
// so observed season rates decompose the same way:
//   observed_bat_e ≈ true_bat_e × avg_g[ pit_e(opp_g)/lg_e ] × avg_g[ park_e(g) ]
// and the adjustment is division by the two schedule averages. Multipliers are
// regressed toward 1 with a games-played prior (April samples) and clamped
// (degenerate inputs). With a perfectly balanced schedule in neutral parks
// every multiplier is exactly 1 and the adjusted rates equal the raw rates —
// which is what keeps sim-elo-v3 a strict superset of sim-elo-v2.
//
// Everything here is pure: callers supply the season game list and the rate
// maps (live: season-to-date; backtest: byDateRange as of the morning), so
// the same code path is exercised by production, the backtest, and the unit
// tests. No fetching, no I/O.

import { parkFactor } from "./park-factors";
import type { BattingRates, PitchingLine, SeasonGameResult } from "./mlb-sim";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A season game with enough context to reconstruct schedules (superset of SeasonGameResult). */
export interface SeasonGame extends SeasonGameResult {
  venue: string | null;
  /** Innings actually played (9 unless extras); null when the feed omits it. */
  innings: number | null;
}

/** Per-event multiplicative schedule bias, 1 = league-average schedule. */
export interface EventMultipliers {
  bb: number;
  so: number;
  hr: number;
  b1: number;
  b2: number;
  b3: number;
}

export interface TeamSos {
  /** Games used to estimate the multipliers (before regression). */
  games: number;
  /** Avg quality of opposing *pitching staffs* faced (for adjusting batting). */
  oppPitching: EventMultipliers;
  /** Avg strength of opposing *batting schedules* faced (for adjusting the staff line). */
  oppBatting: EventMultipliers;
  /** Avg park multiplier experienced, per event (for de-parking observed rates). */
  park: EventMultipliers;
}

export const NEUTRAL_MULTIPLIERS: EventMultipliers = {
  bb: 1,
  so: 1,
  hr: 1,
  b1: 1,
  b2: 1,
  b3: 1,
};

const EVENT_KEYS = ["bb", "so", "hr", "b1", "b2", "b3"] as const;
type EventKey = (typeof EVENT_KEYS)[number];

// ─── Tunables ─────────────────────────────────────────────────────────────────

export interface SosTuning {
  /**
   * Games-played prior toward a neutral schedule. With G games observed the
   * regressed multiplier is (G·M + PRIOR)/(G + PRIOR).
   */
  priorGames: number;
  /**
   * Damping exponent applied to the regressed multiplier (M^λ). Opponent
   * multipliers are estimated from opponents' *observed* lines, so dividing
   * at full strength injects estimation noise comparable to the schedule
   * bias it removes; λ < 1 trades a little residual bias for a lot less
   * variance. Chosen against ground truth in scripts/validate-v3-synthetic.ts.
   */
  lambda: number;
  /**
   * First-order self-contamination correction. An opponent's observed line
   * includes its games against *this* team, so a team's own (lucky or real)
   * deviation leaks into its schedule multiplier with weight ≈ the schedule
   * concentration h = Σ(share of games vs each opponent)². When enabled, the
   * raw multiplier is debiased by h × (own observed deviation) before
   * regression.
   */
  contamCorrection: boolean;
}

/**
 * Defaults selected on synthetic ground truth (see MODEL-ANALYSIS.md Round 4):
 * λ=0.5 with the contamination debias gave the best ensemble RMSE against
 * known true win probabilities across seeds; λ=1 (full-strength division)
 * maximized the sim component alone but *hurt* the ensemble by re-correlating
 * its errors with Elo's.
 */
export const DEFAULT_SOS_TUNING: SosTuning = {
  priorGames: 15,
  lambda: 0.5,
  contamCorrection: true,
};

/** Back-compat alias for the default prior. */
export const SOS_PRIOR_GAMES = DEFAULT_SOS_TUNING.priorGames;

/**
 * Final clamp on regressed multipliers. Real event-rate schedule imbalances
 * are a few percent; anything outside this band is bad data, not schedule.
 */
export const SOS_MULT_MIN = 0.9;
export const SOS_MULT_MAX = 1.12;

/**
 * Per-game opponent multipliers are clamped like the simulator clamps its
 * matchup odds multiplier, so one degenerate opponent line can't dominate.
 */
const PER_GAME_CLAMP_MIN = 0.5;
const PER_GAME_CLAMP_MAX = 2.0;

// ─── Park multipliers (must mirror how the simulator applies parks) ──────────

/**
 * The simulator applies parkMult = √(pf/100) to singles/doubles/triples and
 * parkMult^1.5 = (pf/100)^0.75 to home runs (see paProbs in mlb-sim.ts).
 * Deconvolution must divide by exactly the same per-event factors or the park
 * would be over/under-removed.
 */
export function parkEventMultipliers(venue: string | null | undefined): EventMultipliers {
  const rel = parkFactor(venue) / 100;
  const hitMult = Math.sqrt(rel);
  return {
    bb: 1, // walks/strikeouts are treated as park-neutral by the sim
    so: 1,
    hr: Math.pow(rel, 0.75),
    b1: hitMult,
    b2: hitMult,
    b3: hitMult,
  };
}

// ─── Multiplier math ──────────────────────────────────────────────────────────

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function emptyAccumulator(): Record<EventKey, number> {
  return { bb: 0, so: 0, hr: 0, b1: 0, b2: 0, b3: 0 };
}

/** Per-event ratio of a pitching line (or batting line) to league, clamped. */
function lineVsLeague(
  line: PitchingLine | BattingRates | null | undefined,
  lg: BattingRates,
): EventMultipliers | null {
  if (!line) return null;
  const out = { ...NEUTRAL_MULTIPLIERS };
  for (const ev of EVENT_KEYS) {
    const lgRate = lg[ev];
    out[ev] =
      lgRate > 0
        ? clamp(
            (line as Record<EventKey, number>)[ev] / lgRate,
            PER_GAME_CLAMP_MIN,
            PER_GAME_CLAMP_MAX,
          )
        : 1;
  }
  return out;
}

/** Debias → regress toward 1 → damp (M^λ) → clamp to the sane band. */
export function regressMultiplier(
  rawMean: number,
  games: number,
  tuning: SosTuning = DEFAULT_SOS_TUNING,
): number {
  const regressed = (rawMean * games + tuning.priorGames) / (games + tuning.priorGames);
  const damped = Math.pow(Math.max(0.1, regressed), tuning.lambda);
  return clamp(damped, SOS_MULT_MIN, SOS_MULT_MAX);
}

/** Divide observed rates by schedule multipliers (the deconvolution step). */
export function adjustBattingRates(bat: BattingRates, mult: EventMultipliers): BattingRates {
  return {
    pa: bat.pa,
    bb: bat.bb / mult.bb,
    so: bat.so / mult.so,
    hr: bat.hr / mult.hr,
    b1: bat.b1 / mult.b1,
    b2: bat.b2 / mult.b2,
    b3: bat.b3 / mult.b3,
  };
}

export function adjustPitchingLine(line: PitchingLine, mult: EventMultipliers): PitchingLine {
  return {
    so: line.so / mult.so,
    bb: line.bb / mult.bb,
    hr: line.hr / mult.hr,
    b1: line.b1 / mult.b1,
    b2: line.b2 / mult.b2,
    b3: line.b3 / mult.b3,
  };
}

/** Combine two multiplier sets (e.g. opponent × park) element-wise. */
export function combineMultipliers(a: EventMultipliers, b: EventMultipliers): EventMultipliers {
  const out = { ...NEUTRAL_MULTIPLIERS };
  for (const ev of EVENT_KEYS) out[ev] = a[ev] * b[ev];
  return out;
}

// ─── Team-level SOS from the season game list ─────────────────────────────────

export interface TeamLines {
  batting: BattingRates | null;
  staff: PitchingLine | null;
}

/**
 * Walk every game a team has played before `asOf` (exclusive) and average the
 * opposing staff quality, opposing batting strength, and park experienced.
 * Games on/after `asOf` are ignored even if present in the list, which is the
 * no-lookahead property the backtest and tests rely on.
 *
 * `lines` should hold each team's season-to-date rates as of the same morning;
 * using end-of-window opponent quality for games played earlier is the
 * standard first-order approximation (a full solution would iterate).
 */
export function computeTeamSos(
  teamId: number,
  seasonGames: SeasonGame[],
  lines: Map<number, TeamLines>,
  lg: BattingRates,
  asOf: string,
  tuning: SosTuning = DEFAULT_SOS_TUNING,
): TeamSos {
  const oppPitchSum = emptyAccumulator();
  const oppBatSum = emptyAccumulator();
  const parkSum = emptyAccumulator();
  let oppPitchN = 0;
  let oppBatN = 0;
  let parkN = 0;
  const oppGameCount = new Map<number, number>();

  for (const g of seasonGames) {
    if (g.date >= asOf) continue;
    const isHome = g.home === teamId;
    const isAway = g.away === teamId;
    if (!isHome && !isAway) continue;
    const oppId = isHome ? g.away : g.home;
    const opp = lines.get(oppId);
    oppGameCount.set(oppId, (oppGameCount.get(oppId) ?? 0) + 1);

    const oppStaff = lineVsLeague(opp?.staff, lg);
    if (oppStaff) {
      for (const ev of EVENT_KEYS) oppPitchSum[ev] += oppStaff[ev];
      oppPitchN++;
    }
    const oppBat = lineVsLeague(opp?.batting, lg);
    if (oppBat) {
      for (const ev of EVENT_KEYS) oppBatSum[ev] += oppBat[ev];
      oppBatN++;
    }
    const pk = parkEventMultipliers(g.venue);
    for (const ev of EVENT_KEYS) parkSum[ev] += pk[ev];
    parkN++;
  }

  // Schedule concentration h = Σ share², the weight with which this team's
  // own deviation leaks into its opponents' observed lines (mutual games).
  let h = 0;
  if (parkN > 0) {
    for (const n of oppGameCount.values()) h += (n / parkN) ** 2;
  }

  // Own observed deviations vs league, for the contamination debias.
  const own = lines.get(teamId);
  const ownBatDev = lineVsLeague(own?.batting, lg);
  const ownStaffDev = lineVsLeague(own?.staff, lg);

  const finish = (
    sum: Record<EventKey, number>,
    n: number,
    contamSource: EventMultipliers | null,
  ): EventMultipliers => {
    if (n === 0) return { ...NEUTRAL_MULTIPLIERS };
    const out = { ...NEUTRAL_MULTIPLIERS };
    for (const ev of EVENT_KEYS) {
      let raw = sum[ev] / n;
      if (tuning.contamCorrection && contamSource) {
        raw -= h * (contamSource[ev] - 1);
      }
      out[ev] = regressMultiplier(raw, n, tuning);
    }
    return out;
  };

  return {
    games: parkN,
    // A team's *batting* leaked into opponents' observed staff lines…
    oppPitching: finish(oppPitchSum, oppPitchN, ownBatDev),
    // …and its *staff* leaked into opponents' observed batting lines.
    oppBatting: finish(oppBatSum, oppBatN, ownStaffDev),
    park: finish(parkSum, parkN, null),
  };
}

/** SOS for every team that appears in the game list, in one pass per team. */
export function computeAllTeamSos(
  seasonGames: SeasonGame[],
  lines: Map<number, TeamLines>,
  lg: BattingRates,
  asOf: string,
  tuning: SosTuning = DEFAULT_SOS_TUNING,
): Map<number, TeamSos> {
  const ids = new Set<number>();
  for (const g of seasonGames) {
    if (g.date >= asOf) continue;
    ids.add(g.home);
    ids.add(g.away);
  }
  const out = new Map<number, TeamSos>();
  for (const id of ids) out.set(id, computeTeamSos(id, seasonGames, lines, lg, asOf, tuning));
  return out;
}

// ─── Starter-level SOS from his game log ──────────────────────────────────────

/** One start from a pitcher's game log: who he faced, where, and how many batters. */
export interface StarterLogEntry {
  date: string;
  opponentTeamId: number | null;
  isHome: boolean | null;
  battersFaced: number;
}

/**
 * BF-weighted average of the opposing batting schedules a starter has faced
 * (his subset of the team schedule — an every-fifth-day rotation slot can
 * draw a very different set of lineups than the team as a whole) plus the
 * parks he pitched in. `homeVenueOf` maps a team to its home park so an away
 * start can be located. Falls back to neutral when the log is empty.
 */
export function computeStarterSos(
  log: StarterLogEntry[],
  ownTeamId: number | null,
  lines: Map<number, TeamLines>,
  lg: BattingRates,
  asOf: string,
  homeVenueOf: (teamId: number) => string | null,
  tuning: SosTuning = DEFAULT_SOS_TUNING,
): { oppBatting: EventMultipliers; park: EventMultipliers; starts: number } {
  const oppSum = emptyAccumulator();
  const parkSum = emptyAccumulator();
  let bfTotal = 0;
  let starts = 0;

  for (const entry of log) {
    if (entry.date >= asOf) continue;
    const bf = entry.battersFaced;
    if (!(bf > 0)) continue;
    const oppBat = lineVsLeague(
      entry.opponentTeamId != null ? lines.get(entry.opponentTeamId)?.batting : null,
      lg,
    );
    if (!oppBat) continue;
    const venue =
      entry.isHome == null
        ? null
        : entry.isHome
          ? ownTeamId != null
            ? homeVenueOf(ownTeamId)
            : null
          : entry.opponentTeamId != null
            ? homeVenueOf(entry.opponentTeamId)
            : null;
    const pk = parkEventMultipliers(venue);
    for (const ev of EVENT_KEYS) {
      oppSum[ev] += oppBat[ev] * bf;
      parkSum[ev] += pk[ev] * bf;
    }
    bfTotal += bf;
    starts++;
  }

  if (bfTotal === 0) {
    return { oppBatting: { ...NEUTRAL_MULTIPLIERS }, park: { ...NEUTRAL_MULTIPLIERS }, starts: 0 };
  }
  // Weight the regression by appearances (a start ≈ a "game" of evidence).
  // No contamination debias here: one starter's ~26 BF is ≈1% of an
  // opponent's season PA sample, negligible next to the team-level case.
  const finish = (sum: Record<EventKey, number>): EventMultipliers => {
    const out = { ...NEUTRAL_MULTIPLIERS };
    for (const ev of EVENT_KEYS) out[ev] = regressMultiplier(sum[ev] / bfTotal, starts, tuning);
    return out;
  };
  return { oppBatting: finish(oppSum), park: finish(parkSum), starts };
}

// ─── Rationale helper ─────────────────────────────────────────────────────────

/**
 * Single-number summary of a multiplier set for display: the average absolute
 * offense-relevant tilt, signed by whether the schedule inflated (+) or
 * deflated (−) the observed offense-suppressing events. Used only for
 * rationale strings, never for math.
 */
export function sosSummary(m: EventMultipliers): number {
  // On-base events tell the story; SO moves opposite.
  return (m.bb + m.hr + m.b1 + m.b2 + m.b3) / 5 - 1;
}
