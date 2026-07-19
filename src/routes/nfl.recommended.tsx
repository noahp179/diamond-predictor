import { createFileRoute } from "@tanstack/react-router";

import { RecommendedView } from "@/components/RecommendedView";
import { getNflRecommended } from "@/lib/sports.functions";

export const Route = createFileRoute("/nfl/recommended")({
  head: () => ({ meta: [{ title: "NFL Recommended — Diamond Edge" }] }),
  component: () => <RecommendedView sport="nfl" fetchRecommended={getNflRecommended} />,
});
