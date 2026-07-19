import { createFileRoute } from "@tanstack/react-router";

import { BestOddsView } from "@/components/BestOddsView";
import { getNflBestOdds } from "@/lib/sports.functions";

export const Route = createFileRoute("/nfl/best-odds")({
  head: () => ({ meta: [{ title: "NFL Best Odds — Diamond Edge" }] }),
  component: () => <BestOddsView sport="nfl" fetchBestOdds={getNflBestOdds} />,
});
