import { createFileRoute } from "@tanstack/react-router";

import { PropsBoardsProvider } from "@/components/PropsBoards";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
import { boardOf } from "@/lib/props-boards";

/**
 * NBA Props — the players most likely to reach 10, 15, 20, 25 or 30 points,
 * from every game played up to 100,000 times by the site's simulator.
 */
export const Route = createFileRoute("/nba/props")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  head: () => ({
    meta: [
      { title: "NBA Points Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Who is most likely to score 10, 15, 20, 25 or 30+ points tonight — every game simulated up to 100,000 times, calibrated and backtested on last season.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("nba", Route.useSearch().board);
  return (
    <PropsBoardsProvider sport="nba" board={board}>
      <SimPropsBoardView league="nba" board={board} />
    </PropsBoardsProvider>
  );
}
