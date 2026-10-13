import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { MlbBaseParlayView } from "@/components/MlbBaseParlayView";
import { MlbPropsView } from "@/components/MlbPropsView";
import { MlbStacksView } from "@/components/MlbStacksView";
import { MlbTwoBasesView } from "@/components/MlbTwoBasesView";
import { PropsBoardsProvider } from "@/components/PropsBoards";
import { boardOf } from "@/lib/props-boards";

/**
 * MLB Props — every prop board for the sport on one page (see PropsBoards.tsx).
 * `?board=` picks the board; the old per-board addresses redirect here.
 */
export const Route = createFileRoute("/mlb/props")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  head: () => ({
    meta: [
      { title: "MLB Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Every MLB prop board in one place: player props (hits, total bases, home runs, RBI, runs, steals, strikeouts), 2+ total bases, 5/10/15-leg parlays and team stacks — each tracked against what actually happened.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("mlb", Route.useSearch().board);
  let page: ReactNode = <MlbPropsView />;
  if (board === "two-bases") page = <MlbTwoBasesView />;
  else if (board === "parlays") page = <MlbBaseParlayView />;
  else if (board === "stacks") page = <MlbStacksView />;
  return (
    <PropsBoardsProvider sport="mlb" board={board}>
      {page}
    </PropsBoardsProvider>
  );
}
