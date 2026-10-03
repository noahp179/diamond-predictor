import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SimulatePage } from "@/components/sim/SimulatePage";
import { simHead, simSearch } from "@/components/sim/simulate-route";

/** The college football game simulator — see SimulatePage. */
export const Route = createFileRoute("/cfb/simulate")({
  validateSearch: simSearch,
  head: () => simHead("cfb"),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SimulatePage
      league="cfb"
      search={search}
      onSearch={(next) => navigate({ search: next, resetScroll: false })}
    />
  );
}
