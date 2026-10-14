/**
 * The boards under each sport's one Props page. See components/PropsBoards.tsx.
 */

export type PropsSport = "mlb" | "nfl" | "cfb" | "nba" | "nhl";

export const PROPS_BOARDS: Record<PropsSport, { key: string; label: string; hint: string }[]> = {
  mlb: [
    { key: "players", label: "Player props", hint: "hits, bases, homers, strikeouts" },
    { key: "two-bases", label: "2+ bases", hint: "every hitter's chance of 2+ total bases" },
    { key: "parlays", label: "Parlays", hint: "5, 10 and 15-leg 2+ bases slips" },
    { key: "stacks", label: "Team stacks", hint: "team runs with that team's hitters" },
  ],
  nfl: [
    { key: "players", label: "Player props", hint: "catches, yards, passing" },
    { key: "td-scorers", label: "TD scorers", hint: "who scores a touchdown, simulated" },
    { key: "first-td", label: "First TD", hint: "who scores the first touchdown" },
    { key: "parlays", label: "TD parlays", hint: "5 to 20-leg touchdown slips" },
  ],
  nba: [{ key: "points", label: "Points", hint: "who scores 10, 15, 20, 25 or 30+" }],
  nhl: [
    { key: "points", label: "Points", hint: "a goal or an assist" },
    { key: "goals", label: "Goalscorers", hint: "who scores a goal" },
    { key: "first-goal", label: "First goal", hint: "who scores first" },
  ],
  cfb: [
    { key: "td-scorers", label: "TD scorers", hint: "one or two scorers a game" },
    { key: "first-td", label: "First TD", hint: "who scores the first touchdown" },
    { key: "parlays", label: "TD parlays", hint: "5 to 20-leg touchdown slips" },
  ],
};

/** The board a URL asks for, or the sport's first board. */
export function boardOf(sport: PropsSport, board: unknown): string {
  const keys = PROPS_BOARDS[sport].map((b) => b.key);
  return typeof board === "string" && keys.includes(board) ? board : keys[0];
}
