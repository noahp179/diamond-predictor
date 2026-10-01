/**
 * engine.ts — one entry point over the four engines.
 *
 * `runner` prepares a matchup once (rotations, lineups, bullpens, depth
 * charts) and returns a function that plays one game from a seed. A batch of
 * ten thousand games pays for the preparation once.
 */

import { playMlb, prepareMlb } from "./mlb";
import { playNba, prepareNba } from "./nba";
import { playNfl, prepareNfl } from "./nfl";
import { playNhl, prepareNhl } from "./nhl";
import type { GameResult, SimMatchup, SimOverrides } from "./types";

export type Runner = (seed: number, record: boolean) => GameResult;

export function runner(m: SimMatchup, o: SimOverrides): Runner {
  switch (m.league) {
    case "nba": {
      const p = prepareNba(m, o);
      return (seed, record) => playNba(p, seed, record);
    }
    case "nhl": {
      const p = prepareNhl(m, o);
      return (seed, record) => playNhl(p, seed, record);
    }
    case "mlb": {
      const p = prepareMlb(m, o);
      return (seed, record) => playMlb(p, seed, record);
    }
    case "nfl": {
      const p = prepareNfl(m, o);
      return (seed, record) => playNfl(p, seed, record);
    }
  }
}
