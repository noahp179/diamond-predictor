import { createFileRoute } from "@tanstack/react-router";

import { SportPage } from "@/components/SportPage";
import { getNflSlate } from "@/lib/sports.functions";

export const Route = createFileRoute("/nfl")({
  head: () => ({
    meta: [
      { title: "NFL Win Probabilities — Diamond Edge" },
      {
        name: "description",
        content:
          "Weekly NFL matchups with margin-of-victory Elo win probabilities, replayed point-in-time from ESPN results.",
      },
      { property: "og:title", content: "NFL Win Probabilities — Diamond Edge" },
      {
        property: "og:description",
        content: "Weekly NFL win probabilities from a margin-of-victory Elo model.",
      },
    ],
  }),
  component: NflPage,
});

function NflPage() {
  return (
    <SportPage
      sport="nfl"
      eyebrow="Diamond Edge · NFL Forecast"
      blurb="Live matchups from the ESPN scoreboard. Win probabilities come from a margin-of-victory Elo model, replayed point-in-time from every result this season and last — no injuries, rest, or market inputs."
      fetchSlate={getNflSlate}
    />
  );
}
