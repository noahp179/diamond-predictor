import { createFileRoute } from "@tanstack/react-router";

import { RecommendedView } from "@/components/RecommendedView";
import { getNbaRecommended } from "@/lib/sports.functions";

export const Route = createFileRoute("/nba/recommended")({
  head: () => ({ meta: [{ title: "NBA Recommended — Diamond Edge" }] }),
  component: () => <RecommendedView sport="nba" fetchRecommended={getNbaRecommended} />,
});
