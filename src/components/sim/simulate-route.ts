import type { SimLeague } from "@/lib/sim/types";

import { LEAGUE_LABEL } from "./format";

/** URL plumbing shared by the four Simulate routes (see SimulatePage). */

export type SimSearch = { date?: string; game?: string; home?: string; away?: string };

const str = (v: unknown) => (typeof v === "string" && v.length < 24 ? v : undefined);

export function simSearch(s: Record<string, unknown>): SimSearch {
  return {
    date: typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : undefined,
    game: str(s.game),
    home: str(s.home),
    away: str(s.away),
  };
}

export function simHead(league: SimLeague) {
  const l = LEAGUE_LABEL[league];
  return {
    meta: [
      { title: `${l} Game Simulator — Diamond Edge` },
      {
        name: "description",
        content: `Simulate any ${l} game play by play from real player statistics and matchup tendencies — run it 10 or 100,000 times for win probabilities, average box scores and every player's projected stat line.`,
      },
      { property: "og:title", content: `${l} Game Simulator — Diamond Edge` },
    ],
  };
}
