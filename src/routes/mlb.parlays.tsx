import { createFileRoute } from "@tanstack/react-router";

import { MlbBaseParlayView } from "@/components/MlbBaseParlayView";

export const Route = createFileRoute("/mlb/parlays")({
  head: () => ({
    meta: [
      { title: "MLB Base Parlays — Diamond Edge" },
      {
        name: "description",
        content:
          "Five, ten and fifteen hitters to get two or more total bases on one slip, priced for the correlation between legs from the same game and shown against what the same construction did on held-out days.",
      },
    ],
  }),
  component: () => <MlbBaseParlayView />,
});
