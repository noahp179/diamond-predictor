import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SimulatePage } from "@/components/sim/SimulatePage";
import { simHead, simSearch } from "@/components/sim/simulate-route";

/** The NHL game simulator — see SimulatePage. */
export const Route = createFileRoute("/nhl/simulate")({
  validateSearch: simSearch,
  head: () => simHead("nhl"),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SimulatePage
      league="nhl"
      search={search}
      onSearch={(next) => navigate({ search: next, resetScroll: false })}
    />
  );
}
