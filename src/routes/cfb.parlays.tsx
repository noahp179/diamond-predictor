import { createFileRoute } from "@tanstack/react-router";

import { TdParlayView } from "@/components/TdParlayView";

export const Route = createFileRoute("/cfb/parlays")({
  head: () => ({ meta: [{ title: "College Football TD Parlays — Diamond Edge" }] }),
  component: () => <TdParlayView sport="cfb" />,
});
