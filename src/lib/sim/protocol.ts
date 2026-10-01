/** Messages between the page and the simulation worker. */

import type { MassResult } from "./aggregate";
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

export type SimResponse =
  | { type: "single"; id: number; result: GameResult; seed: number; ms: number }
  | { type: "progress"; id: number; done: number; n: number }
  | { type: "batch"; id: number; result: MassResult; partial: boolean }
  | { type: "error"; id: number; message: string };
