import { createFileRoute } from "@tanstack/react-router";

import { MlbPropsView } from "@/components/MlbPropsView";

export const Route = createFileRoute("/props")({
  head: () => ({
    meta: [
      { title: "MLB Player Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Daily MLB player-prop projections — hits, total bases, home runs, RBI, runs, steals and starter strikeouts, from backtested logistic models.",
      },
    ],
  }),
  component: () => <MlbPropsView />,
});
