import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { MlbBaseParlayView } from "@/components/MlbBaseParlayView";
import { MlbPropsView } from "@/components/MlbPropsView";
import { MlbStacksView } from "@/components/MlbStacksView";
import { MlbTwoBasesView } from "@/components/MlbTwoBasesView";
import { PropsBoardsProvider } from "@/components/PropsBoards";
import { SimAnalyticsView } from "@/components/SimAnalyticsView";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
import { boardOf } from "@/lib/props-boards";

/**
 * MLB Props — every prop board for the sport on one page (see PropsBoards.tsx):
 * the simulation boards, the logistic models' boards, and Analytics.
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
          "Who is most likely to get a hit, homer, drive in a run, steal a base, strike out 6 or go 6 innings tonight — every game simulated 10,000 times — plus the logistic prop models, 2+ total bases, parlays and team stacks, each tracked against what actually happened.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("mlb", Route.useSearch().board);
  // The simulation boards (hits, bases, homers, ...) and Analytics, like every
  // other sport's; the logistic models' boards stay alongside them.
  let page: ReactNode = <SimPropsBoardView key={board} league="mlb" board={board} />;
  if (board === "players") page = <MlbPropsView />;
  else if (board === "two-bases") page = <MlbTwoBasesView />;
  else if (board === "parlays") page = <MlbBaseParlayView />;
  else if (board === "stacks") page = <MlbStacksView />;
  else if (board === "analytics") page = <SimAnalyticsView league="mlb" />;
  return (
    <PropsBoardsProvider sport="mlb" board={board}>
      {page}
    </PropsBoardsProvider>
  );
}
