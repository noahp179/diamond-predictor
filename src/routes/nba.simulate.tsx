import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SimulatePage } from "@/components/sim/SimulatePage";
import { simHead, simSearch } from "@/components/sim/simulate-route";

/** The NBA game simulator — see SimulatePage. */
export const Route = createFileRoute("/nba/simulate")({
  validateSearch: simSearch,
  head: () => simHead("nba"),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SimulatePage
      league="nba"
      search={search}
      onSearch={(next) => navigate({ search: next, resetScroll: false })}
    />
  );
}
