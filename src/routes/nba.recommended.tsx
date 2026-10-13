import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Recommended ranked the slate by model confidence — exactly what Best Odds
 * shows by default, beside two other rankings — so the two pages were one.
 * The address is kept for bookmarks.
 */
export const Route = createFileRoute("/nba/recommended")({
  beforeLoad: () => {
    throw redirect({ to: "/nba/best-odds", replace: true });
  },
});
