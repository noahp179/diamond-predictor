/**
 * props-board.ts — what a player-prop board is allowed to show.
 *
 * Every rung of a ladder is priced by its own model. That is right for a model
 * and wrong for a card: a forward the model likes surfaces at 1+, 2+ AND 3+
 * shots, a starter at 5+, 6+ and 7+ strikeouts. Those are not three picks, they
 * are one opinion quoted three ways, and with five slots per fixture three of
 * them go to one player while the rest of the lineup never appears.
 *
 * So the "Top picks" view shows each player once, at the rung with the largest
 * edge over that market's base rate — the number the board already ranks by and
 * prints on every row. Per-market tabs are deliberately exempt: asking for "2+
 * shots" should list every player at 2+, which is a different question.
 *
 * Sport-agnostic on purpose. MLB player ids are numbers and ESPN's are strings,
 * so the key type is left open.
 */

export type BoardPick = {
  playerId: string | number;
  market: string;
  edge: number;
  tier: string | null;
};

/** How many picks a card shows when no single market is selected. */
export const PER_GAME = 5;

/** How many picks a card shows for one selected market. */
export const PER_MARKET_SHOWN = 6;

/** One entry per player: their biggest-edge rung, best edge first. */
export function bestRungPerPlayer<T extends BoardPick>(picks: T[]): T[] {
  const best = new Map<string | number, T>();
  for (const p of picks) {
    const cur = best.get(p.playerId);
    if (!cur || p.edge > cur.edge) best.set(p.playerId, p);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

/**
 * Exactly the picks one card renders, for the active market and filter.
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
