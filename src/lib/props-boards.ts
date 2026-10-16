/**
 * The boards under each sport's one Props page. See components/PropsBoards.tsx.
 */

export type PropsSport = "mlb" | "nfl" | "cfb" | "nba" | "nhl";

export const PROPS_BOARDS: Record<PropsSport, { key: string; label: string; hint: string }[]> = {
  mlb: [
    { key: "hits", label: "Hits", hint: "1, 2 or 3+ hits" },
    { key: "bases", label: "Total bases", hint: "2, 3 or 4+ bases" },
    { key: "homers", label: "Home runs", hint: "who homers" },
    { key: "runs-rbi", label: "Runs & RBI", hint: "runs scored, runs driven in" },
    { key: "hrr", label: "H+R+RBI", hint: "hits + runs + RBI" },
    { key: "steals", label: "Stolen bases", hint: "who steals a base" },
    { key: "strikeouts", label: "Strikeouts", hint: "starters, 4 to 8+ K" },
    { key: "pitching", label: "Outs & runs", hint: "outs recorded, earned runs" },
    { key: "players", label: "Model props", hint: "the logistic prop models" },
    { key: "two-bases", label: "2+ bases", hint: "every hitter's chance of 2+ total bases" },
    { key: "parlays", label: "Parlays", hint: "5, 10 and 15-leg 2+ bases slips" },
    { key: "stacks", label: "Team stacks", hint: "team runs with that team's hitters" },
    { key: "analytics", label: "Analytics", hint: "every market's accuracy" },
  ],
  nfl: [
    { key: "receiving", label: "Receiving", hint: "catches and receiving yards" },
    { key: "rushing", label: "Rushing", hint: "rushing yards and carries" },
    { key: "scrimmage", label: "Rush+Rec yards", hint: "yards from scrimmage" },
    { key: "passing", label: "Passing", hint: "yards, TDs, completions" },
    { key: "td-scorers", label: "TD scorers", hint: "who scores a touchdown" },
    { key: "first-td", label: "First TD", hint: "who scores the first touchdown" },
    { key: "parlays", label: "TD parlays", hint: "5 to 20-leg touchdown slips" },
    { key: "players", label: "Model props", hint: "the logistic prop models" },
    { key: "analytics", label: "Analytics", hint: "every market's accuracy" },
  ],
  nba: [
    { key: "points", label: "Points", hint: "10, 15, 20, 25 or 30+" },
    { key: "rebounds", label: "Rebounds", hint: "4 to 12+ boards" },
    { key: "assists", label: "Assists", hint: "2 to 10+ dimes" },
    { key: "threes", label: "Threes", hint: "1 to 5+ made" },
    { key: "combos", label: "Combos", hint: "PRA, Pts+Reb, Pts+Ast, Reb+Ast" },
    { key: "double-double", label: "Double-double", hint: "double- and triple-doubles" },
    { key: "defense", label: "Steals & blocks", hint: "steals, blocks, both" },
    { key: "analytics", label: "Analytics", hint: "every market's accuracy" },
  ],
  nhl: [
    { key: "points", label: "Points", hint: "a goal or an assist" },
    { key: "goals", label: "Goalscorers", hint: "who scores a goal" },
    { key: "assists", label: "Assists", hint: "1+ or 2+ assists" },
    { key: "shots", label: "Shots on goal", hint: "2 to 5+ shots" },
    { key: "first-goal", label: "First goal", hint: "who scores first" },
    { key: "saves", label: "Goalie saves", hint: "20, 25 or 30+ saves" },
    { key: "analytics", label: "Analytics", hint: "every market's accuracy" },
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
