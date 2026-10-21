/**
 * engine.ts — one entry point over the four engines.
 *
 * `runner` prepares a matchup once (rotations, lineups, bullpens, depth
 * charts) and returns a function that plays one game from a seed. A batch of
 * ten thousand games pays for the preparation once.
 */

import { Rng } from "./core";
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
      // Players who may not play: each game draws who does, and the
      // rotation for each combination is prepared once.
      const set = new Set([...o.benched, ...o.activated]);
      const unsure = [...m.home.players, ...m.away.players].filter(
        (q) => q.playP !== undefined && q.playP < 1 && q.status !== "out" && !set.has(q.id),
      );
      if (!unsure.length) return (seed, record) => playNba(p, seed, record);
      const preps = new Map<string, ReturnType<typeof prepareNba>>([["", p]]);
      return (seed, record) => {
        const rng = new Rng((seed ^ 0x2545f491) >>> 0);
        const sit = unsure.filter((q) => !rng.chance(q.playP!)).map((q) => q.id);
        const key = sit.join(",");
        let pp = preps.get(key);
        if (!pp) {
          pp = prepareNba(m, { ...o, benched: [...o.benched, ...sit] });
          preps.set(key, pp);
        }
        return playNba(pp, seed, record);
      };
    }
    case "nhl": {
      const p = prepareNhl(m, o);
      return (seed, record) => playNhl(p, seed, record);
    }
    case "mlb": {
      const p = prepareMlb(m, o);
      return (seed, record) => playMlb(p, seed, record);
    }
    case "nfl":
    case "cfb": {
      const p = prepareNfl(m, o);
      return (seed, record) => playNfl(p, seed, record);
    }
  }
}
