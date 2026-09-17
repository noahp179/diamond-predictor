import { createFileRoute } from "@tanstack/react-router";

import { TdParlayView } from "@/components/TdParlayView";

export const Route = createFileRoute("/nfl/parlays")({
  head: () => ({ meta: [{ title: "NFL TD Parlays — Diamond Edge" }] }),
  component: () => <TdParlayView sport="nfl" />,
});
