import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { NflPropsView } from "@/components/NflPropsView";
import { TdParlayView } from "@/components/TdParlayView";
import { TdScorersView } from "@/components/TdScorersView";
import { PropsBoardsProvider } from "@/components/PropsBoards";
import { boardOf } from "@/lib/props-boards";

/**
 * NFL Props — every prop board for the sport on one page (see PropsBoards.tsx).
 * `?board=` picks the board; the old per-board addresses redirect here.
 */
export const Route = createFileRoute("/nfl/props")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  head: () => ({
    meta: [
      { title: "NFL Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Every NFL prop board in one place: receiving, rushing and passing props, anytime touchdown scorers and touchdown parlays — each tracked against what actually happened.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("nfl", Route.useSearch().board);
  let page: ReactNode = <NflPropsView />;
  if (board === "td-scorers") page = <TdScorersView />;
  else if (board === "parlays") page = <TdParlayView sport="nfl" />;
  return (
    <PropsBoardsProvider sport="nfl" board={board}>
      {page}
    </PropsBoardsProvider>
  );
}
