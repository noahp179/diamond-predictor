/** Messages between the page and the simulation workers. */

import type { AccState } from "./aggregate";
import type { GameResult, SimMatchup, SimOverrides } from "./types";

export type SimRequest =
  | { type: "single"; id: number; matchup: SimMatchup; overrides: SimOverrides; seed: number }
  | {
      type: "batch";
      id: number;
      matchup: SimMatchup;
      overrides: SimOverrides;
      seed: number;
      n: number;
    }
  | { type: "cancel"; id: number };

/**
 * A batch answers with its raw totals rather than a summary, so the page can
 * split one batch across several workers and add the pieces together.
 */
export type SimResponse =
  | { type: "single"; id: number; result: GameResult; seed: number; ms: number }
  | { type: "progress"; id: number; done: number; n: number }
  | { type: "batch"; id: number; state: AccState; partial: boolean }
  | { type: "error"; id: number; message: string };
