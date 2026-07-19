import { createFileRoute } from "@tanstack/react-router";

import { SportPage } from "@/components/SportPage";
import { getNbaSlate } from "@/lib/sports.functions";

export const Route = createFileRoute("/nba")({
  head: () => ({
    meta: [
      { title: "NBA Win Probabilities — Diamond Edge" },
      {
        name: "description",
        content:
          "Daily NBA matchups with margin-of-victory Elo win probabilities, replayed point-in-time from ESPN results.",
      },
      { property: "og:title", content: "NBA Win Probabilities — Diamond Edge" },
      {
        property: "og:description",
        content: "Daily NBA win probabilities from a margin-of-victory Elo model.",
      },
    ],
  }),
  component: NbaPage,
});

function NbaPage() {
  return (
    <SportPage
      sport="nba"
      eyebrow="Diamond Edge · NBA Forecast"
      blurb="Live matchups from the ESPN scoreboard. Win probabilities come from a margin-of-victory Elo model, replayed point-in-time from every result this season and last — no injuries, rest, or market inputs."
      fetchSlate={getNbaSlate}
    />
  );
}
