import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { CfbFirstTdView } from "@/components/CfbFirstTdView";
import { CfbTdScorersView } from "@/components/CfbTdScorersView";
import { TdParlayView } from "@/components/TdParlayView";
import { PropsBoardsProvider } from "@/components/PropsBoards";
import { boardOf } from "@/lib/props-boards";

/**
 * College Football Props — every prop board for the sport on one page (see PropsBoards.tsx).
 * `?board=` picks the board; the old per-board addresses redirect here.
 */
export const Route = createFileRoute("/cfb/props")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  head: () => ({
    meta: [
      { title: "College Football Props — Diamond Edge" },
      {
        name: "description",
        content:
          "College football touchdown scorers and touchdown parlays in one place — each tracked against what actually happened.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("cfb", Route.useSearch().board);
  let page: ReactNode = <CfbTdScorersView />;
  if (board === "parlays") page = <TdParlayView sport="cfb" />;
  else if (board === "first-td") page = <CfbFirstTdView />;
  return (
    <PropsBoardsProvider sport="cfb" board={board}>
      {page}
    </PropsBoardsProvider>
  );
}
