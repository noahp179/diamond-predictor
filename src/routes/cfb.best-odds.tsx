import { createFileRoute } from "@tanstack/react-router";

import { BestOddsView } from "@/components/BestOddsView";
import { getCfbBestOdds } from "@/lib/sports.functions";

export const Route = createFileRoute("/cfb/best-odds")({
  head: () => ({ meta: [{ title: "College Football Best Odds — Diamond Edge" }] }),
  component: () => <BestOddsView sport="cfb" fetchBestOdds={getCfbBestOdds} />,
});
