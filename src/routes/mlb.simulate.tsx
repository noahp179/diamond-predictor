import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SimulatePage } from "@/components/sim/SimulatePage";
import { simHead, simSearch } from "@/components/sim/simulate-route";

/** The MLB game simulator — see SimulatePage. */
export const Route = createFileRoute("/mlb/simulate")({
  validateSearch: simSearch,
  head: () => simHead("mlb"),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SimulatePage
      league="mlb"
      search={search}
      onSearch={(next) => navigate({ search: next, resetScroll: false })}
    />
  );
}
