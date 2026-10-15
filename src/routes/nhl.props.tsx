import { createFileRoute } from "@tanstack/react-router";

import { PropsBoardsProvider } from "@/components/PropsBoards";
import { SimAnalyticsView } from "@/components/SimAnalyticsView";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
import { boardOf } from "@/lib/props-boards";

/**
 * NHL Props — points, goalscorers, assists, shots on goal, the first goal
 * and goalie saves, from every game played up to 100,000 times by the site's
 * simulator; and Analytics, every market's record at each confidence level.
 */
export const Route = createFileRoute("/nhl/props")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => ({
    board: typeof s.board === "string" ? s.board : undefined,
  }),
  head: () => ({
    meta: [
      { title: "NHL Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Who is most likely to get a point, score, assist, put up shots on goal or score the first goal tonight, and which goalies make 20, 25 or 30 saves — every game simulated up to 100,000 times, calibrated and backtested on last season.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("nhl", Route.useSearch().board);
  return (
    <PropsBoardsProvider sport="nhl" board={board}>
      {board === "analytics" ? (
        <SimAnalyticsView league="nhl" />
      ) : (
        <SimPropsBoardView key={board} league="nhl" board={board} />
      )}
    </PropsBoardsProvider>
  );
}
