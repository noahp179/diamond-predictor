import { createFileRoute } from "@tanstack/react-router";

import { RecommendedView } from "@/components/RecommendedView";
import { getCfbRecommended } from "@/lib/sports.functions";

export const Route = createFileRoute("/cfb/recommended")({
  head: () => ({ meta: [{ title: "College Football Recommended — Diamond Edge" }] }),
  component: () => <RecommendedView sport="cfb" fetchRecommended={getCfbRecommended} />,
});
