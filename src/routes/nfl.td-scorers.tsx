import { createFileRoute } from "@tanstack/react-router";

import { TdScorersView } from "@/components/TdScorersView";

export const Route = createFileRoute("/nfl/td-scorers")({
  head: () => ({ meta: [{ title: "NFL TD Scorers — Diamond Edge" }] }),
  component: () => <TdScorersView />,
});
