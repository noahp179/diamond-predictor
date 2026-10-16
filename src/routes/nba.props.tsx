import { createFileRoute } from "@tanstack/react-router";

import { PropsBoardsProvider } from "@/components/PropsBoards";
import { SimAnalyticsView } from "@/components/SimAnalyticsView";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
import { boardOf } from "@/lib/props-boards";

/**
 * NBA Props — points, rebounds, assists, threes, the combos, double-doubles,
 * steals and blocks, from every game played 10,000 times by the site's
 * simulator; and Analytics, every market's record at each confidence level.
 */
export const Route = createFileRoute("/nba/props")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  head: () => ({
    meta: [
      { title: "NBA Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Who is most likely to reach every common NBA prop line tonight — points, rebounds, assists, threes, PRA and the other combos, double-doubles, steals and blocks — every game simulated 10,000 times, calibrated and backtested on last season.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("nba", Route.useSearch().board);
  return (
    <PropsBoardsProvider sport="nba" board={board}>
      {board === "analytics" ? (
        <SimAnalyticsView league="nba" />
      ) : (
        <SimPropsBoardView key={board} league="nba" board={board} />
      )}
    </PropsBoardsProvider>
  );
}
