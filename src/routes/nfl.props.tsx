import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { NflPropsView } from "@/components/NflPropsView";
import { SimAnalyticsView } from "@/components/SimAnalyticsView";
import { SimPropsBoardView } from "@/components/SimPropsBoardView";
import { TdParlayView } from "@/components/TdParlayView";
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
          "Every NFL prop board in one place: receptions, receiving, rushing and rush+rec yards, passing yards, TDs and completions, anytime and first touchdown scorers, touchdown parlays — every game simulated 10,000 times, each pick tracked against what actually happened.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const board = boardOf("nfl", Route.useSearch().board);
  let page: ReactNode;
  // Every player prop and touchdown board comes from the game simulator. On
  // the 2025 season and 2026 to date it beat the previous touchdown model,
  // and matched or beat the logistic prop models on the lines they share
  // (research/player-props/results/nfl_td_backtest.json,
  // nfl_props_backtest.json). The logistic boards stay as "Model props".
  if (board === "players") page = <NflPropsView />;
  else if (board === "parlays") page = <TdParlayView sport="nfl" />;
  else if (board === "analytics") page = <SimAnalyticsView league="nfl" />;
  else page = <SimPropsBoardView key={board} league="nfl" board={board} />;
  return (
    <PropsBoardsProvider sport="nfl" board={board}>
      {page}
    </PropsBoardsProvider>
  );
}
