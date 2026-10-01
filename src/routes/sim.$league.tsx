import { createFileRoute, redirect } from "@tanstack/react-router";

import { simSearch } from "@/components/sim/simulate-route";

/**
 * Where each league's simulator used to live. It is now a view inside the
 * sport's own section (/nfl/simulate and so on); links to the old address
 * keep their game and date.
 */
const HOME = {
  nfl: "/nfl/simulate",
  nba: "/nba/simulate",
  nhl: "/nhl/simulate",
  mlb: "/mlb/simulate",
} as const;

export const Route = createFileRoute("/sim/$league")({
  validateSearch: simSearch,
  beforeLoad: ({ params, search }) => {
    const to = HOME[params.league as keyof typeof HOME];
    throw redirect(to ? { to, search, replace: true } : { to: "/sim", replace: true });
  },
});
