// mlb-models.ts — the model registry and the track-record window.
// Client-safe constants shared by the pipeline (server), the track-record
// server function, and the Track Record page (client).

import { MODEL_VERSION_BLEND } from "./mlb-blend";

/**
 * The Track Record page starts its clock here. This is a clean relaunch: every
 * model below — including the newly promoted Poisson (Dixon-Coles) analytic
 * model — starts from a zero baseline on this date and is scored identically on
 * every settled game from here forward. Graphs begin empty and build day by day,
 * so all lines start together at the same point instead of inheriting the
 * partial, uneven history of the earlier tracking era.
 */
export const TRACK_RECORD_START = "2026-07-16";

/**
 * The Poisson "goal simulator" (Dixon-Coles) ported from soccer to baseball with
 * the two parts baseball demands: a starting-pitcher quality multiplier on the
 * scoring rate and negative-binomial (overdispersed) scoring instead of pure
 * Poisson. Round 11a found this the best analytic model of the program — 57.2%
 * accuracy / 0.2480 Brier on the frozen test window, ahead of the sim headline
 * and a hair better than every recent-form build on Brier — and it runs in
 * milliseconds with no Monte Carlo. Fit walk-forward on season-to-date results;
 * knobs frozen from the dev study. See src/lib/mlb-dixon-coles.ts.
 */
export const MODEL_VERSION_DIXON = "dixon-coles-nb";

/** The devigged DraftKings line stored as a reference "model" — the benchmark to beat. */
export const MODEL_VERSION_MARKET = "market-devig";

/**
 * Experimental: the sim-elo-v2 engine (unchanged) fed trailing 21/45-day
 * form instead of season-to-date rates. Tests whether recent form beats a
 * season average — tracked side by side with sim-elo-v2, never replaces it.
 * See src/lib/mlb-recent-form.ts. Unvalidated at ship time — no backtest has
 * been run against this build yet.
 */
export const MODEL_VERSION_RECENT = "sim-recent-v1";

/**
 * Experimental: the next iteration of the sim-recent line. sim-recent-v2 keeps
 * everything sim-recent-v1 does (the sim-elo-v2 engine fed trailing-window
 * form + multi-season Elo) and upgrades one input — the bullpen — to the smart
 * relievers-only line from mlb-bullpen.ts: built from real relief-role arms
 * (not the staff-minus-rotation subtraction Round 2 rejected) and weighted by
 * leverage (save/hold/close-out usage) and availability (recent workload), then
 * DIPS-stabilized (trust K/BB/HR, regress BABIP hard). Falls back to the
 * trailing full-staff line when the pen sample is too thin. It is one model —
 * the evolution of sim-recent, not a separate algorithm — tracked against
 * sim-recent-v1 (the baseline of the line) and the headline sim-elo-v2. See
 * src/lib/mlb-recent-form.ts. Backtest: scripts/backtest-shadow-models.ts.
 */
export const MODEL_VERSION_RECENT_V2 = "sim-recent-v2";

/**
 * Experimental: v2 (sim-recent-v1) with temperature-calibrated confidence.
 * The Round-7 study (1,102 games, dev/test + walk-forward; MODEL-ANALYSIS.md)
 * found v2 systematically overconfident: shrinking every probability toward
 * 50% in logit space by a fixed a = 0.60 — p' = σ(0.60·logit(p)) — left every
 * pick identical while improving Brier on the dev set, the frozen test set
 * (0.2499 → 0.2479) and the 947-game walk-forward (0.2480 → 0.2472). It is a
 * calibration of v2, not a new signal: same favored team every game, honest
 * confidence. Tracked side by side so live results confirm (or refute) the
 * calibration before anything relies on it.
 */
export const MODEL_VERSION_RECENT_CAL = "sim-recent-cal-v1";

/** Fitted on the Round-7 dev window (Apr 20 – Jun 13), frozen. */
export const RECENT_CAL_A = 0.6;

/** The primary/headline model's stored version key (defined in mlb-sim.ts as MODEL_VERSION_SIM). */
export const MODEL_VERSION_HEADLINE = "sim-elo-v2";

/**
 * Short, plain-English display labels for every model, keyed by stored
 * model_version. The internal keys stay stable (data continuity); the UI shows
 * the simple name — "what it is, as simply as possible" — instead of the old
 * v1/v2/v3 shorthand.
 */
export const MODEL_LABELS: Record<string, string> = {
  [MODEL_VERSION_DIXON]: "Poisson",
  [MODEL_VERSION_RECENT_CAL]: "Calibrated",
  [MODEL_VERSION_RECENT]: "Recent Form",
  [MODEL_VERSION_RECENT_V2]: "Bullpen",
  [MODEL_VERSION_HEADLINE]: "Simulator",
  [MODEL_VERSION_BLEND]: "Market Blend",
  [MODEL_VERSION_MARKET]: "Market",
};

/**
 * Every model the pipeline computes, best-accuracy-first from the Round 11
 * frozen-test study. `hidden` models are still predicted, settled, and scored —
 * the Simulator drives the whole site, the blend powers Best Odds, and the
 * baseline is a live fallback — but they're kept off the public Track Record so
 * a casual visitor sees a short, legible list instead of eight near-identical
 * lines. The three shown models are our best; Market is the benchmark.
 */
export const TRACKED_MODELS: Array<{
  version: string;
  label: string;
  note: string;
  hidden?: boolean;
}> = [
  {
    version: MODEL_VERSION_DIXON,
    label: "Poisson",
    note: "Rates each team's scoring, adjusts for tonight's starting pitcher, and simulates the runs — our best model at calling winners",
  },
  {
    version: MODEL_VERSION_RECENT_CAL,
    label: "Calibrated",
    note: "Our recent-form model with its confidence tuned so a stated 70% really means about 70%",
  },
  {
    version: MODEL_VERSION_RECENT,
    label: "Recent Form",
    note: "Judges each team on how it has played over the last few weeks rather than the whole season",
  },
  {
    version: MODEL_VERSION_MARKET,
    label: "Market",
    note: "The Las Vegas betting line with its built-in margin removed — the number to beat",
  },
  {
    version: MODEL_VERSION_RECENT_V2,
    label: "Bullpen",
    note: "Recent Form with a smarter, leverage-aware bullpen",
    hidden: true,
  },
  {
    version: MODEL_VERSION_HEADLINE,
    label: "Simulator",
    note: "The Monte Carlo simulator that powers the site's live picks",
    hidden: true,
  },
  {
    version: MODEL_VERSION_BLEND,
    label: "Market Blend",
    note: "Our simulator combined with the betting line — powers the Best Odds page",
    hidden: true,
  },
  {
    version: "baseline-v0.4",
    label: "Baseline",
    note: "Legacy hand-tuned model, kept only as a fallback",
    hidden: true,
  },
];

/**
 * The models shown on the public Track Record: our three best plus the Market
 * benchmark. Everything else is computed and scored but kept off the charts.
 */
export const DISPLAYED_MODELS = TRACKED_MODELS.filter((m) => !m.hidden);
