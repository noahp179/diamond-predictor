import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SimulatePage } from "@/components/sim/SimulatePage";
import { simHead, simSearch } from "@/components/sim/simulate-route";

/** The NFL game simulator — see SimulatePage. */
export const Route = createFileRoute("/nfl/simulate")({
  validateSearch: simSearch,
  head: () => simHead("nfl"),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SimulatePage
      league="nfl"
      search={search}
      onSearch={(next) => navigate({ search: next, resetScroll: false })}
    />
  );
}
