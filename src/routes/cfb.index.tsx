import { createFileRoute } from "@tanstack/react-router";

import { SportPage } from "@/components/SportPage";
import { getCfbSlate } from "@/lib/sports.functions";

export const Route = createFileRoute("/cfb/")({
  head: () => ({
    meta: [
      { title: "College Football Win Probabilities — Diamond Edge" },
      {
        name: "description",
        content:
          "FBS matchups with win probabilities from a college-tuned margin-of-victory Elo, replayed point-in-time from ESPN results.",
      },
      { property: "og:title", content: "College Football Win Probabilities — Diamond Edge" },
      {
        property: "og:description",
        content: "FBS win probabilities from a margin-of-victory Elo tuned on six seasons.",
      },
    ],
  }),
  component: CfbSlate,
});

function CfbSlate() {
  return (
    <SportPage
      sport="cfb"
      eyebrow="Diamond Edge · College Football"
      blurb="Every FBS game on the board, priced by a margin-of-victory Elo tuned on college rather than borrowed from the NFL — ratings move twice as fast, and everyone outside FBS shares one pooled rating. Held out on 2025-26 it called 76.0% of games against a 67.4% always-take-the-home-team baseline."
      fetchSlate={getCfbSlate}
    />
  );
}
