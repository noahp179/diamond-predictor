import { createFileRoute } from "@tanstack/react-router";

import { NflPropsView } from "@/components/NflPropsView";

export const Route = createFileRoute("/nfl/props")({
  head: () => ({
    meta: [
      { title: "NFL Player Props — Diamond Edge" },
      {
        name: "description",
        content:
          "Receiving, rushing, scrimmage and passing prop projections for every NFL game, with the backtested tier each pick lands in and injured players removed.",
      },
    ],
  }),
  component: () => <NflPropsView />,
});
