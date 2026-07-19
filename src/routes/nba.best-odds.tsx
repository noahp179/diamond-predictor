import { createFileRoute } from "@tanstack/react-router";

import { BestOddsView } from "@/components/BestOddsView";
import { getNbaBestOdds } from "@/lib/sports.functions";

export const Route = createFileRoute("/nba/best-odds")({
  head: () => ({ meta: [{ title: "NBA Best Odds — Diamond Edge" }] }),
  component: () => <BestOddsView sport="nba" fetchBestOdds={getNbaBestOdds} />,
});
