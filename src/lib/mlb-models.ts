// mlb-models.ts — the model registry and the track-record window.
// Client-safe constants shared by the pipeline (server), the track-record
// server function, and the Track Record page (client).

import { MODEL_VERSION_BLEND } from "./mlb-blend";

/**
 * The Track Record page starts its clock here. Everything before this date
 * is the baseline-only era: the cron was down 2026-06-16 → 2026-07-09, no
 * sim-elo-v2 / odds-blend-v1 rows were ever settled, and no odds were cached,
 * so pre-window games can't be compared across models. From this date forward
 * every model below gets a prediction row each morning and is settled and
 * scored identically.
 */
export const TRACK_RECORD_START = "2026-07-10";

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
 * Short display labels for the three compared models, keyed by stored
 * model_version. The internal keys stay stable (data continuity); the UI shows
 * v1/v2/v3. v1 = headline sim-elo-v2, v2 = sim-recent-v1 (recent-form),
 * v3 = sim-recent-v2 (tiered-bullpen).
 */
export const MODEL_LABELS: Record<string, string> = {
  [MODEL_VERSION_HEADLINE]: "v1",
  [MODEL_VERSION_RECENT]: "v2",
  [MODEL_VERSION_RECENT_V2]: "v3",
  [MODEL_VERSION_RECENT_CAL]: "v4",
};

/** Display order and labels for every tracked model. */
export const TRACKED_MODELS: Array<{ version: string; label: string; note: string }> = [
  {
    version: MODEL_VERSION_HEADLINE,
    label: "v1",
    note: "sim-elo-v2 — Monte Carlo sim × multi-season Elo (the headline model)",
  },
  {
    version: MODEL_VERSION_RECENT,
    label: "v2",
    note: "sim-recent-v1 — the sim engine on trailing 21-day form instead of season rates",
  },
  {
    version: MODEL_VERSION_RECENT_V2,
    label: "v3",
    note: "sim-recent-v2 — v2 with a leverage-tiered relievers-only bullpen",
  },
  {
    version: MODEL_VERSION_RECENT_CAL,
    label: "v4",
    note: "v2 with calibrated confidence (same picks, honest probabilities) — Round 7",
  },
  {
    version: MODEL_VERSION_BLEND,
    label: "odds-blend-v1",
    note: "v1 blended with the market line (Best Odds tab 2)",
  },
  {
    version: MODEL_VERSION_MARKET,
    label: "Market (devigged)",
    note: "DraftKings moneyline, vig removed — the benchmark",
  },
  {
    version: "baseline-v0.4",
    label: "baseline-v0.4",
    note: "Legacy hand-tuned blend, kept for comparison",
  },
];
