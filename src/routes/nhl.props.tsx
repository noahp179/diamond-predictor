import { createFileRoute } from "@tanstack/react-router";

import { PropsBoardsProvider } from "@/components/PropsBoards";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
import { boardOf } from "@/lib/props-boards";

/**
 * NHL Props — points, goalscorers and the first goal, from every game played
 * up to 100,000 times by the site's simulator.
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
          "Who is most likely to get a point, score a goal, or score the first goal tonight — every game simulated up to 100,000 times, calibrated and backtested on last season.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("nhl", Route.useSearch().board);
  return (
    <PropsBoardsProvider sport="nhl" board={board}>
      <SimPropsBoardView league="nhl" board={board} />
    </PropsBoardsProvider>
  );
}
