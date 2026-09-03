import { createFileRoute } from "@tanstack/react-router";

import { MlbStacksView } from "@/components/MlbStacksView";

export const Route = createFileRoute("/mlb/stacks")({
  head: () => ({
    meta: [
      { title: "MLB Team Stacks — Diamond Edge" },
      {
        name: "description",
        content:
          "The night's highest-scoring MLB offences and the 2+ total-base hitters off those lineups, priced together through a backtested correlation rather than as independent legs.",
      },
    ],
  }),
  component: () => <MlbStacksView />,
});
