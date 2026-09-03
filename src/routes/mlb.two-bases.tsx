import { createFileRoute } from "@tanstack/react-router";

import { MlbTwoBasesView } from "@/components/MlbTwoBasesView";

export const Route = createFileRoute("/mlb/two-bases")({
  head: () => ({
    meta: [
      { title: "MLB 2+ Total Bases — Diamond Edge" },
      {
        name: "description",
        content:
          "The chance every MLB hitter picks up two or more total bases today — a double, a home run, or two hits — from a backtested logistic model, with the reason for each projection in plain English.",
      },
    ],
  }),
  component: () => <MlbTwoBasesView />,
});
