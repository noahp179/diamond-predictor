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

/** Display order and labels for every tracked model. */
export const TRACKED_MODELS: Array<{ version: string; label: string; note: string }> = [
  {
    version: "sim-elo-v2",
    label: "sim-elo-v2",
    note: "Monte Carlo sim × multi-season Elo — the headline model",
  },
  {
    version: "sim-elo-v3",
    label: "sim-elo-v3 (Algorithm V2)",
    note: "Shadow candidate: schedule-strength-adjusted sim + game-context layer",
  },
  {
    version: MODEL_VERSION_BLEND,
    label: "odds-blend-v1",
    note: "sim-elo-v2 blended with the market line (Best Odds tab 2)",
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
