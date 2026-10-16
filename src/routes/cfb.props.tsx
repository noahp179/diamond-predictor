import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { CfbTdScorersView } from "@/components/CfbTdScorersView";
import { SimAnalyticsView } from "@/components/SimAnalyticsView";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
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
          "Every college football prop board in one place: receptions, receiving, rushing and rush+rec yards, passing yards, TDs and completions, anytime and first touchdown scorers, touchdown parlays — every game simulated up to 100,000 times, each pick tracked against what actually happened.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("cfb", Route.useSearch().board);
  let page: ReactNode;
  // The same boards as the NFL's, from the same game simulator, calibrated on
  // the 2025 college season and 2026 to date
  // (research/player-props/results/cfb_props_backtest.json). The touchdown
  // model ranked anytime scorers better on those games (cfb_td_backtest.json),
  // so it keeps its own board — "TD model" — and its own record, and the
  // touchdown parlays are still built from its picks, as the NFL's are from
  // its touchdown model.
  if (board === "td-model") page = <CfbTdScorersView />;
  else if (board === "parlays") page = <TdParlayView sport="cfb" />;
  else if (board === "analytics") page = <SimAnalyticsView league="cfb" />;
  else page = <SimPropsBoardView key={board} league="cfb" board={board} />;
  return (
    <PropsBoardsProvider sport="cfb" board={board}>
      {page}
    </PropsBoardsProvider>
  );
}
