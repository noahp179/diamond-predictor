/**
 * mlb-props-board.ts — what the Player Props board is allowed to show.
 *
 * The models price every rung of a ladder independently. That is the right
 * thing for a model to do and the wrong thing for a card to display: a starter
 * the model likes surfaces at 5+, 6+ AND 7+ strikeouts, and a hot batter at 1+
 * hits, 2+ total bases and 1+ runs at once. Those are not three picks. They are
 * one opinion quoted three ways, and five slots per game means three of them go
 * to one player while the rest of the slate never appears.
 *
 * So the Top picks board follows the same rule the parlay does — one row per
 * player — differing only in which rung represents them. The parlay optimises
 * for surviving to the last leg, so it takes the safest rung. The board exists
 * to rank picks by edge over the market's base rate, and it prints that edge on
 * every row, so it takes the biggest-edge rung. Each surface picks the rung its
 * own number is about.
 *
 * Per-market tabs are deliberately exempt: asking for "6+ strikeouts" should
 * list every pitcher at 6+, which is a different question entirely.
 */

/** The shape the board needs; the server's PropPick satisfies it. */
export type BoardPick = {
  playerId: number;
  market: string;
  edge: number;
  tier: string | null;
};

/** How many picks a game card shows when no single market is selected. */
export const PER_GAME = 5;

/** How many picks a game card shows for one selected market. */
export const PER_MARKET_SHOWN = 6;

/** One entry per player: their biggest-edge rung, best edge first. */
export function bestRungPerPlayer<T extends BoardPick>(picks: T[]): T[] {
  const best = new Map<number, T>();
  for (const p of picks) {
    const cur = best.get(p.playerId);
    if (!cur || p.edge > cur.edge) best.set(p.playerId, p);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

/**
 * Exactly the picks one game card renders, for the active market and filter.
 *
 * The tier filter runs BEFORE the one-per-player collapse on purpose: if a
 * player's biggest-edge rung is only a Lean but another rung of theirs is
 * Strong, "Strong only" should keep the Strong one rather than drop the player.
 */
export function boardPicks<T extends BoardPick>(
  picks: T[],
  market: string,
  strongOnly: boolean,
): T[] {
  const eligible = strongOnly ? picks.filter((p) => p.tier === "Strong") : picks;
  return market === "all"
    ? bestRungPerPlayer(eligible).slice(0, PER_GAME)
    : eligible.filter((p) => p.market === market).slice(0, PER_MARKET_SHOWN);
}
