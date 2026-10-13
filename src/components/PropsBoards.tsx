import { Link } from "@tanstack/react-router";
import { createContext, useContext, type ReactNode } from "react";

/**
 * One Props page per sport.
 *
 * Baseball had four prop pages (player props, 2+ bases, base parlays, team
 * stacks), football three, college football two — each its own tab, each its
 * own idea of what "the props" were. They are now boards on one page: the
 * sport's nav shows a single Props tab, and this bar switches between the
 * boards under it.
 *
 * The boards keep rendering themselves (their own data, stat bar and copy). A
 * route wraps the chosen board in PropsBoardsProvider, and the page frame
 * (AppShell) reads it: highlight Props, show this bar. No board had to change.
 */

export type PropsSport = "mlb" | "nfl" | "cfb";

export const PROPS_BOARDS: Record<PropsSport, { key: string; label: string; hint: string }[]> = {
  mlb: [
    { key: "players", label: "Player props", hint: "hits, bases, homers, strikeouts" },
    { key: "two-bases", label: "2+ bases", hint: "every hitter's chance of 2+ total bases" },
    { key: "parlays", label: "Parlays", hint: "5, 10 and 15-leg 2+ bases slips" },
    { key: "stacks", label: "Team stacks", hint: "team runs with that team's hitters" },
  ],
  nfl: [
    { key: "players", label: "Player props", hint: "catches, yards, passing" },
    { key: "td-scorers", label: "TD scorers", hint: "who scores a touchdown" },
    { key: "parlays", label: "TD parlays", hint: "5 to 20-leg touchdown slips" },
  ],
  cfb: [
    { key: "td-scorers", label: "TD scorers", hint: "one or two scorers a game" },
    { key: "parlays", label: "TD parlays", hint: "5 to 20-leg touchdown slips" },
  ],
};

/** The board a URL asks for, or the sport's first board. */
export function boardOf(sport: PropsSport, board: unknown): string {
  const keys = PROPS_BOARDS[sport].map((b) => b.key);
  return typeof board === "string" && keys.includes(board) ? board : keys[0];
}

const Ctx = createContext<{ sport: PropsSport; board: string } | null>(null);

export function PropsBoardsProvider({
  sport,
  board,
  children,
}: {
  sport: PropsSport;
  board: string;
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ sport, board }}>{children}</Ctx.Provider>;
}

export function usePropsBoards() {
  return useContext(Ctx);
}

/** The board switcher, rendered by AppShell under the sport's tabs. */
export function PropsBoardBar() {
  const ctx = usePropsBoards();
  if (!ctx) return null;
  return (
    <div className="border-b border-border bg-card/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-stretch gap-2 px-6 py-3">
        {PROPS_BOARDS[ctx.sport].map((b) => {
          const active = b.key === ctx.board;
          return (
            <Link
              key={b.key}
              to={`/${ctx.sport}/props` as "/mlb/props"}
              search={{ board: b.key }}
              className={`min-w-36 border px-4 py-2 transition-colors ${
                active ? "border-primary bg-primary/10" : "border-border hover:border-primary/60"
              }`}
            >
              <div
                className={`font-mono text-[11px] uppercase tracking-widest ${
                  active ? "text-primary" : "text-foreground"
                }`}
              >
                {b.label}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{b.hint}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
