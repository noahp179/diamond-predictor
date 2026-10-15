import adjust from "./mlb-postseason.json";

/**
 * The playoff correction. The prop models learned the regular season; on the
 * 2024-2026 postseasons the hitter markets held up, but starters' strikeout
 * lines and team run totals ran hot — playoff starters are pulled sooner and
 * October runs are scarcer. Each of those two groups gets one shift on the
 * log-odds scale for playoff games, fitted and checked out of sample in
 * research/mlb-props/postseason_shift.py. Regular-season prices are untouched.
 */
export type PlayoffGroup = keyof typeof adjust.shift;

export function playoffPrice(p: number, group: PlayoffGroup): number {
  const d = adjust.shift[group];
  if (!d || p <= 0 || p >= 1) return p;
  return 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + d)));
}

/** MLB's game types for the four playoff rounds. */
export const isPlayoffGame = (gameType: unknown): boolean =>
  gameType === "F" || gameType === "D" || gameType === "L" || gameType === "W";
